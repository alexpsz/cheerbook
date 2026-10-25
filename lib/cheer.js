'use strict';
// Reader for the cheer file format `.cheer.json` (liveglow-cheer, version 1), following
// spec/README.md §6 step by step. Liveglow's Swift reader (CheerChart.parse) runs the same
// samples (spec/samples/expected.json); the two must agree on every sample, and where they
// disagree the format description and the samples decide (spec/README.md, opening section).
// No dependencies, so the community checks and a future web editor can both load it.

const FORMAT = 'liveglow-cheer';
const VERSION = 1;
const MAX_BYTES = 512 * 1024;
const MAX_MEMBERS = 64;
const MAX_EVENTS = 2000;
const MAX_DEPTH = 8;
const MAX_WORDS = 64;
const MIN_EVENT_LENGTH = 0.05;
const NAME_LIMIT = 32;
const READING_LIMIT = 120;
const KINDS = ['mix', 'call', 'part', 'note'];
const TEXT_LIMIT = { mix: 120, call: 60, note: 60, part: 0 };
const PERMISSIONS = ['original', 'open-license', 'consented', 'public-only', 'official', 'unknown'];
const SOURCE_KINDS = ['self', 'call-sheet', 'video', 'official', 'other'];
const LYRIC_KEYS = new Set(['lyrics', 'lyric', 'lrc', 'yrc', 'krc', 'qrc', 'tlyric', 'lines', 'words']);
const WARNINGS = new Set(['unknownKind', 'readings', 'derivedMarkedOriginal']);

// §2: the one white-space set every trim uses (Unicode White_Space plus U+200B and U+FEFF), and
// the line breaks. JavaScript's trim() and \s differ from both, so they are not used.
const BLANK = new Set([0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0x200B, 0xFEFF]);
for (let c = 0x2000; c <= 0x200A; c++) BLANK.add(c);
const NEWLINES = new Set([0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029]);

