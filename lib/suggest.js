'use strict';
// Smart MIX suggestions and the chart edits that place MIX, ported from Liveglow (映场):
// CheerSuggest.swift (grids, lyric gaps, suggestions, insert / fit / accept / shift),
// CheerSteps.swift (word steps), the grid half of CheerWordTaps.swift and the way
// CheerMixLibrary.swift turns a library entry into an event. Liveglow's tests are ported in
// tests/suggest.test.js with the same synthetic data, so both behave alike.
//
// Times: lyric spans, gaps, grids and `position` arguments are playback times (seconds of the
// recording); chart times are playback times plus `chart.offset` (spec/README.md §8). Lyrics are
// the model lib/lyrics.js produces: `{ lines: [{ start, end?, text, words?: [{ start, end?, text }] }],
// offset? }`, lines sorted by start; a lyric time is a playback time plus `offset` (default 0).
// Charts are plain objects in the `.cheer.json` shape (what `cheer.parse(bytes).chart` returns);
// every function here leaves its arguments alone and returns new objects.
// No dependencies and no Node APIs, so the browser bundle can load it.

const cheer = require('./cheer');

/** Beats in a bar: grids are 4/4. */
const BEATS_PER_BAR = 4;
/** The shortest event the format allows, in seconds (spec/README.md §3.4). */
const MIN_EVENT_LENGTH = 0.05;
/** A gap shorter than this is left alone: two bars with a grid … */
const MINIMUM_BARS = 2;
/** … or six seconds without one. */
const MINIMUM_SECONDS = 6;
// A line's last word is held at most 2.5 × its own length at the line's singing speed (at
// least 0.8 s); slower than 0.6 s a character, word timing is taken as stretched (a guess).
const SUNG_TAIL_FLOOR = 0.8;
const SUNG_TAIL_FACTOR = 2.5;
const SLOWEST_CHARACTER = 0.6;
const MAX_STEP_BEATS = 512;

/** Runs of library MIX tried for each gap, in conventional order (ids of spec/mix-library.json). */
const RUNS = [
  ['oborozuki'], ['chaos'], ['gachikoi'], ['ainu-wisupe'], ['ainu'], ['spanish'], ['standard'], ['japanese'],
  ['standard', 'japanese'], ['standard', 'encho'], ['japanese', 'ainu'], ['standard', 'japanese', 'ainu'],
];
/** What each gap kind is called: intro, interlude, chorusLead (the run-up to a chorus), outro. */
const GAP_TITLES = { intro: '前奏', interlude: '间奏', chorusLead: '副歌前连接段', outro: '尾奏' };
/** How sure a suggestion is: high (beat map and word-timed lyrics), medium (other grids), gapOnly (no grid). */
const CONFIDENCE_TITLES = { high: '把握高', medium: '把握中', gapOnly: '只标空位' };
/** Where a library chant usually goes (`entries[].positions`), as the editor names it. */
const POSITION_TITLES = { intro: '前奏', afterMix: '接在 MIX 后', interlude: '间奏', chorusLead: '副歌前', outro: '尾奏', verse: '有人唱时' };

const finite = value => typeof value === 'number' && Number.isFinite(value);
/** Swift's `rounded()`: halves away from zero (Math.round rounds -2.5 to -2). */
const round = value => (value < 0 ? -Math.round(-value) : Math.round(value));
const sum = (values, pick = value => value) => values.reduce((total, value) => total + pick(value), 0);
const validIndex = (list, index) => Number.isInteger(index) && index >= 0 && index < list.length;
const offsetOf = chart => (finite(chart.offset) ? chart.offset : 0);
const barOf = grid => grid.beat * BEATS_PER_BAR;

