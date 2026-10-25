'use strict';
// Lyrics for the web cheer editor: reading LRC and plain lyrics, the content-layer lyric check of
// spec/README.md §10 point 2, and helpers for LRCLIB (https://lrclib.net), the public lyrics
// database. Lyrics only time and show cheers; nothing here writes them into a cheer file.
// No dependencies and no I/O: the browser fetches, this module builds addresses and reads replies.
//
// Shared model (also used by lib/editor.js and lib/suggest.js):
//   { lines: [{ start, end?, text, words?: [{ start, end?, text }] }], meta: { ti?, ar?, al?, by?, length? } }
// Times are seconds, rounded to milliseconds; lines are sorted by start; `end` is left out when
// the lyrics do not say when a line or word stops.

const cheer = require('./cheer');

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] and [mm:ss:xx]; minutes may have any number of digits.
const LINE_STAMP = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/;
// Enhanced LRC word timing inside a line: <mm:ss.xx> (same forms as the line stamps).
const WORD_STAMP = /<[ \t]*(\d+):(\d{1,2})(?:[.:](\d{1,3}))?[ \t]*>/g;
const TAG = /^([A-Za-z#][A-Za-z0-9_#-]*)[ \t]*:([\s\S]*)$/;
const TEXT_META = ['ti', 'ar', 'al', 'by'];

const ms = seconds => Math.round(seconds * 1000) / 1000;
const clock = (minutes, seconds, fraction) =>
  Number(minutes) * 60 + Number(seconds) + (fraction === undefined ? 0 : Number(fraction) / 10 ** fraction.length);
const stripBOM = text => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
const splitLines = text => stripBOM(text).split(/\r\n|\r|\n/);

/** Leading (or trailing) white space of the §2 set removed from one end only. */
function trimEdge(text, end) {
  const points = [...text];
  if (end) {
    while (points.length && cheer.isBlank(points[points.length - 1])) points.pop();
  } else {
    let i = 0;
    while (i < points.length && cheer.isBlank(points[i])) i++;
    points.splice(0, i);
  }
  return points.join('');
}

/**
 * The text after a line's time stamps, with enhanced word stamps read out. A segment before the
 * first word stamp starts with the line; a stamp followed by nothing (or only spaces) ends the word
 * before it. Word texts keep their spacing, so joining them gives the line text exactly.
 */
function readWords(rest, lineStart) {
  const stamps = [], parts = [];
  let last = 0, found;
  WORD_STAMP.lastIndex = 0;
  while ((found = WORD_STAMP.exec(rest))) {
    parts.push(rest.slice(last, found.index));
    stamps.push(clock(found[1], found[2], found[3]));
    last = found.index + found[0].length;
  }
  if (!stamps.length) return { text: cheer.trimmed(rest), words: null };
  parts.push(rest.slice(last));
  const words = [];
  const add = (start, segment) => {
    const previous = words[words.length - 1];
    if (previous && previous.end === undefined) previous.end = start;
    if (cheer.isBlank(segment)) { if (previous) previous.text += segment; return; }
    words.push({ start, text: segment });
  };
  if (!cheer.isBlank(parts[0])) words.push({ start: lineStart, text: parts[0] });
  stamps.forEach((start, i) => add(start, parts[i + 1]));
  if (!words.length) return { text: '', words: null };
  words[0].text = trimEdge(words[0].text, false);
  words[words.length - 1].text = trimEdge(words[words.length - 1].text, true);
  return { text: words.map(word => word.text).join(''), words };
}

/**
 * Reads LRC lyrics.
 *
 * Input: the file's text (a leading BOM and CRLF / CR line ends are fine).
 * Output: `{ lines, meta, warnings }`.
 * - `lines`: `[{ start, end?, text, words? }]` sorted by start (file order for equal starts). A line
 *   with several stamps (`[00:12.00][00:45.00]text`) appears once per stamp. A blank timed line is
 *   not a line: it ends the line before it. With enhanced word timing (`<mm:ss.xx>`), each word
 *   ends where the next word starts, at a trailing stamp, or else where the next line starts, and
 *   the line ends with its last word; without word timing `end` is known only from a blank line.
 * - `meta`: `ti`, `ar`, `al`, `by` (strings) and `length` (seconds) when the file has them.
 *   `[offset:±ms]` is applied to every time with the standard LRC sign (positive shows lyrics
 *   earlier: time = stamp − offset); times that would fall before 0 become 0.
 * - `warnings`: `[{ line, code, detail? }]` with 1-based line numbers. Codes: `unknownTag` (detail:
 *   the tag name, lower case), `badTime` (a stamp that does not parse), `badOffset`, `badLength`,
 *   `untimedLine` (text without a stamp). Warnings never repeat lyric text.
 * Failure: throws TypeError only when `text` is not a string; anything else in the text is
 * skipped. A file with no timed lines gives `lines: []` (the UI can fall back to parsePlain).
 */
function parseLRC(text) {
  if (typeof text !== 'string') throw new TypeError('parseLRC expects a string');
  const meta = {}, warnings = [], entries = [];
  let offset = 0;
  const readTag = (key, value, line) => {
    if (TEXT_META.includes(key)) {
      if (value !== '') meta[key] = value;
    } else if (key === 'length') {
      const stamp = LINE_STAMP.exec(value);
      if (/^\d+(?:\.\d+)?$/.test(value)) meta.length = Number(value);
      else if (stamp) meta.length = clock(stamp[1], stamp[2], stamp[3]);
      else if (value !== '') warnings.push({ line, code: 'badLength' });
    } else if (key === 'offset') {
      if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) offset = Number(value);
      else warnings.push({ line, code: 'badOffset' });
    } else {
      warnings.push({ line, code: 'unknownTag', detail: key });
    }
  };

  splitLines(text).forEach((raw, index) => {
    const line = index + 1;
    let rest = cheer.trimmed(raw);
    const stamps = [];
    let warned = false;
    while (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close < 0) break;
      const body = cheer.trimmed(rest.slice(1, close));
      const stamp = LINE_STAMP.exec(body);
      if (stamp) {
        stamps.push(clock(stamp[1], stamp[2], stamp[3]));
      } else if (stamps.length) {
        break;   // Text that happens to start with a bracket.
      } else {
        const tag = TAG.exec(body);
        if (!tag) {
          if (/^\d+\s*:/.test(body)) { warnings.push({ line, code: 'badTime' }); warned = true; }
          break;
        }
        readTag(tag[1].toLowerCase(), cheer.trimmed(tag[2]), line);
      }
      rest = cheer.trimmed(rest.slice(close + 1));
    }
    if (!stamps.length) {
      if (rest !== '' && !warned) warnings.push({ line, code: 'untimedLine' });
      return;
    }
    const { text: lineText, words } = readWords(rest, stamps[0]);
    for (const start of stamps) {
      const shift = start - stamps[0];
      entries.push({
        start, text: lineText, order: entries.length,
        words: words && words.map(word => ({ start: word.start + shift, end: word.end === undefined ? undefined : word.end + shift, text: word.text })),
      });
    }
  });

  const move = time => (time === undefined ? undefined : Math.max(0, time - offset / 1000));
  for (const entry of entries) {
    entry.start = move(entry.start);
    if (entry.words) for (const word of entry.words) { word.start = move(word.start); word.end = move(word.end); }
  }
  entries.sort((a, b) => a.start - b.start || a.order - b.order);

  const lines = [];
  entries.forEach((entry, i) => {
    if (entry.text === '') return;
    let next = i + 1;
    while (next < entries.length && entries[next].start <= entry.start) next++;
    const nextStart = next < entries.length ? entries[next].start : undefined;
    let end;
    if (entry.words) {
      const last = entry.words[entry.words.length - 1];
      if (last.end === undefined) last.end = nextStart;
      end = last.end;
    } else if (nextStart !== undefined) {
      for (let j = next; j < entries.length && entries[j].start === nextStart; j++) if (entries[j].text === '') end = nextStart;
    }
    const out = { start: ms(entry.start) };
    if (end !== undefined && end > entry.start) out.end = ms(end);
    out.text = entry.text;
    if (entry.words) {
      out.words = entry.words.map(word => {
        const timed = { start: ms(word.start) };
        if (word.end !== undefined && word.end > word.start) timed.end = ms(word.end);
        timed.text = word.text;
        return timed;
      });
    }
    lines.push(out);
  });
  if (meta.length !== undefined) meta.length = ms(meta.length);
  return { lines, meta, warnings };
}

