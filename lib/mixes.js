'use strict';
// MIX contributions (C-011 ③④), checked the same way by the community checks, the merge tool, the
// website and the web editor. Pure: no file system.
// - A proposal for the built-in library, mix/proposals/<id>.mix.json: one chant heard across the
//   idol scene, with at least two public pages that show it. After review and merge,
//   tools/accept-mix-proposals.js moves it into spec/mix-library.json (spec/README.md §13) and
//   deletes the proposal.
// - An artist MIX, mix/artists/<artist>/<id>.mix.json: a chant of one artist, optionally only for
//   some of their songs, credited and licensed like a cheer file. The web editor offers and
//   suggests it only while a song by that artist is being edited, and inserts it with its own
//   text, readings and name, so a player that has never seen this file still shows it.
// Problems are `{ field, message }`: `field` names the part of the file (for the editor's form),
// `message` is a plain Chinese sentence for contributors, with their text quoted safely.
const cheer = require('./cheer');
const paths = require('./paths');

const PROPOSAL_FORMAT = 'cheerbook-mix-proposal';
const ARTIST_FORMAT = 'cheerbook-artist-mix';
const VERSION = 1;
const MIX_DIR = 'mix';
const PROPOSALS_DIR = 'mix/proposals';
const ARTISTS_DIR = 'mix/artists';
const SUFFIX = '.mix.json';
const MAX_BYTES = 64 * 1024;
// spec/README.md §13: `tradition:<id>` must stay a valid mixRef once a proposal is accepted.
const ID = /^[a-z0-9][a-z0-9._-]{0,53}$/;
const POSITIONS = ['intro', 'afterMix', 'interlude', 'chorusLead', 'outro', 'verse'];
// An inserted artist MIX carries its name as the event's `name`, which is at most 32 characters
// (spec/README.md §3.4); library names follow the same limit so the two read alike.
const NAME_LIMIT = 32;
const ROMAJI_LIMIT = 400;
const NOTE_LIMIT = 200;
const TITLE_LIMIT = 200;
const AUTHOR_NAME_LIMIT = 64;
const SOURCE_TITLE_LIMIT = 120;
const URL_LIMIT = 2000;
const SONG_LIMIT = 50;
const SOURCE_LIMIT = 10;
const BAR_LIMIT = 64;
// spec/README.md §9: the permissions a shared file may carry.
const SHAREABLE = ['original', 'open-license', 'consented'];

const ENTRY_KEYS = ['id', 'name', 'kind', 'text', 'romaji', 'bars', 'positions', 'note', 'readings', 'readingNote'];
const PROPOSAL_KEYS = ['format', 'version', ...ENTRY_KEYS, 'sources', 'retrieved'];
const ARTIST_KEYS = ['format', 'version', 'artist', 'songs', ...ENTRY_KEYS, 'credits'];
const CREDIT_KEYS = ['authors', 'sources', 'permission', 'license', 'note'];
const AUTHOR_KEYS = ['name', 'url'];
const SOURCE_KEYS = ['kind', 'title', 'url', 'retrieved'];
const READING_KEYS = ['kana', 'romaji'];
// The order of an entry's fields in spec/mix-library.json.
const LIBRARY_ENTRY_KEYS = ['id', 'name', 'kind', 'text', 'romaji', 'bars', 'positions', 'sources', 'note', 'readings', 'readingNote', 'retrieved'];

const POSITION_TITLES = { intro: '前奏', afterMix: '接在 MIX 后', interlude: '间奏', chorusLead: '副歌前', outro: '尾奏', verse: '有人唱时' };

const isString = value => typeof value === 'string';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** One line of 1–`limit` characters that is not only white space. */
const line = (value, limit) => isString(value) && !cheer.isBlank(value) && !cheer.hasNewline(value) && cheer.length(value) <= limit;
// Browsers quietly drop tabs and some controls from a URL that Liveglow's reader (Foundation's
// URL) refuses, and one refused source drops the whole built-in library there, so links may hold no
// white space or control characters at all.
const UNSAFE_IN_URL = /[\s\x00-\x1F\x7F-\x9F]/u;
const webURL = value => isString(value) && cheer.length(value) <= URL_LIMIT && !UNSAFE_IN_URL.test(value) && cheer.isWebURL(value);
const { quote } = paths;

/** A URL compared the way browsers resolve it (case of the host, default port, empty path). */
function normalizedURL(url) {
  try { return new URL(url).href; } catch { return url; }
}