/** Plain data copied deeply; keys holding `undefined` are dropped. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) if (value[key] !== undefined) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

/** The middle value (mean of the two middle ones for an even count), or null for none. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** "2:05": whole minutes and seconds of a time; negative or non-finite times read as 0:00. */
function clock(seconds) {
  const value = Math.max(0, finite(seconds) ? seconds : 0);
  const whole = Math.trunc(value);
  return `${Math.trunc(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// MARK: Beat grid

/**
 * A 4/4 grid: `beat` seconds per beat and one bar line at `anchor` (playback time). `source` is
 * 'beatMap' (local beat analysis) or 'taps' (the listener tapping along); it only changes how
 * sure suggestions are. Returns `{ beat, anchor, source, bar, bpm }`; `bar` and `bpm` are
 * derived, and the functions below read `beat` and `anchor` only.
 */
function makeGrid(beat, anchor, source) {
  return { beat, anchor, source, bar: beat * BEATS_PER_BAR, bpm: 60 / beat };
}

/** The first bar line at or after `time` (a microsecond early still counts as on it). */
function barLine(grid, time) {
  const bar = barOf(grid);
  return grid.anchor + Math.ceil((time - grid.anchor) / bar - 1e-6) * bar;
}

/** The first beat at or after `time`. */
function nextBeat(grid, time) {
  return grid.anchor + Math.ceil((time - grid.anchor) / grid.beat - 1e-6) * grid.beat;
}

/**
 * A grid from a local beat analysis: `{ beats: [{ time, combo? }], gridStep? }`, where
 * `gridStep` is seconds per beat and `combo: 'downbeat'` marks accented beats (the first one is
 * the bar line). Returns null with fewer than four usable beats or a beat outside 0.25–1.5 s.
 */
function gridFromBeatMap(map) {
  if (!map || typeof map !== 'object' || !Array.isArray(map.beats)) return null;
  const beats = map.beats
    .flatMap(beat => (beat && typeof beat === 'object' && finite(beat.time) && beat.time >= 0 ? [{ time: beat.time, downbeat: beat.combo === 'downbeat' }] : []))
    .sort((a, b) => a.time - b.time);
  if (beats.length < 4) return null;
  const gaps = beats.slice(1).map((beat, i) => beat.time - beats[i].time).filter(gap => gap > 0);
  const given = typeof map.gridStep === 'number' && map.gridStep >= 0.25 && map.gridStep <= 1.5 ? map.gridStep : null;
  const step = given ?? median(gaps);
  if (step === null || !(step >= 0.25 && step <= 1.5)) return null;
  return makeGrid(step, (beats.find(beat => beat.downbeat) || beats[0]).time, 'beatMap');
}

// Each time numbered on `step` from the first; a straight line through the numbered times gives
// the beat (its slope) and a bar line (its intercept). Null when too few fit or the tempo is
// outside 50–250 BPM.
function fitLine(times, step, minimum) {
  const first = times[0];
  const indexed = times.map(t => ({ k: round((t - first) / step), t })).filter(({ k, t }) => Math.abs(t - first - k * step) < step * 0.35);
  const n = indexed.length;
  if (n < minimum) return null;
  const meanK = sum(indexed, item => item.k) / n, meanT = sum(indexed, item => item.t) / n;
  const spread = sum(indexed, item => (item.k - meanK) * (item.k - meanK));
  if (!(spread > 0)) return null;
  const beat = sum(indexed, item => (item.k - meanK) * (item.t - meanT)) / spread;
  if (!(beat >= 60 / 250 && beat <= 60 / 50)) return null;
  return makeGrid(beat, meanT - beat * meanK, 'taps');
}

/**
 * A grid from taps along with the beat (playback times, any order). A double tap is dropped,
 * each tap is numbered by the median interval and a line fitted through them. Needs five taps
 * and 50–250 BPM; returns null otherwise.
 */
function gridFromTaps(times) {
  const sorted = (Array.isArray(times) ? times : []).filter(finite).sort((a, b) => a - b);
  if (sorted.length < 5) return null;
  const rough = median(sorted.slice(1).map((tap, i) => tap - sorted[i]));
  if (rough === null || !(rough > 0)) return null;
  const kept = [];
  for (const tap of sorted) if (!kept.length || tap - kept[kept.length - 1] >= rough * 0.5) kept.push(tap);
  if (kept.length < 5) return null;
  return fitLine(kept, rough, 5);
}

/**
 * A grid from word presses alone (word-by-word tapping without a song grid): the median gap is
 * one or two beats, halved or doubled into 70–190 BPM, then a line is fitted as for taps. Needs
 * three presses; returns null otherwise.
 */
function gridFromWordPresses(presses) {
  const times = (Array.isArray(presses) ? presses : []).filter(finite).sort((a, b) => a - b);
  if (times.length < 3) return null;
  let beat = median(times.slice(1).map((time, i) => time - times[i]).filter(gap => gap > 0.05));
  if (beat === null) return null;
  while (beat > 60 / 70) beat /= 2;
  while (beat < 60 / 190) beat *= 2;
  return fitLine(times, beat, 3);
}

// MARK: Words and steps

/**
 * Starts for `count` words across [start, end), as seconds after `start`. With a grid the words
 * land on beats spread over the beats available; with too few beats, or no grid, evenly.
 * Returns [] when `count` < 1 or `end` ≤ `start`.
 */
function autoSteps(count, start, end, grid) {
  if (!(count > 0) || !(end > start)) return [];
  if (grid) {
    const beats = [];
    for (let beat = nextBeat(grid, start); beat < end - 1e-6 && beats.length < MAX_STEP_BEATS; beat += grid.beat) beats.push(beat);
    if (beats.length >= count) {
      const offsets = Array.from({ length: count }, (_, i) => beats[Math.floor(i * beats.length / count)] - start);
      if (offsets.every((offset, i) => i === 0 || offsets[i - 1] < offset)) return offsets.map(offset => Math.max(0, offset));
    }
  }
  const share = (end - start) / count;
  return Array.from({ length: count }, (_, i) => i * share);
}

/** The steps an event is shown with: its own when they match its words, else spread evenly. */
function effectiveSteps(event) {
  const count = cheer.words(typeof event.text === 'string' ? event.text : '').length;
  if (Array.isArray(event.steps) && event.steps.length === count) return [...event.steps];
  return autoSteps(count, event.start, event.end, null);
}

/** The index of the word being shouted at `time` (same clock as `start`), or null before the first. */
function activeWord(steps, start, time) {
  for (let i = steps.length - 1; i >= 0; i--) if (start + steps[i] <= time + 1e-6) return i;
  return null;
}

// MARK: The MIX library

const ENTRY_CACHE = new WeakMap();
const LIBRARY_KINDS = new Set(['mix', 'call']);
const isString = value => typeof value === 'string';
const stringList = value => Array.isArray(value) && value.every(isString);

// spec/README.md §13: header rules refuse the whole library; an entry that breaks a rule is left
// out and the rest stay (as Liveglow's CheerMixLibrary.decode).
function readLibrary(library) {
  const sources = library.sources;
  const header = library.format === 'liveglow-cheer-mix-library' && library.version === 1 && library.license === 'CC0-1.0' &&
    isString(library.credit) && !cheer.isBlank(library.credit) && isString(library.retrieved) && cheer.isDay(library.retrieved) &&
    sources && typeof sources === 'object' && !Array.isArray(sources) && Object.keys(sources).length > 0 &&
    Object.values(sources).every(url => isString(url) && cheer.isWebURL(url)) && Array.isArray(library.entries);
  if (!header) return [];
  const ids = new Set();
  return library.entries.filter(entry => {
    if (!entry || typeof entry !== 'object' || ![entry.id, entry.name, entry.kind, entry.text, entry.romaji].every(isString) ||
      !Array.isArray(entry.bars) || !entry.bars.every(Number.isInteger) || !stringList(entry.positions) || !stringList(entry.sources) ||
      (entry.note !== undefined && entry.note !== null && !isString(entry.note)) ||
      (entry.readingNote !== undefined && entry.readingNote !== null && !isString(entry.readingNote))) return false;
    if (!/^[a-z0-9][a-z0-9._-]{0,53}$/.test(entry.id) || ids.has(entry.id)) return false;
    ids.add(entry.id);
    const readings = entry.readings;
    return LIBRARY_KINDS.has(entry.kind) && [entry.name, entry.text, entry.romaji].every(text => !cheer.isBlank(text)) &&
      cheer.length(entry.text) <= cheer.TEXT_LIMIT[entry.kind] && cheer.parseSlots(entry.text) !== null &&
      entry.bars.length === 2 && entry.bars[0] >= 1 && entry.bars[0] <= entry.bars[1] &&
      entry.positions.every(position => Object.hasOwn(POSITION_TITLES, position)) &&
      entry.sources.length >= 2 && new Set(entry.sources).size === entry.sources.length && entry.sources.every(code => Object.hasOwn(sources, code)) &&
      readings && typeof readings === 'object' && stringList(readings.kana) && stringList(readings.romaji) &&
      cheer.readingsFit(readings, { kind: entry.kind, text: entry.text });
  });
}

/**
 * The usable entries of a parsed MIX library (spec/mix-library.json), in file order. A library
 * that breaks a header rule, or is missing, gives []; entries breaking a rule are left out. The
 * result is remembered per library object, so do not change the object after first use.
 */
function libraryEntries(library) {
  if (!library || typeof library !== 'object') return [];
  if (!ENTRY_CACHE.has(library)) ENTRY_CACHE.set(library, readLibrary(library));
  return ENTRY_CACHE.get(library);
}

/** The library entry with this id, or null. */
function entryById(library, id) {
  return libraryEntries(library).find(entry => entry.id === id) || null;
}

/** The library entry a `mixRef` names (`tradition:<id>`), or null for any other reference. */
function mixEntry(library, mixRef) {
  if (!isString(mixRef) || !mixRef.startsWith('tradition:')) return null;
  return entryById(library, mixRef.slice('tradition:'.length));
}

/** Whether a text (or a library entry's text) has a name slot, `{name}` or `{name:id}`. */
function hasNameSlot(textOrEntry) {
  const text = isString(textOrEntry) ? textOrEntry : textOrEntry && textOrEntry.text;
  const tokens = isString(text) ? cheer.parseSlots(text) : null;
  return Boolean(tokens && tokens.some(token => Object.hasOwn(token, 'name')));
}

/**
 * A library entry as an event from `start` to `end` (chart times; the start is kept ≥ 0): its
 * kind, text and readings, `mixRef: "tradition:<id>"` for a MIX, and `members: [member]` when the
 * text has a name slot and a member id is given. No steps (callers add them).
 */
function mixEvent(entry, start, end, member) {
  const event = { start: Math.max(0, start), end, kind: entry.kind, text: entry.text };
  if (hasNameSlot(entry.text) && isString(member)) event.members = [member];
  if (entry.kind === 'mix') event.mixRef = 'tradition:' + entry.id;
  if (entry.readings && typeof entry.readings === 'object') {
    const readings = {};
    if (Array.isArray(entry.readings.kana)) readings.kana = [...entry.readings.kana];
    if (Array.isArray(entry.readings.romaji)) readings.romaji = [...entry.readings.romaji];
    event.readings = readings;
  }
  return event;
}

// MARK: Lyrics

const linesOf = lyrics => (lyrics && Array.isArray(lyrics.lines) ? lyrics.lines : []);
const lyricOffset = lyrics => (lyrics && finite(lyrics.offset) ? lyrics.offset : 0);
const isSung = line => isString(line.text) && !cheer.isBlank(line.text) && line.text !== '♪';
const characters = word => (isString(word.text) ? cheer.length(word.text) : 0);
const wordLength = word => (finite(word.end) && finite(word.start) ? word.end - word.start : NaN);
const sameWord = (a, b) => a.start === b.start && a.end === b.end && a.text === b.text;

// User trial (2026-10-18): word-timed sources can stretch a line into the interlude, the last
// word running on to the next line or every character spread evenly until then. The last word is
// held at most 2.5 × its own length at the line's median speed per character; a line slower than
// 0.6 s a character is stretched timing, only a guess (`trusted` false). A single word is line
// timing and keeps its length.
function sungEnd(words) {
  let last = null;
  for (const word of words) if (word && (last === null || word.start > last.start)) last = word;
  if (!last || !finite(last.start)) return null;
  const length = Math.max(0, finite(wordLength(last)) ? wordLength(last) : 0);
  const speeds = words.filter(word => word && !sameWord(word, last) && characters(word) > 0 && finite(wordLength(word)) && wordLength(word) > 0)
    .map(word => wordLength(word) / characters(word));
  const perCharacter = median(speeds);
  if (perCharacter === null) return { end: last.start + length, trusted: words.length === 1 };
  if (perCharacter > SLOWEST_CHARACTER) return { end: last.start + length, trusted: false };
  const held = Math.max(1, characters(last)) * perCharacter * SUNG_TAIL_FACTOR;
  return { end: last.start + Math.min(length, Math.max(SUNG_TAIL_FLOOR, held)), trusted: true };
}

const wordEnd = line => (Array.isArray(line.words) ? sungEnd(line.words) : null);

/**
 * Where each lyric line stops being sung, in playback time, one per line (sung or not). A line
 * ends at its last word when word timing is known; otherwise after its own length (`end`), else
 * 8 s (4.8 s for the last line); never past the next line and never before its start.
 */
function lineEnds(lyrics) {
  const lines = linesOf(lyrics), offset = lyricOffset(lyrics);
  return lines.map((line, index) => {
    const start = line.start - offset;
    const next = index + 1 < lines.length ? lines[index + 1].start - offset : null;
    const words = wordEnd(line);
    const given = finite(line.end) && line.end - line.start > 0 ? line.end - line.start : null;
    let end = words ? words.end - offset : start + (given ?? (next === null ? 4.8 : 8));
    if (next !== null) end = Math.min(end, next);
    return Math.max(start, end);
  });
}

function sungSpans(lyrics) {
  const lines = linesOf(lyrics), offset = lyricOffset(lyrics), ends = lineEnds(lyrics);
  return lines.flatMap((line, i) => (isSung(line) ? [{ start: line.start - offset, end: ends[i], text: line.text, line }] : []));
}

/**
 * The sung lyric lines in playback time, `[{ start, end, estimated }]` in line order; blank lines
 * and "♪" are skipped. `estimated` is true unless the end comes from trustworthy word timing —
 * only such an end may move a MIX start (`fitToLyricGap`).
 */
function spans(lyrics) {
  return sungSpans(lyrics).map(({ start, end, line }) => ({ start, end, estimated: wordEnd(line)?.trusted !== true }));
}

/**
 * The stretches nobody sings: intro, interludes, the run-up to a repeated (chorus) line, outro.
 * Returns `[{ kind, title, start, end, barStart?, bars? }]` in playback time. With a grid each
 * gap gets its first bar line and whole bars from there, and needs two bars; without one it
 * needs six seconds. No sung lines or no positive `duration` gives [].
 */
function gaps(lyrics, duration, grid) {
  const sung = sungSpans(lyrics);
  if (!sung.length || !(duration > 0)) return [];
  const keys = sung.map(span => cheer.normalizedName(span.text));
  const counts = new Map();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) || 0) + 1);
  const repeated = keys.map(key => (counts.get(key) || 0) >= 2);
  const raw = [['intro', 0, sung[0].start]];
  for (let i = 1; i < sung.length; i++) raw.push([repeated[i] && !repeated[i - 1] ? 'chorusLead' : 'interlude', sung[i - 1].end, sung[i].start]);
  raw.push(['outro', sung[sung.length - 1].end, duration]);
  return raw.flatMap(([kind, start, end]) => {
    if (!(end > start)) return [];
    if (!grid) return end - start >= MINIMUM_SECONDS ? [{ kind, title: GAP_TITLES[kind], start, end }] : [];
    const barStart = barLine(grid, start);
    const bars = Math.floor((end - barStart) / barOf(grid) + 1e-6);
    return bars >= MINIMUM_BARS ? [{ kind, title: GAP_TITLES[kind], start, end, barStart, bars }] : [];
  });
}

// MARK: Suggestions

/**
 * Library runs whose lower bar total fits `bars`, best first, at most five: those whose range
 * covers the gap, then those whose first MIX suits the gap's place, then fuller, then shorter
 * runs. Runs needing a member's name are left out when `hasMembers` is false.
 */
function candidates(bars, kind, hasMembers, library) {
  const entries = libraryEntries(library);
  const scored = RUNS.flatMap((ids, order) => {
    const run = ids.map(id => entries.find(entry => entry.id === id)).filter(Boolean);
    if (run.length !== ids.length || (!hasMembers && run.some(hasNameSlot))) return [];
    const low = sum(run, mix => mix.bars[0]), high = sum(run, mix => mix.bars[1]);
    if (low > bars) return [];
    return [{ run, order, covers: bars <= high, suits: run[0].positions.includes(kind), fill: Math.min(high, bars) / bars }];
  });
  scored.sort((a, b) => {
    if (a.covers !== b.covers) return a.covers ? -1 : 1;
    if (a.suits !== b.suits) return a.suits ? -1 : 1;
    if (a.fill !== b.fill) return b.fill - a.fill;
    if (a.run.length !== b.run.length) return a.run.length - b.run.length;
    return a.order - b.order;
  });
  return scored.slice(0, 5).map(item => item.run);
}

function summaryOf(gap) {
  const span = clock(gap.start) + '–' + clock(gap.end);
  return gap.title + ' · ' + span + ' · ' + (gap.bars !== undefined ? `${gap.bars} 小节` : `${Math.trunc(round(gap.end - gap.start))} 秒`);
}

/**
 * Gaps that do not already hold a MIX (non-part events covering less than half of them), with
 * ranked MIX runs that fit their bars. Returns `[{ id, gap, candidates, confidence,
 * confidenceTitle, summary }]`: `candidates` is a list of runs, each a list of library entries;
 * `confidence` is 'high' (beat map and word-timed lyrics), 'medium' (other grids) or 'gapOnly'
 * (no grid: gaps in seconds, no candidates). With a grid, a gap no run fits is left out.
 * `summary` reads "间奏 · 0:43–1:04 · 10 小节".
 */
function suggestions(lyrics, duration, grid, chart, library) {
  const wordTimed = linesOf(lyrics).some(line => Array.isArray(line.words) && line.words.length > 0);
  const confidence = !grid ? 'gapOnly' : grid.source === 'beatMap' && wordTimed ? 'high' : 'medium';
  const offset = offsetOf(chart), events = chart.events || [], hasMembers = (chart.members || []).length > 0;
  return gaps(lyrics, duration, grid).flatMap(gap => {
    const covered = sum(events.filter(event => event.kind !== 'part'),
      event => Math.max(0, Math.min(gap.end, event.end - offset) - Math.max(gap.start, event.start - offset)));
    if (!(covered < (gap.end - gap.start) * 0.5)) return [];
    const runs = gap.bars !== undefined ? candidates(gap.bars, gap.kind, hasMembers, library) : [];
    if (grid && !runs.length) return [];
    return [{
      id: gap.kind + '-' + Math.trunc(round(gap.start * 10)), gap, candidates: runs, confidence,
      confidenceTitle: CONFIDENCE_TITLES[confidence], summary: summaryOf(gap),
    }];
  });
}

/**
 * The events for one candidate run of a suggestion, in chart times (playback + `chartOffset`):
 * each MIX starts on a bar line and gets its lower bar count, spare bars go to the earlier ones up
 * to their upper counts, and the last runs on to the gap's end. Words get steps on the beats.
 * Returns [] without a grid, for a gap without bars or for a choice out of range.
 */
function suggestionEvents(suggestion, choice, grid, member, chartOffset = 0) {
  const gap = suggestion && suggestion.gap;
  if (!gap || !grid || !Array.isArray(suggestion.candidates) || !validIndex(suggestion.candidates, choice) ||
    gap.bars === undefined || gap.barStart === undefined) return [];
  const run = suggestion.candidates[choice];
  const allotted = run.map(mix => mix.bars[0]);
  let spare = gap.bars - sum(allotted);
  for (let i = 0; i < allotted.length; i++) {
    if (spare <= 0) continue;
    const extra = Math.min(spare, run[i].bars[1] - allotted[i]);
    allotted[i] += extra;
    spare -= extra;
  }
  const bar = barOf(grid), last = run.length - 1;
  let cursor = gap.barStart;
  return run.map((mix, index) => {
    const length = allotted[index] * bar;
    const end = index === last ? Math.max(cursor + length, gap.end) : cursor + length;
    const event = mixEvent(mix, cursor + chartOffset, end + chartOffset, member);
    event.steps = autoSteps(cheer.words(mix.text).length, cursor, end, grid);
    cursor = end;
    return event;
  });
}

// MARK: Chart edits

/** MIX and calls chain one after another; sing-along calls, parts and notes do not. */
const chains = event => (event.kind === 'mix' || event.kind === 'call') && event.echo !== true;
const firstAfter = (list, time) => list.find(span => span.start > time + 1e-6);

/** An event with new edges; its word times stretch with it. */
function resized(event, start, end) {
  const out = { ...event };
  if (Array.isArray(event.steps)) out.steps = event.steps.map(step => step * (end - start) / (event.end - event.start));
  out.start = start;
  out.end = end;
  return out;
}

function nextChainStart(chart, index, start, offset) {
  let next = null;
  chart.events.forEach((event, i) => {
    if (i === index || !chains(event)) return;
    const time = event.start - offset;
    if (time > start + 1e-6 && (next === null || time < next)) next = time;
  });
  return next;
}

// A tapped mark keeps its start and words; only an end running into the next line (or the next
// MIX or call) is brought back before it.
function trimTapped(chart, index, spanList) {
  const event = chart.events[index], offset = offsetOf(chart);
  const start = event.start - offset, end = event.end - offset;
  const nextLine = firstAfter(spanList, start)?.start ?? null;
  const nextEvent = nextChainStart(chart, index, start, offset);
  const limits = [nextLine, nextEvent].filter(value => value !== null);
  const limit = limits.length ? Math.min(...limits) : end;
  const lastWord = start + (Array.isArray(event.steps) && event.steps.length ? event.steps[event.steps.length - 1] : 0);
  const trimmed = Math.max(Math.min(end, limit), lastWord + MIN_EVENT_LENGTH, start + MIN_EVENT_LENGTH);
  if (!(trimmed < end - 1e-9)) return;
  chart.events[index] = { ...event, end: trimmed + offset };
}

// Liveglow's `CheerEditor.fit`, on a chart this module owns (mutated in place).
function fit(chart, index, spanList, grid, movingStart) {
  const event = chart.events[index], offset = offsetOf(chart);
  if (!chains(event)) return;
  if (event.tapped === true && !movingStart) { trimTapped(chart, index, spanList); return; }
  let start = event.start - offset;
  const length = event.end - event.start;
  // Only a line whose end the lyrics give moves the start; a guessed end could swallow a whole
  // interlude and squeeze the MIX.
  const line = spanList.find(span => !span.estimated && span.start <= start + 1e-6 && start < span.end - 1e-6);
  if (line) start = grid ? nextBeat(grid, line.end) : line.end;
  const nextLine = firstAfter(spanList, start)?.start ?? null;
  const nextEvent = nextChainStart(chart, index, start, offset);
  let end;
  if (nextLine !== null && nextEvent !== null && nextEvent < nextLine) {
    end = nextEvent;
  } else if (nextLine !== null) {
    end = nextLine;
    if (grid) {
      const bar = barOf(grid);
      const before = grid.anchor + Math.floor((nextLine - grid.anchor) / bar + 1e-6) * bar;
      if (before > start + grid.beat) end = before;
    }
  } else if (nextEvent !== null) {
    end = Math.min(nextEvent, start + length);
  } else {
    end = start + length;
  }
  end = Math.min(end, chart.song.duration + 5 - offset);
  if (!(end - start >= MIN_EVENT_LENGTH)) return;
  // An earlier MIX or call still running at the new start ends there.
  chart.events.forEach((other, i) => {
    if (i === index || !chains(other)) return;
    const s = other.start - offset, e = other.end - offset;
    if (s < start - 1e-6 && e > start + 1e-6 && start - s >= MIN_EVENT_LENGTH) chart.events[i] = resized(other, s + offset, start + offset);
  });
  const fitted = { ...event, start: start + offset, end: end + offset };
  const count = cheer.words(isString(fitted.text) ? fitted.text : '').length;
  if (count > 0) fitted.steps = autoSteps(count, start, end, grid);
  else delete fitted.steps;
  delete fitted.tapped;   // The tapping is replaced (the editor asks first when it was tapped).
  chart.events[index] = fitted;
}

const spanArray = value => (Array.isArray(value) ? value : []);

/**
 * A library entry inserted at a playback `position`: on the next beat when a grid is known, then
 * fitted to the lyric gap (`fitToLyricGap`); with no lyrics it lasts its lower bar count (two
 * seconds a bar without a grid), never past the song's end + 5 s. Its words get steps. `member`
 * fills a name slot (pass the editor's current member). `options.spans` are the lyric spans
 * (`spans(lyrics)`). Returns `{ chart, index }`: a new chart and the new event's index, or the
 * chart unchanged (copied) and index null when there is no room or the position is not a number.
 */
function insertMix(chart, entry, position, grid, member, { spans: spanList = [] } = {}) {
  const next = clone(chart), offset = offsetOf(chart);
  if (!finite(position)) return { chart: next, index: null };
  const start = grid ? nextBeat(grid, position) : Math.max(0, position);
  const end = Math.min(start + entry.bars[0] * (grid ? barOf(grid) : 2), chart.song.duration + 5 - offset);
  if (!(end > start)) return { chart: next, index: null };
  const event = mixEvent(entry, start + offset, end + offset, member);
  event.steps = autoSteps(cheer.words(entry.text).length, start, end, grid);
  next.events.push(event);
  const index = next.events.length - 1;
  fit(next, index, spanArray(spanList), grid, false);
  return { chart: next, index };
}

/**
 * The default place for a MIX or call: it starts after the lyric line it was put in has been
 * sung (only an end the lyrics give, not an estimated one) and ends before the next line starts
 * (on the bar line before it with a grid); one running into the next MIX or call ends where that
 * starts, and an earlier one still running at its start is cut there. Words are spread again.
 * A tapped event (`tapped: true`) keeps its start and words — only its end is pulled back —
 * unless `movingStart`, which replaces the tapping. Sing-along calls, parts and notes, and an
 * index out of range, leave the chart as it was. Returns a new chart.
 */
function fitToLyricGap(chart, index, spanList, grid, { movingStart = false } = {}) {
  const next = clone(chart);
  if (validIndex(next.events, index)) fit(next, index, spanArray(spanList), grid, movingStart);
  return next;
}

/** `fitToLyricGap` for every MIX at once, earliest first (calls are not moved). Returns a new chart. */
function fitAllMixToLyricGaps(chart, spanList, grid) {
  const next = clone(chart);
  const order = next.events.map((event, i) => ({ event, i })).filter(item => item.event.kind === 'mix')
    .sort((a, b) => a.event.start - b.event.start).map(item => item.i);
  for (const index of order) fit(next, index, spanArray(spanList), grid, false);
  return next;
}

/**
 * An event's words spread over the beats again (after its times or words changed). When the
 * event runs on into a sung line the words still finish before that line starts; the event's own
 * edges stay. A MIX or call without words, or any other kind, loses its steps. Returns a new chart.
 */
function redistributeSteps(chart, index, grid, spanList = []) {
  const next = clone(chart);
  if (!validIndex(next.events, index)) return next;
  const event = next.events[index], offset = offsetOf(next);
  const count = cheer.words(isString(event.text) ? event.text : '').length;
  const start = event.start - offset;
  let end = event.end - offset;
  const line = firstAfter(spanArray(spanList), start)?.start;
  if (line !== undefined && line < end && line - start >= MIN_EVENT_LENGTH) end = line;
  if (count > 0 && (event.kind === 'mix' || event.kind === 'call')) event.steps = autoSteps(count, start, end, grid);
  else delete event.steps;
  return next;
}

/**
 * A suggestion accepted: the chosen run's events (`suggestionEvents`, `member` filling name
 * slots) appended and each fitted to the gap and its neighbours. Returns a new chart; nothing is
 * added without a grid or for a choice out of range.
 */
function acceptSuggestion(chart, suggestion, choice, grid, member, { spans: spanList = [] } = {}) {
  const next = clone(chart);
  const events = suggestionEvents(suggestion, choice, grid, member, offsetOf(next));
  if (!events.length) return next;
  const first = next.events.length;
  next.events.push(...events);
  for (let index = first; index < next.events.length; index++) fit(next, index, spanArray(spanList), grid, false);
  return next;
}

/**
 * One or both edges of an event moved by seconds (±0.1 s or ±1 beat in the editor), the start
 * kept ≥ 0 and the end ≤ song end + 5 s; word times stretch with it. A move leaving the event
 * shorter than 0.05 s, or an index out of range, changes nothing. Returns a new chart.
 */
function shift(chart, index, { start = 0, end = 0 } = {}) {
  const next = clone(chart);
  if (!validIndex(next.events, index)) return next;
  const event = next.events[index];
  const newStart = Math.max(0, event.start + start), newEnd = Math.min(event.end + end, next.song.duration + 5);
  if (!(newEnd - newStart >= MIN_EVENT_LENGTH - 1e-9)) return next;
  next.events[index] = resized(event, newStart, newEnd);
  return next;
}

module.exports = {
  BEATS_PER_BAR, MIN_EVENT_LENGTH, MINIMUM_BARS, MINIMUM_SECONDS, RUNS, GAP_TITLES, CONFIDENCE_TITLES, POSITION_TITLES,
  makeGrid, barLine, nextBeat, gridFromBeatMap, gridFromTaps, gridFromWordPresses,
  autoSteps, effectiveSteps, activeWord,
  libraryEntries, entryById, mixEntry, hasNameSlot, mixEvent,
  lineEnds, spans, gaps, candidates, suggestions, suggestionEvents,
  insertMix, fitToLyricGap, fitAllMixToLyricGaps, redistributeSteps, acceptSuggestion, shift,
  clock, median, clone,
};