/** Code points, as every length limit counts them (§14 rule 1). */
function length(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function trimmed(text) {
  const points = [...text];
  let start = 0, end = points.length;
  while (start < end && BLANK.has(points[start].codePointAt(0))) start++;
  while (end > start && BLANK.has(points[end - 1].codePointAt(0))) end--;
  return points.slice(start, end).join('');
}

const isBlank = text => trimmed(text) === '';
const hasNewline = text => [...text].some(c => NEWLINES.has(c.codePointAt(0)));
const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** §3.2: hyphens and white space removed, ASCII letters uppercased; anything else stays. */
function normalizedISRC(text) {
  let out = '';
  for (const c of text) {
    const code = c.codePointAt(0);
    if (c === '-' || BLANK.has(code)) continue;
    out += code >= 0x61 && code <= 0x7A ? String.fromCodePoint(code - 32) : c;
  }
  return out;
}

/** §3.5 and §14 rule 4: http:// or https:// in any case, and the WHATWG parser accepts it. */
function isWebURL(text) {
  const head = [...text].slice(0, 8).map(c => (c >= 'A' && c <= 'Z' ? c.toLowerCase() : c)).join('');
  if (!head.startsWith('http://') && !head.startsWith('https://')) return false;
  try { new URL(text); return true; } catch { return false; }
}

/**
 * A day that exists on the calendar, written YYYY-MM-DD. Like the Swift reader's Gregorian
 * calendar, days before 15 October 1582 follow the Julian calendar and 5–14 October 1582 do not
 * exist; no real retrieval date is affected.
 */
function isDay(text) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const julian = year < 1582 || (year === 1582 && (month < 10 || (month === 10 && day < 15)));
  if (year === 1582 && month === 10 && day >= 5 && day <= 14) return false;
  const leap = julian ? year % 4 === 0 : (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** §5.1: the text as literal and name tokens, or null when a brace is not one of the forms. */
function parseSlots(text) {
  const points = [...text];
  const tokens = [];
  let literal = '';
  for (let i = 0; i < points.length;) {
    const c = points[i], next = points[i + 1];
    if (c === '{' && next === '{') { literal += '{'; i += 2; continue; }
    if (c === '}' && next === '}') { literal += '}'; i += 2; continue; }
    if (c === '}') return null;
    if (c !== '{') { literal += c; i++; continue; }
    const close = points.indexOf('}', i + 1);
    if (close < 0) return null;
    const body = points.slice(i + 1, close).join('');
    let token;
    if (body === 'name') token = { name: null };
    else if (body.startsWith('name:') && body.length > 5 && !body.includes('{')) token = { name: body.slice(5) };
    else return null;
    if (literal) { tokens.push({ literal }); literal = ''; }
    tokens.push(token);
    i = close + 1;
  }
  if (literal) tokens.push({ literal });
  return tokens;
}

/** §5.2: a chant split after each "！" or "!", closing brackets kept with the word before. */
function words(text) {
  const out = [];
  let current = '';
  const closing = c => c === '）' || c === ')';
  for (const c of text) {
    current += c;
    if (c !== '！' && c !== '!') continue;
    const word = [...trimmed(current)];
    // Leading brackets move in one slice, so a long run of them stays linear.
    let lead = 0;
    if (out.length) while (lead < word.length && closing(word[lead])) lead++;
    if (lead) out[out.length - 1] += word.slice(0, lead).join('');
    if (lead < word.length) out.push(word.slice(lead).join(''));
    current = '';
  }
  const rest = trimmed(current);
  if (rest) {
    if (out.length && [...rest].every(closing)) out[out.length - 1] += rest;
    else out.push(rest);
  }
  return out;
}

/** §5.4: readings fit when every list given has one short, single-line entry per word. */
function readingsFit(readings, event) {
  if ((event.kind !== 'mix' && event.kind !== 'call') || event.echo === true || event.text === undefined) return false;
  const count = words(event.text).length;
  if (count === 0 || (readings.kana === undefined && readings.romaji === undefined)) return false;
  return [readings.kana, readings.romaji].filter(list => list !== undefined)
    .every(list => list.length === count && list.every(entry => length(entry) <= READING_LIMIT && !hasNewline(entry)));
}

function issue(code, path, detail) {
  return detail === undefined ? { code, path } : { code, path, detail };
}

// §6 steps 2–3 on the text, which is known to be valid JSON here, in one pass without recursion:
// - JSON.parse accepts what the Swift reader's parser refuses as not JSON: a string holding an
//   unpaired surrogate escape (`"\uD800"`), and a number too large for a double (`1e400`).
// - JSON.parse silently keeps the last of two equal keys, so duplicates are found here. Keys
//   compare after escapes are resolved; the first duplicate in the file is reported with the
//   path of the object it is in plus the key.
function scanText(text) {
  const stack = [];
  let duplicate = null;
  const child = () => {
    const top = stack[stack.length - 1];
    if (!top) return '';
    return top.object ? (top.path ? top.path + '.' + top.key : top.key) : `${top.path}[${top.index}]`;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') stack.push({ object: c === '{', path: child(), keys: new Set(), key: '', awaitingKey: true, index: 0 });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top.object) top.awaitingKey = true; else top.index++;
    } else if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const literal = text.slice(i, end + 1);
      // Only escaped strings can hold a surrogate: raw text was decoded strictly as UTF-8.
      const value = literal.includes('\\') ? JSON.parse(literal) : literal.slice(1, -1);
      if (!value.isWellFormed()) return { notJSON: true };
      const top = stack[stack.length - 1];
      if (!duplicate && top && top.object && top.awaitingKey) {
        top.awaitingKey = false;
        top.key = value;
        if (top.keys.has(value)) duplicate = { key: value, path: child() };
        else top.keys.add(value);
      }
      i = end;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      let end = i + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end])) end++;
      if (!Number.isFinite(Number(text.slice(i, end)))) return { notJSON: true };
      i = end - 1;
    }
  }
  return { notJSON: false, duplicate };
}

// §6 step 6: lyric keys at any depth, and nesting deeper than 8 (the top object is depth 0).
// A value found below depth 8 stops that branch, as in the Swift reader.
function scanStructure(value, path, depth, issues) {
  if (depth > MAX_DEPTH) {
    if (!issues.some(found => found.code === 'tooDeep')) issues.push(issue('tooDeep', ''));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) {
      const child = path ? path + '.' + key : key;
      if (LYRIC_KEYS.has(key.toLowerCase())) issues.push(issue('lyricField', child, key));
      scanStructure(value[key], child, depth + 1, issues);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanStructure(item, `${path}[${i}]`, depth + 1, issues));
  }
}