/** Where a proposal with this id goes, relative to the repository root. */
const proposalPath = id => `${PROPOSALS_DIR}/${id}${SUFFIX}`;
/** Where an artist MIX goes: the artist's folder name as for cheer files (CONTRIBUTING.md §3). */
const artistMixPath = (artist, id) => `${ARTISTS_DIR}/${paths.folderName(artist)}/${id}${SUFFIX}`;

// The field is where the key sits, never the key itself: a key is the contributor's text.
function unknownKeys(object, allowed, where, fail) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(where, `不认识的字段 ${quote(where ? where + '.' + key : key)}；这里只能有 ${allowed.join('、')}。`);
  }
}

/**
 * Reads a .mix.json file (a Uint8Array): `{ value }`, or `{ problems }` when it is too large,
 * starts with a byte order mark, is not UTF-8 or JSON, or repeats a key (JSON.parse would keep
 * the last one, so a reviewer could read a different value from the one used).
 */
function readFile(bytes) {
  const refuse = message => ({ problems: [{ field: '', message }] });
  if (bytes.length > MAX_BYTES) return refuse(`文件超过 ${MAX_BYTES / 1024} KB。`);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return refuse('文件开头不能有 BOM（以 UTF-8 无 BOM 保存）。');
  let text, value;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return refuse('不是有效的 UTF-8 JSON 文件。');
  }
  const scanned = cheer.scanText(text);
  if (scanned.notJSON) return refuse('不是有效的 JSON（含不成对的代理项或超出范围的数字）。');
  if (scanned.duplicate) return refuse(`字段 ${quote(scanned.duplicate.path)} 写了两次。`);
  return { value };
}

/** The words of a chant (spec/README.md §5.2), or [] for a text that is not one. */
function chantWords(text) {
  return isString(text) && cheer.parseSlots(text) !== null ? cheer.words(text) : [];
}

// The fields a library entry, a proposal and an artist MIX share. `strict` is the library's rule
// (spec/README.md §13): whole-sentence romaji and both kinds of readings are required. An artist
// MIX may be in any language, so it may leave them out; when it has readings, they must fit.
function chantProblems(item, strict) {
  const out = [];
  const fail = (field, message) => out.push({ field, message });
  if (!isString(item.id) || !ID.test(item.id)) fail('id', '编号须为 1–54 个小写英文字母、数字或 . _ -，以字母或数字开头。');
  else if (paths.RESERVED.test(item.id)) fail('id', '编号会成为文件名，不能是 con、nul、com1 这类 Windows 保留名。');
  if (!line(item.name, NAME_LIMIT)) fail('name', `名称须为 1–${NAME_LIMIT} 个字，不换行。`);
  const kindOK = item.kind === 'mix' || item.kind === 'call';
  if (!kindOK) fail('kind', '种类须为 mix 或 call。');
  const limit = cheer.TEXT_LIMIT[kindOK ? item.kind : 'mix'];
  const textOK = line(item.text, limit) && cheer.parseSlots(item.text) !== null;
  if (!textOK) fail('text', `口号须为 1–${limit} 个字、不换行；成员名字的空位写 {name}，花括号本身写 {{ 与 }}。`);
  if ((strict || item.romaji !== undefined) && !line(item.romaji, ROMAJI_LIMIT)) fail('romaji', `整句罗马音须为 1–${ROMAJI_LIMIT} 个字，不换行。`);
  const bars = item.bars;
  if (!Array.isArray(bars) || bars.length !== 2 || !bars.every(Number.isInteger) || bars[0] < 1 || bars[0] > bars[1] || bars[1] > BAR_LIMIT) {
    fail('bars', `小节数须为 [最少, 最多] 两个整数，1 ≤ 最少 ≤ 最多 ≤ ${BAR_LIMIT}。`);
  }
  if (!Array.isArray(item.positions) || !item.positions.every(position => POSITIONS.includes(position)) || new Set(item.positions).size !== item.positions.length) {
    fail('positions', `常见位置只能从 ${POSITIONS.map(position => `${position}（${POSITION_TITLES[position]}）`).join('、')} 中选，不重复；不参与推荐时写空数组。`);
  }
  if (item.note !== undefined && !line(item.note, NOTE_LIMIT)) fail('note', `说明须为 1–${NOTE_LIMIT} 个字，不换行；没有说明时不写这个字段。`);
  if (item.readingNote !== undefined && !line(item.readingNote, NOTE_LIMIT)) fail('readingNote', `读音说明须为 1–${NOTE_LIMIT} 个字，不换行；没有时不写这个字段。`);
  const readings = item.readings;
  if (readings === undefined) {
    if (strict) fail('readings', '须逐词写出平假名（kana）与罗马音（romaji）。');
  } else {
    const lists = isObject(readings) && Object.keys(readings).every(key => READING_KEYS.includes(key)) &&
      (!strict || (readings.kana !== undefined && readings.romaji !== undefined)) &&
      [readings.kana, readings.romaji].every(list => list === undefined || (Array.isArray(list) && list.every(word => isString(word) && !cheer.isBlank(word))));
    if (!lists || !textOK || !kindOK || !cheer.readingsFit(readings, { kind: item.kind, text: item.text })) {
      const count = textOK ? `（${chantWords(item.text).length}）` : '';
      fail('readings', `读音须逐词写出${strict ? '平假名（kana）与罗马音（romaji）两种' : '平假名（kana）、罗马音（romaji）或两种'}，个数与口号的词数${count}相同，每个 1–120 字、不换行。`);
    }
  }
  return out;
}