/**
 * Reads unsynced (plain) lyrics for display only.
 *
 * Input: text (BOM and CRLF fine). Output: `{ lines: [{ text }], meta: {}, warnings: [] }`, the
 * same shape as parseLRC but without times: each line trimmed (§2 white space), runs of blank
 * lines kept as one `{ text: '' }` stanza break, and blank lines at the start and end dropped.
 * Failure: throws TypeError only when `text` is not a string.
 */
function parsePlain(text) {
  if (typeof text !== 'string') throw new TypeError('parsePlain expects a string');
  const lines = [];
  for (const raw of splitLines(text)) {
    const line = cheer.trimmed(raw);
    if (line === '' && (!lines.length || lines[lines.length - 1].text === '')) continue;
    lines.push({ text: line });
  }
  if (lines.length && lines[lines.length - 1].text === '') lines.pop();
  return { lines, meta: {}, warnings: [] };
}

// §10 point 2, ported from Liveglow's CheerLyricsGuard (CheerTimeline.swift): texts are
// normalized as in §8, name slots removed, and two texts overlap when they share a run of
// characters weighing 8 or more (a character at U+2E80 or above weighs 2, any other 1).
const OVERLAP_WEIGHT = 8;

/** From every position, the shortest run reaching the weight; sharing a run means sharing one of these. */
function windows(text) {
  const points = [...text];
  const out = [];
  for (let start = 0; start < points.length; start++) {
    let weight = 0, end = start;
    while (end < points.length && weight < OVERLAP_WEIGHT) { weight += points[end].codePointAt(0) >= 0x2E80 ? 2 : 1; end++; }
    if (weight < OVERLAP_WEIGHT) break;
    out.push(points.slice(start, end).join(''));
  }
  return out;
}