// §6 step 7: structure and types, in the order the Swift reader decodes them, so both report
// the same first problem. A missing required field, a null one, a wrong type or a value outside
// an enumeration is `malformed` at the path of that value. Optional fields may be null (§3).
class Malformed extends Error {
  constructor(path) { super('malformed at ' + path); this.path = path; }
}
const join = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : path ? path + '.' + key : key);
const fail = path => { throw new Malformed(path); };
const string = (value, path) => (typeof value === 'string' ? value : fail(path));
const number = (value, path) => (typeof value === 'number' ? value : fail(path));
const boolean = (value, path) => (typeof value === 'boolean' ? value : fail(path));
const oneOf = values => (value, path) => (typeof value === 'string' && values.includes(value) ? value : fail(path));
const list = decode => (value, path) => (Array.isArray(value) ? value.map((item, i) => decode(item, join(path, i))) : fail(path));
function object(fields) {
  return (value, path) => {
    if (!isPlainObject(value)) fail(path);
    const out = {};
    for (const [key, decode, required] of fields) {
      const present = Object.hasOwn(value, key) && value[key] !== null;
      if (!present) { if (required) fail(join(path, key)); continue; }
      out[key] = decode(value[key], join(path, key));
    }
    return out;
  };
}
const req = (key, decode) => [key, decode, true];
const opt = (key, decode) => [key, decode, false];

const decodeChart = object([
  req('song', object([req('title', string), req('artist', string), req('duration', number), opt('album', string), opt('isrc', string), opt('appleMusicID', string)])),
  opt('offset', number),
  opt('members', list(object([req('id', string), req('name', string), req('color', string)]))),
  req('events', list(object([
    req('start', number), req('end', number), req('kind', string), opt('text', string), opt('members', list(string)), opt('echo', boolean),
    opt('mixRef', string), opt('steps', list(number)), opt('readings', object([opt('kana', list(string)), opt('romaji', list(string))])),
    opt('tapped', boolean), opt('name', string),
  ]))),
  req('credits', object([
    req('authors', list(object([req('name', string), opt('url', string)]))),
    opt('sources', list(object([req('kind', oneOf(SOURCE_KINDS)), opt('title', string), opt('url', string), opt('retrieved', string)]))),
    req('permission', oneOf(PERMISSIONS)), opt('license', string), opt('note', string),
  ])),
  opt('generator', string),
]);