/**
 * Problems of a proposal for the built-in library. `options.file` is its path in the repository
 * (checked when given); `options.library` the parsed spec/mix-library.json (ids and chants already
 * there are refused); `options.today` a YYYY-MM-DD the reading date may not be after.
 */
function proposalProblems(value, { file, library, today } = {}) {
  if (!isObject(value)) return [{ field: '', message: '文件须是一个 JSON 对象。' }];
  const out = [];
  const fail = (field, message) => out.push({ field, message });
  if (value.format !== PROPOSAL_FORMAT || value.version !== VERSION) fail('format', `format 须为 ${quote(PROPOSAL_FORMAT)}，version 须为 1。`);
  unknownKeys(value, PROPOSAL_KEYS, '', fail);
  out.push(...chantProblems(value, true));
  if (file !== undefined && isString(value.id) && ID.test(value.id) && file !== proposalPath(value.id)) {
    fail('id', `提议须放在 ${quote(proposalPath(value.id))}：文件夹 ${PROPOSALS_DIR}/，文件名与编号相同。`);
  }
  const entries = library && Array.isArray(library.entries) ? library.entries.filter(isObject) : [];
  if (isString(value.id) && entries.some(entry => entry.id === value.id)) fail('id', `内置库里已有编号 ${quote(value.id)}，请换一个。`);
  const same = isString(value.text) ? entries.find(entry => entry.text === value.text) : undefined;
  if (same) fail('text', `与内置库中的 ${quote(same.name)} 口号相同，不必再提议。`);
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > SOURCE_LIMIT || !sources.every(webURL)) {
    fail('sources', `核对来源须为 2–${SOURCE_LIMIT} 个 http(s) 网页链接（不含空格），每个都能看到这条口号。`);
  } else if (new Set(sources.map(normalizedURL)).size !== sources.length) {
    fail('sources', '核对来源里有重复的链接。');
  }
  if (!isString(value.retrieved) || !cheer.isDay(value.retrieved) || (isString(today) && value.retrieved > today)) {
    fail('retrieved', '读取日期须为真实日期 YYYY-MM-DD（看这些页面的日期），不晚于今天。');
  }
  return out;
}