/** Only the literal words of a chant (CheerSlots.literalText): slots dropped, pieces joined by a space. */
function literalText(text) {
  const tokens = cheer.parseSlots(text);
  return tokens ? tokens.filter(token => token.literal !== undefined).map(token => token.literal).join(' ') : text;
}

const lineText = line => (typeof line === 'string' ? line : line && typeof line.text === 'string' ? line.text : '');
const strings = list => (Array.isArray(list) ? list.filter(item => typeof item === 'string') : []);

/**
 * The content-layer lyric check of spec/README.md §10 point 2, as Liveglow runs it on import and
 * before sharing (CheerLyricsGuard.overlaps / cannotCheck in CheerTimeline.swift).
 *
 * Input: `chart` with `events` (each with optional `text` and `readings: { kana?, romaji? }`) and
 * `credits.note`, as lib/cheer.js `parse` returns it or the editor holds it; `lyricTexts`, the
 * loaded lyric lines as strings or `{ text }` objects (parseLRC / parsePlain lines work).
 * Output, both warnings that do not affect the file's validity:
 * - `[{ code: 'lyricsUnchecked', path: '' }]` when no lyric line is long enough to compare (none
 *   loaded, or all shorter than the weight 8) and the chart has text (an event text or the note);
 * - otherwise `[{ code: 'lyricOverlap', path }]` for each text that shares a run with the lyrics:
 *   `events[i].text`, `events[i].readings` (kana and romaji compared together) and `credits.note`,
 *   in that order, `i` being the index in `chart.events`; `[]` when nothing overlaps.
 * Failure: never throws for missing or ill-typed fields; they count as absent.
 */
function lyricIssues(chart, lyricTexts) {
  const events = chart && Array.isArray(chart.events) ? chart.events : [];
  const note = chart && chart.credits && typeof chart.credits.note === 'string' ? chart.credits.note : undefined;
  const known = new Set();
  for (const line of Array.isArray(lyricTexts) ? lyricTexts : []) for (const run of windows(cheer.normalizedName(lineText(line)))) known.add(run);
  if (!known.size) {
    const hasText = events.some(event => event && typeof event.text === 'string' && event.text !== '') || (note !== undefined && note !== '');
    return hasText ? [{ code: 'lyricsUnchecked', path: '' }] : [];
  }
  const overlaps = text => windows(cheer.normalizedName(text)).some(run => known.has(run));
  const issues = [];
  events.forEach((event, i) => {
    if (!event || typeof event.text !== 'string') return;
    if (overlaps(literalText(event.text))) issues.push({ code: 'lyricOverlap', path: `events[${i}].text` });
    const readings = event.readings || {};
    const spoken = strings(readings.kana).concat(strings(readings.romaji)).map(literalText).join(' ');
    if (spoken !== '' && overlaps(spoken)) issues.push({ code: 'lyricOverlap', path: `events[${i}].readings` });
  });
  if (note !== undefined && overlaps(note)) issues.push({ code: 'lyricOverlap', path: 'credits.note' });
  return issues;
}

// LRCLIB (https://lrclib.net/docs). The browser sends the request; these helpers only build the
// address and read the JSON reply. Fields relied on, in a track record from /api/get or in each
// element of the /api/search array:
//   trackName, artistName, albumName  strings
//   duration                          number, seconds
//   instrumental                      boolean (true: no lyrics, the track is instrumental)
//   plainLyrics                       string or null, unsynced text
//   syncedLyrics                      string or null, LRC text (line stamps; parse with parseLRC)
// /api/get answers 404 (JSON `{ code: 404, name: "TrackNotFound", … }`) when it knows no such
// track; then search. Only the title, artist, album and duration are sent, never anything personal.
const LRCLIB = 'https://lrclib.net/api';