/** §3–§5: every rule of the format on a decoded chart whose events are all of known kinds. */
function validate(chart, { sharing }) {
  const issues = [];
  const check = (ok, code, path, detail) => { if (!ok) issues.push(issue(code, path, detail)); };
  const { song, credits } = chart;

  check(!isBlank(song.title) && length(song.title) <= 200, 'songTitle', 'song.title');
  check(!isBlank(song.artist) && length(song.artist) <= 200, 'songArtist', 'song.artist');
  check(song.duration > 0 && song.duration <= 7200, 'songDuration', 'song.duration');
  if (song.isrc !== undefined) check(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(song.isrc), 'isrc', 'song.isrc');
  if (song.appleMusicID !== undefined) check(/^[0-9]{1,20}$/.test(song.appleMusicID), 'appleMusicID', 'song.appleMusicID');
  check(Math.abs(chart.offset) <= 10, 'offset', 'offset');
  if (chart.generator !== undefined) check(length(chart.generator) <= 64, 'generator', 'generator');

  check(chart.members.length <= MAX_MEMBERS, 'tooManyMembers', 'members');
  const ids = new Set();
  chart.members.forEach((member, i) => {
    const path = `members[${i}]`;
    check(/^[A-Za-z0-9_-]{1,32}$/.test(member.id), 'memberID', path + '.id');
    check(!ids.has(member.id), 'duplicateMember', path + '.id');
    ids.add(member.id);
    check(!isBlank(member.name) && length(member.name) <= 32, 'memberName', path + '.name');
    check(/^#[0-9A-Fa-f]{6}$/.test(member.color), 'memberColor', path + '.color');
  });

  check(chart.events.length <= MAX_EVENTS, 'tooManyEvents', 'events');
  const songEnd = song.duration + 5;
  chart.events.forEach((event, i) => {
    const path = `events[${i}]`;
    const members = event.members || [];
    const { kind, text } = event;
    check(event.start >= 0 && event.end - event.start >= MIN_EVENT_LENGTH - 1e-9, 'eventTime', path);
    check(!(event.end > songEnd), 'eventPastSongEnd', path + '.end');
    for (const id of members) if (!ids.has(id)) issues.push(issue('unknownMember', path + '.members', id));
    if (kind === 'part') check(members.length > 0, 'partWithoutMember', path + '.members');
    if (event.echo === true) {
      check(kind === 'call' && text === undefined, 'echo', path + '.echo');
    } else if (kind === 'part') {
      check(text === undefined, 'textForbidden', path + '.text');
    } else if (text !== undefined) {
      check(!isBlank(text), 'textRequired', path + '.text');
      check(length(text) <= TEXT_LIMIT[kind], 'textTooLong', path + '.text', TEXT_LIMIT[kind]);
      const tokens = parseSlots(text);
      if (tokens === null) issues.push(issue('slot', path + '.text'));
      else for (const token of tokens) {
        if (token.name === null) check(members.length > 0, 'slotWithoutMember', path + '.text');
        else if (token.name !== undefined) check(ids.has(token.name), 'unknownMember', path + '.text', token.name);
      }
    } else {
      issues.push(issue('textRequired', path + '.text'));
    }
    if (event.mixRef !== undefined) check(kind === 'mix' && /^[a-z0-9][a-z0-9:._-]{0,63}$/.test(event.mixRef), 'mixRef', path + '.mixRef');
    if (event.steps !== undefined) {
      const steps = event.steps;
      const count = words(text === undefined ? '' : text).length;
      const ordered = steps.every((step, j) => j === 0 || steps[j - 1] < step);
      check((kind === 'mix' || kind === 'call') && steps.length === count && count > 0 && count <= MAX_WORDS && ordered &&
        steps.every(step => step >= 0 && step < event.end - event.start), 'steps', path + '.steps');
    }
    if (event.readings !== undefined && !readingsFit(event.readings, event)) issues.push(issue('readings', path + '.readings'));
    if (event.name !== undefined) {
      check((kind === 'mix' || kind === 'call') && !isBlank(event.name) && length(event.name) <= NAME_LIMIT && !hasNewline(event.name),
        'eventName', path + '.name');
    }
  });

  if (sharing) check(credits.authors.length > 0, 'authorMissing', 'credits.authors');
  credits.authors.forEach((author, i) => {
    check(!isBlank(author.name) && length(author.name) <= 64, 'authorName', `credits.authors[${i}].name`);
    if (author.url !== undefined) check(isWebURL(author.url), 'url', `credits.authors[${i}].url`);
  });
  credits.sources.forEach((source, i) => {
    const path = `credits.sources[${i}]`;
    if (source.title !== undefined) check(length(source.title) <= 120, 'sourceTitle', path + '.title');
    if (source.url !== undefined) check(isWebURL(source.url), 'url', path + '.url');
    if (source.retrieved !== undefined) check(isDay(source.retrieved), 'retrievedDate', path + '.retrieved');
  });
  if (credits.permission === 'open-license') check(!isBlank(credits.license || ''), 'licenseRequired', 'credits.license');
  if (credits.note !== undefined) check(length(credits.note) <= 200, 'note', 'credits.note');
  if (credits.permission === 'original' && derivedFromOthers(credits)) issues.push(issue('derivedMarkedOriginal', 'credits.permission'));
  return issues;
}

/** Material from a call sheet, a video or an official guide is someone else's work. */
const derivedFromOthers = credits => credits.sources.some(source => source.kind !== 'self');

/** §9: who may receive the file. */
function sharingOf(credits) {
  switch (credits.permission) {
    case 'open-license': case 'consented': return 'shareable';
    case 'original': return derivedFromOthers(credits) ? 'localOnly' : 'shareable';
    default: return 'localOnly';
  }
}

/**
 * Reads a file's bytes as §6 describes. `sharedFile` (default true) reads it as a file someone
 * shared, which must name an author. Returns `{ valid: false, errors }` or
 * `{ valid: true, warnings, sharing, chart }`, where `chart` has known events only, sorted, with
 * readings that do not fit dropped and the ISRC normalized.
 */
function parse(bytes, { sharedFile = true } = {}) {
  const reject = errors => ({ valid: false, errors });
  // Step 1: size, then the byte order mark.
  if (bytes.length > MAX_BYTES) return reject([issue('tooLarge', '')]);
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xEF && body[1] === 0xBB && body[2] === 0xBF) body = body.subarray(3);
  // Step 2: a JSON object.
  let text, root;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    root = JSON.parse(text);
  } catch {
    return reject([issue('notJSON', '')]);
  }
  if (!isPlainObject(root)) return reject([issue('notJSON', '')]);
  // Step 3: duplicate keys (and the last two kinds of text that are not JSON for every reader).
  const scanned = scanText(text);
  if (scanned.notJSON) return reject([issue('notJSON', '')]);
  if (scanned.duplicate) return reject([issue('duplicateKey', scanned.duplicate.path, scanned.duplicate.key)]);
  // Steps 4–5: format and version first, so a newer file says "update" rather than "malformed".
  if (root.format !== FORMAT) return reject([issue('wrongFormat', 'format')]);
  if (typeof root.version !== 'number' || !Number.isInteger(root.version)) return reject([issue('malformed', 'version')]);
  if (root.version !== VERSION) return reject([issue('unsupportedVersion', 'version', root.version)]);
  // Step 6: lyric keys and depth over the whole file.
  const structural = [];
  scanStructure(root, '', 0, structural);
  if (structural.length) return reject(structural);
  // Step 7: structure and types.
  let raw;
  try {
    raw = decodeChart(root, '');
  } catch (error) {
    if (error instanceof Malformed) return reject([issue('malformed', error.path)]);
    throw error;
  }
  // Step 8: unknown kinds are skipped with a warning but keep their place in the numbering.
  const warnings = [];
  const events = [], positions = [];
  raw.events.forEach((event, index) => {
    if (!KINDS.includes(event.kind)) { warnings.push(issue('unknownKind', `events[${index}].kind`, event.kind)); return; }
    positions.push(index);
    const copy = { ...event };
    if (copy.tapped !== true) delete copy.tapped;
    events.push(copy);
  });
  const song = { ...raw.song };
  if (song.isrc !== undefined) song.isrc = normalizedISRC(song.isrc);
  const credits = { ...raw.credits, sources: raw.credits.sources || [] };
  const chart = { song, offset: raw.offset ?? 0, members: raw.members || [], events, credits };
  if (raw.generator !== undefined) chart.generator = raw.generator;
  // Step 9: every other rule; issues name events by their place in the file (§14 rule 6).
  const issues = validate(chart, { sharing: sharedFile }).map(found => {
    const match = /^events\[(\d+)\](.*)$/.exec(found.path);
    return match && Number(match[1]) < positions.length ? { ...found, path: `events[${positions[Number(match[1])]}]${match[2]}` } : found;
  });
  if (raw.events.length > MAX_EVENTS && !issues.some(found => found.code === 'tooManyEvents')) issues.push(issue('tooManyEvents', 'events'));
  const errors = issues.filter(found => !WARNINGS.has(found.code));
  if (errors.length) return reject(errors);
  // Step 10: readings that do not fit are dropped; events sorted by start, end, then file order.
  for (const event of events) if (event.readings !== undefined && !readingsFit(event.readings, event)) delete event.readings;
  chart.events = events.map((event, i) => ({ event, i }))
    .sort((a, b) => a.event.start - b.event.start || a.event.end - b.event.end || a.i - b.i)
    .map(entry => entry.event);
  return { valid: true, warnings: warnings.concat(issues), sharing: sharingOf(credits), chart };
}