function creditProblems(credits) {
  const out = [];
  const fail = (field, message) => out.push({ field, message });
  if (!isObject(credits)) return [{ field: 'credits', message: '缺少署名（credits）。' }];
  unknownKeys(credits, CREDIT_KEYS, 'credits', fail);
  const authors = credits.authors;
  if (!Array.isArray(authors) || authors.length < 1 || authors.length > paths.AUTHOR_LIMIT) {
    fail('credits.authors', `须有 1–${paths.AUTHOR_LIMIT} 位作者。`);
  } else {
    authors.forEach((author, i) => {
      if (!isObject(author)) return fail('credits.authors', `第 ${i + 1} 位作者须是对象。`);
      unknownKeys(author, AUTHOR_KEYS, `credits.authors[${i}]`, fail);
      if (!line(author.name, AUTHOR_NAME_LIMIT)) fail('credits.authors', `第 ${i + 1} 位作者的名字须为 1–${AUTHOR_NAME_LIMIT} 个字，不换行。`);
      if (author.url !== undefined && !webURL(author.url)) fail('credits.authors', `第 ${i + 1} 位作者的链接须是 http(s) 链接。`);
    });
  }
  const sources = credits.sources;
  if (sources !== undefined) {
    if (!Array.isArray(sources) || sources.length > SOURCE_LIMIT) fail('credits.sources', `来源最多 ${SOURCE_LIMIT} 项。`);
    else {
      sources.forEach((source, i) => {
        if (!isObject(source)) return fail('credits.sources', `第 ${i + 1} 个来源须是对象。`);
        unknownKeys(source, SOURCE_KEYS, `credits.sources[${i}]`, fail);
        if (!cheer.SOURCE_KINDS.includes(source.kind)) fail('credits.sources', `第 ${i + 1} 个来源的 kind 须为 ${cheer.SOURCE_KINDS.join('、')} 之一。`);
        if (source.title !== undefined && !line(source.title, SOURCE_TITLE_LIMIT)) fail('credits.sources', `第 ${i + 1} 个来源的标题须为 1–${SOURCE_TITLE_LIMIT} 个字，不换行。`);
        if (source.url !== undefined && !webURL(source.url)) fail('credits.sources', `第 ${i + 1} 个来源的链接须是 http(s) 链接。`);
        if (source.retrieved !== undefined && !(isString(source.retrieved) && cheer.isDay(source.retrieved))) fail('credits.sources', `第 ${i + 1} 个来源的日期须为真实日期 YYYY-MM-DD。`);
      });
    }
  }
  if (!SHAREABLE.includes(credits.permission)) {
    fail('credits.permission', '只收自己创作（original）、有开放许可（open-license）或原作者同意转载（consented）的 MIX；只是公开可见的口号不收。');
  } else if (credits.permission === 'original' && Array.isArray(sources) && sources.some(source => isObject(source) && source.kind !== 'self')) {
    fail('credits.permission', '自己创作（original）的 MIX 来源只能写 self；用了别人的材料请选开放许可或原作者同意。');
  }
  if (credits.license !== undefined && !paths.LICENSES.includes(credits.license)) {
    fail('credits.license', `许可须为 ${paths.LICENSES.join('、')} 之一；自己创作的不写时按 ${paths.DEFAULT_LICENSE}。`);
  } else if (credits.permission === 'open-license' && credits.license === undefined) {
    fail('credits.license', '开放许可（open-license）须写明许可（license）。');
  }
  if (credits.note !== undefined && !line(credits.note, NOTE_LIMIT)) fail('credits.note', `说明须为 1–${NOTE_LIMIT} 个字，不换行。`);
  return out;
}

/**
 * Problems of an artist MIX. `options.file` is its path in the repository (checked when given);
 * `options.library` the parsed built-in library (a chant already there is not taken again).
 */
function artistMixProblems(value, { file, library } = {}) {
  if (!isObject(value)) return [{ field: '', message: '文件须是一个 JSON 对象。' }];
  const out = [];
  const fail = (field, message) => out.push({ field, message });
  if (value.format !== ARTIST_FORMAT || value.version !== VERSION) fail('format', `format 须为 ${quote(ARTIST_FORMAT)}，version 须为 1。`);
  unknownKeys(value, ARTIST_KEYS, '', fail);
  const artistOK = line(value.artist, TITLE_LIMIT);
  if (!artistOK) fail('artist', `艺人须为 1–${TITLE_LIMIT} 个字，不换行。`);
  if (value.songs !== undefined) {
    const songs = value.songs;
    if (!Array.isArray(songs) || songs.length < 1 || songs.length > SONG_LIMIT || !songs.every(song => line(song, TITLE_LIMIT))) {
      fail('songs', `指定歌曲须为 1–${SONG_LIMIT} 个歌名，每个 1–${TITLE_LIMIT} 个字；适用于这位艺人的所有歌时不写这个字段。`);
    } else if (new Set(songs.map(cheer.normalizedName)).size !== songs.length) {
      fail('songs', '指定歌曲里有重复的歌名。');
    }
  }
  out.push(...chantProblems(value, false));
  out.push(...creditProblems(value.credits));
  if (file !== undefined && artistOK && isString(value.id) && ID.test(value.id)) {
    const expected = artistMixPath(value.artist, value.id);
    // A folder that differs only in case is the same folder on macOS and Windows.
    if (paths.nameKey(file) !== paths.nameKey(expected)) fail('id', `按文件里的艺人与编号，应放在 ${quote(expected)}。`);
  }
  const entries = library && Array.isArray(library.entries) ? library.entries.filter(isObject) : [];
  const same = isString(value.text) ? entries.find(entry => entry.text === value.text) : undefined;
  if (same) fail('text', `这是内置库里的 ${quote(same.name)}，编辑器已经提供，不必另投。`);
  return out;
}