function address(path, params) {
  const query = params.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${LRCLIB}/${path}?${query}`;
}
const filled = value => (typeof value === 'string' && !cheer.isBlank(value) ? cheer.trimmed(value) : undefined);

/**
 * Address for LRCLIB's exact lookup, `GET https://lrclib.net/api/get`.
 *
 * Input: `{ title, artist, album?, duration }` (duration in seconds, sent rounded to whole seconds;
 * LRCLIB matches it within about two seconds). `album` is sent only when given: Liveglow leaves it
 * out because catalogs name albums differently and a mismatch hides the right track.
 * Output: the URL string, or null when the title or artist is blank or the duration is not a
 * number of at least one second (the lookup cannot work; use search instead).
 */
function lrclibGetURL({ title, artist, album, duration } = {}) {
  const track = filled(title), singer = filled(artist);
  const seconds = typeof duration === 'number' && Number.isFinite(duration) ? Math.round(duration) : 0;
  if (!track || !singer || seconds < 1) return null;
  return address('get', [['track_name', track], ['artist_name', singer], ['album_name', filled(album)], ['duration', String(seconds)]]);
}

/**
 * Address for LRCLIB's search, `GET https://lrclib.net/api/search` (replies with an array of track
 * records, best matches first by LRCLIB's own ranking).
 *
 * Input: `{ title, artist? }`; leave the artist out for a broader search when the catalog may
 * spell it differently. Output: the URL string, or null when the title is blank.
 */
function lrclibSearchURL({ title, artist } = {}) {
  const track = filled(title);
  if (!track) return null;
  return address('search', [['track_name', track], ['artist_name', filled(artist)]]);
}

/**
 * The search result that is this song, by the metadata rule of spec/README.md §8: normalized
 * title and artist equal and non-empty (lib/cheer.js `normalizedName`), both durations above 0
 * and within max(3 s, 1.5 % of the song's duration).
 *
 * Input: `results`, the parsed /api/search reply (an array; anything else counts as empty);
 * `{ title, artist, duration }` of the song being edited.
 * Output: the chosen record (the same object), or null when none matches. Among matches, a record
 * with synced lyrics beats one with plain lyrics only, which beats one with neither (an
 * instrumental mark); then the smaller duration difference; then LRCLIB's order.
 */
function pickLRCLIB(results, { title, artist, duration } = {}) {
  if (!Array.isArray(results)) return null;
  const wantTitle = typeof title === 'string' ? cheer.normalizedName(title) : '';
  const wantArtist = typeof artist === 'string' ? cheer.normalizedName(artist) : '';
  if (!wantTitle || !wantArtist || !(typeof duration === 'number' && duration > 0 && Number.isFinite(duration))) return null;
  const tolerance = Math.max(3, duration * 0.015);
  let best = null, bestRank = -1, bestGap = Infinity;
  for (const record of results) {
    if (!record || typeof record !== 'object' || typeof record.trackName !== 'string' || typeof record.artistName !== 'string') continue;
    if (cheer.normalizedName(record.trackName) !== wantTitle || cheer.normalizedName(record.artistName) !== wantArtist) continue;
    if (!(typeof record.duration === 'number' && record.duration > 0)) continue;
    const gap = Math.abs(record.duration - duration);
    if (!(gap <= tolerance)) continue;
    const { synced, plain } = fromLRCLIB(record);
    const rank = synced ? 2 : plain ? 1 : 0;
    if (rank > bestRank || (rank === bestRank && gap < bestGap)) { best = record; bestRank = rank; bestGap = gap; }
  }
  return best;
}

/**
 * The parts of one LRCLIB track record the editor uses.
 *
 * Input: a record from /api/get or /api/search. Output: `{ synced, plain, instrumental, duration,
 * title, artist, album }`: `synced` (LRC text for parseLRC) and `plain` (for parsePlain) are
 * strings or null (blank counts as null); `instrumental` is true only when LRCLIB says so;
 * `duration` is seconds or null; `title`, `artist`, `album` are LRCLIB's names or null.
 * Failure: never throws; anything that is not a record gives all nulls and `instrumental: false`.
 */
function fromLRCLIB(record) {
  const valid = record && typeof record === 'object' && !Array.isArray(record);
  const text = key => (valid && typeof record[key] === 'string' && !cheer.isBlank(record[key]) ? record[key] : null);
  return {
    synced: text('syncedLyrics'),
    plain: text('plainLyrics'),
    instrumental: Boolean(valid && record.instrumental === true),
    duration: valid && typeof record.duration === 'number' && Number.isFinite(record.duration) && record.duration > 0 ? record.duration : null,
    title: text('trackName'),
    artist: text('artistName'),
    album: text('albumName'),
  };
}

module.exports = { parseLRC, parsePlain, lyricIssues, lrclibGetURL, lrclibSearchURL, pickLRCLIB, fromLRCLIB };