// §8: the names compared for a metadata match — markup tags removed; case, diacritics and width
// ignored; only letters, marks and numbers kept. This follows Foundation's folding, which the
// Swift reader uses, rather than Unicode compatibility forms: width folds only the fullwidth and
// halfwidth forms block (ｶﾞ → ガ, Ａ → a), diacritics are the Latin-style combining marks (the kana
// voicing marks stay, so ガ is not カ), and case folds fully (ß → ss). Circled digits and other
// compatibility characters stay as they are.
const WIDTH_FORMS = /[\uFF01-\uFF5E\uFF61-\uFFDC\uFFE0-\uFFEE]/gu;
const DIACRITICS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/gu;
function normalizedName(text) {
  return text.replace(/<[^>]*>/g, '')
    .replace(WIDTH_FORMS, c => c.normalize('NFKC'))
    .normalize('NFD').replace(DIACRITICS, '').normalize('NFC')
    .toUpperCase().toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/** §8: how surely a file's song is the playing recording: 'isrc', 'catalog', 'metadata' or null. */
function matchSong(file, playing) {
  const mine = file.isrc ? normalizedISRC(file.isrc) : '';
  const theirs = playing.isrc ? normalizedISRC(playing.isrc) : '';
  if (mine && theirs) return mine === theirs ? 'isrc' : null;
  if (file.appleMusicID && file.appleMusicID === playing.appleMusicID) return 'catalog';
  const title = normalizedName(file.title), artist = normalizedName(file.artist);
  const ok = title !== '' && artist !== '' && title === normalizedName(playing.title) && artist === normalizedName(playing.artist) &&
    file.duration > 0 && playing.duration > 0 && Math.abs(file.duration - playing.duration) <= Math.max(3, playing.duration * 0.015);
  return ok ? 'metadata' : null;
}

module.exports = {
  FORMAT, VERSION, MAX_BYTES, KINDS, TEXT_LIMIT, PERMISSIONS, SOURCE_KINDS,
  parse, scanText, matchSong, normalizedName, normalizedISRC, words, parseSlots, readingsFit, trimmed, length, isBlank, hasNewline, isWebURL, isDay,
};