/** The licence an artist MIX is published under, or null when it carries the terms its author agreed to. */
function licenseOf(credits) {
  if (credits.license !== undefined) return credits.license;
  return credits.permission === 'original' ? paths.DEFAULT_LICENSE : null;
}

// MARK: Writing files

const ORDERS = {
  proposal: PROPOSAL_KEYS, artist: ARTIST_KEYS, entry: LIBRARY_ENTRY_KEYS, credits: CREDIT_KEYS,
  author: AUTHOR_KEYS, source: SOURCE_KEYS, readings: READING_KEYS,
};

function ordered(object, keys) {
  const out = {};
  for (const key of keys) if (object[key] !== undefined) out[key] = object[key];
  for (const key of Object.keys(object)) if (!keys.includes(key) && object[key] !== undefined) out[key] = object[key];
  return out;
}

/**
 * JSON in the style of spec/mix-library.json: objects one key a line, two spaces deep; arrays of
 * plain values on one line (`"bars": [4, 6]`), arrays holding objects one item a line.
 */
function stringify(value, indent = '') {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(item => item === null || typeof item !== 'object')) return '[' + value.map(item => JSON.stringify(item)).join(', ') + ']';
    const inner = indent + '  ';
    return '[\n' + value.map(item => inner + stringify(item, inner)).join(',\n') + '\n' + indent + ']';
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const inner = indent + '  ';
    return '{\n' + keys.map(key => inner + JSON.stringify(key) + ': ' + stringify(value[key], inner)).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(value);
}

function orderedReadings(readings) {
  return isObject(readings) ? ordered(readings, ORDERS.readings) : readings;
}

/** A proposal's file text: fields in the documented order, then a line break. */
function serializeProposal(value) {
  return stringify(ordered({ ...value, readings: orderedReadings(value.readings) }, ORDERS.proposal)) + '\n';
}

/** An artist MIX's file text: fields in the documented order, then a line break. */
function serializeArtistMix(value) {
  const credits = isObject(value.credits) ? ordered({
    ...value.credits,
    authors: Array.isArray(value.credits.authors) ? value.credits.authors.map(author => (isObject(author) ? ordered(author, ORDERS.author) : author)) : value.credits.authors,
    sources: Array.isArray(value.credits.sources) ? value.credits.sources.map(source => (isObject(source) ? ordered(source, ORDERS.source) : source)) : value.credits.sources,
  }, ORDERS.credits) : value.credits;
  return stringify(ordered({ ...value, readings: orderedReadings(value.readings), credits }, ORDERS.artist)) + '\n';
}

/** spec/mix-library.json's text for a library object, in the file's own style. */
function serializeLibrary(library) {
  return stringify(library) + '\n';
}

// MARK: The built-in library

// Source codes are capital letters, then pairs of them, in order: A … Z, AA, AB, …
function* sourceCodes() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  yield* letters;
  for (const first of letters) for (const second of letters) yield first + second;
}

function sourceCode(sources, url) {
  const key = normalizedURL(url);
  for (const [code, existing] of Object.entries(sources)) if (normalizedURL(existing) === key) return code;
  for (const code of sourceCodes()) {
    if (!Object.hasOwn(sources, code)) { sources[code] = url; return code; }
  }
  throw new Error('来源代码已用完。');
}

/**
 * The library with these proposals added at the end, in order (a new object; `library` is left
 * alone). A page the library already cites keeps its code; a new page gets the first free one.
 * Each entry keeps its proposal's reading date as `retrieved`. The proposals must already pass
 * `proposalProblems` against this library, one after another.
 */
function acceptProposals(library, proposals) {
  const next = JSON.parse(JSON.stringify(library));
  for (const proposal of proposals) {
    const entry = {};
    for (const key of ENTRY_KEYS) if (proposal[key] !== undefined) entry[key] = JSON.parse(JSON.stringify(proposal[key]));
    entry.readings = orderedReadings(entry.readings);
    // Stored as the browser resolves it (punycode host, escaped path), which Liveglow's reader takes.
    entry.sources = proposal.sources.map(url => sourceCode(next.sources, normalizedURL(url)));
    entry.retrieved = proposal.retrieved;
    next.entries.push(ordered(entry, ORDERS.entry));
  }
  return next;
}

// MARK: Artist MIX in the editor

// Separators between the artists one song credits, so a MIX of one of them is offered for the
// song. The whole credit is compared too, so names that contain a separator still match.
const ARTIST_SEPARATORS = /\s*(?:[,，、&＆×/／;；]|\s(?:feat\.?|ft\.?|featuring)\s)\s*/iu;

function artistKeys(text) {
  if (!isString(text)) return new Set();
  return new Set([text, ...text.split(ARTIST_SEPARATORS)].map(cheer.normalizedName).filter(Boolean));
}

/**
 * How an artist MIX applies to a song (`{ title, artist }`): 'song' when it names this song,
 * 'artist' when it is for all the artist's songs, null otherwise (another artist, or a MIX that
 * names only other songs).
 */
function appliesTo(mix, song) {
  if (!isObject(mix) || !isObject(song) || !isString(mix.artist)) return null;
  if (!artistKeys(song.artist).has(cheer.normalizedName(mix.artist))) return null;
  if (!Array.isArray(mix.songs)) return 'artist';
  const title = isString(song.title) ? cheer.normalizedName(song.title) : '';
  return title && mix.songs.some(name => isString(name) && cheer.normalizedName(name) === title) ? 'song' : null;
}

/**
 * The artist MIX that apply to `song`, from the website's /mix/artists.json list (each item a
 * file's content plus its `path`), song-specific ones first, then by name. Each is shaped like a
 * library entry (`id`, `name`, `kind`, `text`, `romaji`, `bars`, `positions`, `readings`, `note`)
 * with `scope: 'artist'`, its `path`, `artist`, `songs`, `match` and `authors`; files that break a
 * rule are left out.
 */
function artistEntries(list, song) {
  if (!Array.isArray(list)) return [];
  const found = [];
  for (const item of list) {
    if (!isObject(item) || !isString(item.path)) continue;
    const { path, ...file } = item;
    const match = appliesTo(file, song);
    if (!match || artistMixProblems(file, { file: path }).length) continue;
    found.push({
      scope: 'artist', path, match, artist: file.artist, songs: file.songs, id: file.id, name: file.name, kind: file.kind, text: file.text,
      romaji: file.romaji, bars: file.bars, positions: file.positions, readings: file.readings, note: file.note,
      authors: file.credits.authors.map(author => author.name),
    });
  }
  const rank = entry => (entry.match === 'song' ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.path < b.path ? -1 : 1));
}

// MARK: The editor's form

/** A suggested id from romaji: lower-case letters and digits joined by "-", long marks and name slots dropped. */
function suggestedID(romaji) {
  if (!isString(romaji)) return '';
  const words = romaji.replace(/\{[^{}]*\}/g, ' ').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) || [];
  let id = '';
  for (const word of words) {
    const next = id ? id + '-' + word : word;
    if (next.length > 54) break;
    id = next;
  }
  return id;
}

/** An empty proposal for the form. */
function newProposal() {
  return { format: PROPOSAL_FORMAT, version: VERSION, id: '', name: '', kind: 'mix', text: '', romaji: '', bars: [4, 4], positions: [], readings: { kana: [], romaji: [] }, sources: ['', ''], retrieved: '' };
}

/** An empty artist MIX for the form, for `artist` (may be ''). */
function newArtistMix(artist = '') {
  return { format: ARTIST_FORMAT, version: VERSION, artist, id: '', name: '', kind: 'mix', text: '', bars: [4, 4], positions: [], credits: { authors: [{ name: '' }], permission: 'original' } };
}

module.exports = {
  PROPOSAL_FORMAT, ARTIST_FORMAT, VERSION, PROPOSAL_KEYS, ARTIST_KEYS, CREDIT_KEYS, AUTHOR_KEYS, SOURCE_KEYS, READING_KEYS, MIX_DIR, PROPOSALS_DIR, ARTISTS_DIR, SUFFIX, MAX_BYTES, ID, POSITIONS, POSITION_TITLES,
  NAME_LIMIT, ROMAJI_LIMIT, NOTE_LIMIT, TITLE_LIMIT, SONG_LIMIT, SOURCE_LIMIT, SHAREABLE,
  normalizedURL, proposalPath, artistMixPath, readFile, chantWords, chantProblems, proposalProblems, artistMixProblems, licenseOf,
  stringify, serializeProposal, serializeArtistMix, serializeLibrary, acceptProposals, appliesTo, artistEntries, suggestedID,
  newProposal, newArtistMix,
};
