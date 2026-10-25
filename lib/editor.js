'use strict';
// The cheer editor's model, ported from Liveglow (映场): CheerEditor.swift (hold-to-record keys,
// edits with undo, members, calibration, sharing), CheerWordTaps.swift (word-by-word tapping),
// the parts of CheerPresentation.swift a web cheer band needs (titles, band items, colours) and
// Liveglow's file writer (`CheerChart.exportData`). Liveglow's tests are ported in
// tests/editor.test.js with the same synthetic data, so both behave alike.
//
// Times: `position` arguments are playback times (seconds of the recording). Chart (file) times
// are playback times plus `chart.offset`; a positive offset shows events earlier. Recorded times
// also take off the listener's reaction time, `compensation` (seconds, 0–0.5, default 0.15):
// file time = position + offset − compensation. A cheer time (the band's clock) is a file time
// plus the listener's own per-song `userOffset` (spec/README.md §8).
// No dependencies and no Node APIs, so the browser bundle can load it.

const cheer = require('./cheer');
const suggest = require('./suggest');

/** The reaction time taken off recorded times until the listener calibrates, in seconds. */
const DEFAULT_COMPENSATION = 0.15;
/** A press shorter than this is a tap and gets the kind's default length. */
const MINIMUM_HOLD = 0.2;
/** Undo steps kept; older ones are dropped. */
const UNDO_LIMIT = 200;
/** Seconds between the pulses of the calibration screen. */
const CALIBRATION_INTERVAL = 0.8;
/** A word press within a quarter beat of a beat lands on it. */
const SNAP_TOLERANCE = 0.25;
/** The tool named in new charts' `generator` (at most 64 code points). */
const DEFAULT_GENERATOR = 'CheerBook 网页编辑器';
/** The band shows the next MIX or call this many seconds ahead by default. */
const DEFAULT_HINT_LEAD = 5;
/** The last three seconds count down "3 · 2 · 1". */
const COUNTDOWN_SECONDS = 3;

const MIN_EVENT_LENGTH = suggest.MIN_EVENT_LENGTH;
const { clone } = suggest;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const isString = value => typeof value === 'string';
const validIndex = (list, index) => Number.isInteger(index) && index >= 0 && index < list.length;
const offsetOf = chart => (finite(chart.offset) ? chart.offset : 0);
/** Swift's `rounded()`: halves away from zero. */
const round = value => (value < 0 ? -Math.round(-value) : Math.round(value));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Deep equality of plain data; a key holding undefined or null counts as absent. */
function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const present = object => Object.keys(object).filter(key => object[key] !== undefined && object[key] !== null);
  const keys = present(a);
  return keys.length === present(b).length && keys.every(key => b[key] !== undefined && b[key] !== null && same(a[key], b[key]));
}

/** Events sorted by start, then end, then their order in the list (spec/README.md §3.4). */
function sortedEvents(events) {
  return events.map((event, i) => ({ event, i }))
    .sort((a, b) => a.event.start - b.event.start || a.event.end - b.event.end || a.i - b.i)
    .map(item => item.event);
}

// MARK: Writing files

const pick = (object, keys) => {
  const out = {};
  for (const key of keys) if (object[key] !== undefined && object[key] !== null) out[key] = object[key];
  return out;
};

// Only the fields Liveglow's model knows, as its Encodable writes them: optional fields absent
// when unset, `offset` and `members` (and `credits.sources`) always written.
function encodable(chart, sorted) {
  const credits = chart.credits || {};
  const root = {
    format: cheer.FORMAT, version: cheer.VERSION,
    song: pick(chart.song || {}, ['title', 'artist', 'duration', 'album', 'isrc', 'appleMusicID']),
    offset: chart.offset ?? 0,
    members: (chart.members || []).map(member => pick(member, ['id', 'name', 'color'])),
    events: (sorted ? sortedEvents(chart.events || []) : chart.events || []).map(event => {
      const out = pick(event, ['start', 'end', 'kind', 'text', 'members', 'echo', 'mixRef', 'steps', 'tapped', 'name']);
      if (event.readings && typeof event.readings === 'object') out.readings = pick(event.readings, ['kana', 'romaji']);
      return out;
    }),
    credits: {
      ...pick(credits, ['permission', 'license', 'note']),
      authors: (credits.authors || []).map(author => pick(author, ['name', 'url'])),
      sources: (credits.sources || []).map(source => pick(source, ['kind', 'title', 'url', 'retrieved'])),
    },
  };
  if (chart.generator !== undefined && chart.generator !== null) root.generator = chart.generator;
  return root;
}

// A Double as Swift's JSONEncoder writes it (`description` without ".0"): the shortest digits
// that read back, in exponent form below 1e-4 or above 2^53 ("1e-05", "1e+16"), else plain.
function swiftNumber(value, path) {
  if (!Number.isFinite(value)) throw new TypeError(`serialize: ${path || 'value'} is not a finite number`);
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-4 && magnitude <= 2 ** 53) return String(value);
  const [mantissa, exponent] = value.toExponential().split('e');
  return mantissa + 'e' + (exponent[0] === '-' ? '-' : '+') + exponent.replace(/^[+-]/, '').padStart(2, '0');
}

// JSONEncoder's `.prettyPrinted, .sortedKeys, .withoutEscapingSlashes`: two-space indent,
// " : " between key and value, an empty list or object as "[\n\n<indent>]", no final newline.
// JSON.stringify escapes strings exactly as JSONEncoder does for well-formed text.
function write(value, indent, path) {
  if (Array.isArray(value)) {
    if (!value.length) return '[\n\n' + indent + ']';
    const inner = indent + '  ';
    return '[\n' + value.map((item, i) => inner + write(item, inner, `${path}[${i}]`)).join(',\n') + '\n' + indent + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (!keys.length) return '{\n\n' + indent + '}';
    const inner = indent + '  ';
    return '{\n' + keys.map(key => inner + JSON.stringify(key) + ' : ' + write(value[key], inner, path ? path + '.' + key : key)).join(',\n') + '\n' + indent + '}';
  }
  if (typeof value === 'number') return swiftNumber(value, path);
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  throw new TypeError(`serialize: ${path || 'value'} cannot be written`);
}

/**
 * The chart as a `.cheer.json` file, byte for byte as Liveglow's `exportData` writes it: events
 * sorted, keys sorted, pretty-printed, only the format's known fields. Does not validate (see
 * `validateChart`). Throws a TypeError when a number is not finite or a value has no JSON form.
 */
function serialize(chart) {
  return write(encodable(chart, true), '', '');
}

/**
 * Every rule of the format on a chart, as `cheer.parse` applies them to a file (the chart is
 * written in its own event order, so issue paths name events by their index in `chart.events`).
 * `sharing` true also requires an author (a file to share). Returns `{ valid, errors, warnings }`;
 * warnings are known only when there are no errors. A value that cannot be written gives one
 * `malformed` error.
 */
function validateChart(chart, { sharing = false } = {}) {
  let text;
  try {
    text = write(encodable(chart, false), '', '');
  } catch {
    return { valid: false, errors: [{ code: 'malformed', path: '' }], warnings: [] };
  }
  const result = cheer.parse(new TextEncoder().encode(text), { sharedFile: sharing });
  return result.valid ? { valid: true, errors: [], warnings: result.warnings } : { valid: false, errors: result.errors, warnings: [] };
}

// MARK: Keys

/**
 * The key a typed character records with: digits 1–9 a member's part (`{ member: index }`,
 * index 0–8), M / C / N (any case) a MIX, call or note. Anything else, full-width digits
 * included, gives null.
 */
function keyFor(character) {
  if (!isString(character)) return null;
  const lower = character.toLowerCase();
  if (lower === 'm') return 'mix';
  if (lower === 'c') return 'call';
  if (lower === 'n') return 'note';
  return /^[1-9]$/.test(character) ? { member: Number(character) - 1 } : null;
}

// A key as recorded: 'mix' | 'call' | 'note', or a member by index (a member id is looked up).
function resolveKey(key, members) {
  if (key === 'mix' || key === 'call' || key === 'note') return { id: key, kind: key };
  if (key && typeof key === 'object') {
    const index = isString(key.member) ? members.findIndex(member => member.id === key.member) : key.member;
    if (Number.isInteger(index) && index >= 0) return { id: 'member:' + index, kind: 'part', index };
  }
  return null;
}

/** Default seconds for a tap shorter than the minimum hold: MIX 4, part 2, call and note 1. */
function defaultLength(kind) {
  return { mix: 4, part: 2, call: 1, note: 1 }[kind] ?? 1;
}

/** A reaction time kept to 0–0.5 s; a value that is not a finite number gives the 0.15 s default. */
function clampedCompensation(seconds) {
  return finite(seconds) ? Math.min(0.5, Math.max(0, seconds)) : DEFAULT_COMPENSATION;
}

// MARK: Word-by-word tapping

function tapSummary(result) {
  const parts = [];
  if (result.grid) parts.push(`已对齐 ${result.snapped} 个词到节拍（BPM ${Math.trunc(round(result.grid.bpm))}）`);
  else parts.push(`已记录 ${result.steps.length - result.filled} 个词`);
  if (result.unsnapped > 0) parts.push(`${result.unsnapped} 个词偏离较大，未吸附`);
  if (result.filled > 0) parts.push(`少按了 ${result.filled} 下，后面的词按平均间隔补齐`);
  if (result.dropped > 0) parts.push(`多按的 ${result.dropped} 下已忽略`);
  return parts.join('；');
}

/**
 * Word-by-word tapping ("逐词跟拍"): `presses` are playback positions of each press on the beat
 * a word starts; less `compensation`, each is snapped to the nearest beat of `grid` (or of a grid
 * made from the presses, needing three) when within a quarter beat. Missing words are filled at
 * the average step, extra presses dropped. The event starts on the first word and ends one
 * average step after the last, before `nextLine` (playback start of the next sung line) when
 * there is room. Returns `{ start, end, steps, snapped, unsnapped, filled, dropped, grid,
 * gridFromPresses, summary }` in playback time (`steps` after `start`), or null with no words or
 * no presses.
 */
function wordTaps(presses, words, compensation, grid, nextLine) {
  const comp = finite(compensation) ? compensation : 0;
  let times = (Array.isArray(presses) ? presses : []).filter(finite).map(press => press - comp);
  if (!(words > 0) || !times.length) return null;
  const dropped = Math.max(0, times.length - words);
  times = times.slice(0, words);
  const made = grid ? null : suggest.gridFromWordPresses(times);
  const used = grid || made;
  let snapped = 0, unsnapped = 0;
  if (used) {
    let previous = -Infinity;
    for (let i = 0; i < times.length; i++) {
      const pressed = times[i];
      const beat = used.anchor + round((pressed - used.anchor) / used.beat) * used.beat;
      if (Math.abs(pressed - beat) <= used.beat * SNAP_TOLERANCE && beat > previous + 1e-6) { times[i] = beat; snapped++; }
      else unsnapped++;
      times[i] = Math.max(times[i], previous + MIN_EVENT_LENGTH);
      previous = times[i];
    }
  } else {
    for (let i = 1; i < times.length; i++) times[i] = Math.max(times[i], times[i - 1] + MIN_EVENT_LENGTH);
  }
  // The step between words: their average, or a beat (half a second without a grid).
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  const step = gaps.length ? gaps.reduce((total, gap) => total + gap, 0) / gaps.length : (used ? used.beat : 0.5);
  const filled = words - times.length;
  for (let i = 0; i < filled; i++) times.push(times[times.length - 1] + step);
  const start = times[0], last = times[times.length - 1];
  let end = last + step;
  if (finite(nextLine) && nextLine > last + MIN_EVENT_LENGTH && end > nextLine) end = nextLine;
  end = Math.max(end, last + MIN_EVENT_LENGTH);
  const result = { start, end, steps: times.map(time => time - start), snapped, unsnapped, filled, dropped, grid: used, gridFromPresses: made !== null };
  result.summary = tapSummary(result);
  return result;
}

/**
 * Where playback starts for tapping an event starting at `eventStart` (playback time): a beat
 * before the sung line before it, so the listener hears the line end, at most 12 s back; with no
 * such line, two beats before the event. Never below 0. `beat` is 0.6 s without a grid.
 */
function wordTapLeadIn(eventStart, spanList, grid) {
  const beat = grid ? grid.beat : 0.6;
  const list = Array.isArray(spanList) ? spanList : [];
  let previous = null;
  for (const span of list) if (span.start < eventStart - 1e-6) previous = span;
  if (!previous || previous.start - beat < eventStart - 12) return Math.max(0, eventStart - 2 * beat);
  return Math.max(0, previous.start - beat);
}

/**
 * What the tapping prompt shows: `{ kind: 'waiting' }` before the MIX, `{ kind: 'countdown',
 * value: 2 | 1 }` over the two beats before `expectedStart`, `{ kind: 'next', index }` for the word
 * to press next (one step per press), `{ kind: 'done' }` after the last word. `beat` falls back to
 * 0.6 s when not a positive number.
 */
function wordTapPrompt(presses, words, position, expectedStart, beat) {
  if (presses >= words) return { kind: 'done' };
  if (presses > 0) return { kind: 'next', index: presses };
  const remaining = expectedStart - position, step = finite(beat) && beat > 0 ? beat : 0.6;
  if (remaining > 2 * step + 1e-6) return { kind: 'waiting' };
  if (remaining > 1e-6) return { kind: 'countdown', value: Math.ceil(remaining / step - 1e-6) };
  return { kind: 'next', index: 0 };
}

// MARK: The editor

/**
 * The tap editor: hold a key while listening to record a span — a member's digit their part,
 * M / C / N a MIX, call or note — then fix text, members and times; undo covers every change.
 * `chart` is a deep-frozen plain object: read it freely, change it only through these methods
 * (`edit` and `apply` take any change). Keys are `'mix'`, `'call'`, `'note'` or `{ member }` with a
 * member index (0-based) or member id. Methods taking an index ignore one out of range.
 */
class CheerEditor {
  #chart;
  #baseline;
  #undo = [];
  #redo = [];
  #lastCoalescing = null;
  #recordings = new Map();
  #currentMember;

  /**
   * `chart` is copied. `compensation` is the reaction time in seconds (clamped to 0–0.5; it
   * may be set later without clamping); `entryID` is free for the caller (the entry being edited).
   */
  constructor(chart, { compensation = DEFAULT_COMPENSATION, entryID = null } = {}) {
    this.#chart = deepFreeze(clone(chart));
    this.#baseline = this.#chart;
    this.compensation = clampedCompensation(compensation);
    this.entryID = entryID;
    this.#currentMember = this.#chart.members?.[0]?.id ?? null;
  }

  /** The chart now (deep-frozen). */
  get chart() { return this.#chart; }
  /** The member id a MIX recorded with M names, and a library MIX's name slot: the last digit pressed. */
  get currentMember() { return this.#currentMember; }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  /** Whether the chart differs from the one opened or last marked saved. */
  get hasUnsavedChanges() { return !same(this.#chart, this.#baseline); }
  /** Spans being held: a Map from 'mix' | 'call' | 'note' | 'member:<index>' to their start (file time). */
  get recordings() { return new Map(this.#recordings); }

  /** The chart now is the one saved: `hasUnsavedChanges` turns false. */
  markSaved() { this.#baseline = this.#chart; }

  /**
   * Taps only mean something against this chart's song: whether `playing` (`{ title, artist,
   * duration, isrc?, appleMusicID? }`) is it (spec/README.md §8). False for null.
   */
  isEditing(playing) {
    return Boolean(playing) && cheer.matchSong(this.#chart.song, playing) !== null;
  }

  /** The file time of a playback position: position + offset − compensation, never below 0 (a non-number reads as 0). */
  fileTime(position) {
    return Math.max(0, (finite(position) ? position : 0) + offsetOf(this.#chart) - this.compensation);
  }

  /**
   * Starts a span. Returns false (and records nothing) for a key already held (key repeat), a
   * member key with no such member, or an unknown key. A member key makes that member current.
   */
  press(key, position) {
    const members = this.#chart.members || [];
    const resolved = resolveKey(key, members);
    if (!resolved || this.#recordings.has(resolved.id)) return false;
    if (resolved.kind === 'part') {
      if (resolved.index >= members.length) return false;
      this.#currentMember = members[resolved.index].id;
    }
    this.#recordings.set(resolved.id, this.fileTime(position));
    return true;
  }

  /**
   * Ends the span and appends its event (a part for a member key; a MIX names the current
   * member). A hold shorter than 0.2 s gets the kind's default length; the end stays within the
   * song's end + 5 s. Returns the new event's index, or null when the key was not held, its
   * member is gone or the span would be empty.
   */
  release(key, position) {
    const members = this.#chart.members || [];
    const resolved = resolveKey(key, members);
    if (!resolved || !this.#recordings.has(resolved.id)) return null;
    const start = this.#recordings.get(resolved.id);
    this.#recordings.delete(resolved.id);
    const end = this.fileTime(position);
    let event;
    if (resolved.kind === 'part') {
      if (resolved.index >= members.length) return null;
      event = { start, end: 0, kind: 'part', members: [members[resolved.index].id] };
    } else {
      event = { start, end: 0, kind: resolved.kind };
      if (resolved.kind === 'mix' && this.#currentMember !== null) event.members = [this.#currentMember];
    }
    event.end = Math.min(end - start >= MINIMUM_HOLD ? end : start + defaultLength(event.kind), this.#chart.song.duration + 5);
    if (!(event.end > event.start)) return null;
    this.edit(chart => { chart.events.push(event); });
    return this.#chart.events.length - 1;
  }

  /** Drops the spans being held (the window lost focus mid-hold) rather than guessing their ends. */
  cancelRecordings() { this.#recordings.clear(); }

  /**
   * Changes the chart as one undo step. `change` gets a mutable copy: change it in place, or
   * return a whole new chart. Nothing happens when the result equals the chart. Edits with the
   * same `coalescing` name in a row (typing into one field) undo as one step; any other edit ends
   * the run. Returns whether the chart changed. Throws whatever `change` throws (the chart stays).
   */
  edit(change, coalescing = null) {
    const draft = clone(this.#chart);
    const returned = change(draft);
    const next = returned !== undefined ? clone(returned) : draft;
    if (same(next, this.#chart)) return false;
    const run = coalescing ?? null;
    if (run === null || run !== this.#lastCoalescing) {
      this.#undo.push(this.#chart);
      if (this.#undo.length > UNDO_LIMIT) this.#undo.splice(0, this.#undo.length - UNDO_LIMIT);
    }
    this.#lastCoalescing = run;
    this.#redo = [];
    this.#chart = deepFreeze(next);
    return true;
  }

  /** Commits a whole chart (such as one returned by lib/suggest.js) as one undo step; see `edit`. */
  apply(chart, coalescing = null) {
    return this.edit(() => chart, coalescing);
  }

  /** Replaces one event (copied). */
  updateEvent(index, event) {
    if (!validIndex(this.#chart.events, index)) return false;
    return this.edit(chart => { chart.events[index] = clone(event); });
  }

  /** Removes one event. */
  removeEvent(index) {
    if (!validIndex(this.#chart.events, index)) return false;
    return this.edit(chart => { chart.events.splice(index, 1); });
  }

  /**
   * Moves either edge by seconds (0.05 s steps in the editor), the start kept ≥ 0; refused
   * without an undo step when the event would be shorter than 0.05 s. Word times stretch with it.
   */
  nudge(index, { start = 0, end = 0 } = {}) {
    if (!validIndex(this.#chart.events, index)) return false;
    return this.edit(chart => {
      const event = chart.events[index];
      const newStart = Math.max(0, event.start + start), newEnd = event.end + end;
      if (!(newEnd - newStart >= MIN_EVENT_LENGTH - 1e-9)) return;
      if (Array.isArray(event.steps)) event.steps = event.steps.map(step => step * (newEnd - newStart) / (event.end - event.start));
      event.start = newStart;
      event.end = newEnd;
    });
  }

  /**
   * Adds a member with the next free stable id (m1, m2, …), so events keep pointing at it through
   * renames. The first member becomes current. Returns the new id.
   */
  addMember(name, color) {
    const members = this.#chart.members || [];
    let number = members.length + 1;
    while (members.some(member => member.id === 'm' + number)) number++;
    const id = 'm' + number;
    this.edit(chart => { chart.members = [...(chart.members || []), { id, name, color }]; });
    if (this.#currentMember === null) this.#currentMember = id;
    return id;
  }

  /** Removes a member from the list and from events; parts left without a singer go too. */
  removeMember(id) {
    const changed = this.edit(chart => {
      chart.members = (chart.members || []).filter(member => member.id !== id);
      chart.events = chart.events.flatMap(event => {
        if (Array.isArray(event.members)) {
          event.members = event.members.filter(member => member !== id);
          if (!event.members.length) delete event.members;
        }
        return event.kind === 'part' && event.members === undefined ? [] : [event];
      });
    });
    if (this.#currentMember === id) this.#currentMember = this.#chart.members?.[0]?.id ?? null;
    return changed;
  }

  /** Sorts the events by start, end, then list order. */
  sortEvents() {
    return this.edit(chart => { chart.events = sortedEvents(chart.events); });
  }

  /** Back one step; returns false when there is none. Ends a coalescing run. */
  undo() {
    if (!this.#undo.length) return false;
    this.#redo.push(this.#chart);
    this.#chart = this.#undo.pop();
    this.#lastCoalescing = null;
    return true;
  }

  /** Forward one undone step; returns false when there is none. Ends a coalescing run. */
  redo() {
    if (!this.#redo.length) return false;
    this.#undo.push(this.#chart);
    this.#chart = this.#redo.pop();
    this.#lastCoalescing = null;
    return true;
  }

  /**
   * Word-by-word tapping written to an event as one undo step: its start, end and steps change
   * (chart time = playback + offset) and it is marked `tapped`; its text and members stay.
   * `presses` are playback positions; `spans` (lyric spans, sorted) give the next line the end must
   * not run into. Returns the `wordTaps` result, or null (nothing changed) for an index out of
   * range, an event without text, or no usable presses.
   */
  applyWordTaps(index, presses, grid, spanList = []) {
    if (!validIndex(this.#chart.events, index)) return null;
    const text = this.#chart.events[index].text;
    if (!isString(text)) return null;
    const list = Array.isArray(presses) ? presses : [];
    const first = list.length ? list[0] - this.compensation : 0;
    const nextLine = (Array.isArray(spanList) ? spanList : []).find(span => span.start > first + 0.05)?.start ?? null;
    const result = wordTaps(list, cheer.words(text).length, this.compensation, grid, nextLine);
    if (!result) return null;
    this.edit(chart => {
      const event = chart.events[index], offset = offsetOf(chart);
      event.start = Math.max(0, result.start + offset);
      event.end = result.end + offset;
      event.steps = [...result.steps];
      event.tapped = true;
    });
    return result;
  }

  // lib/suggest.js edits as undo steps, named as in Liveglow's editor.

  /**
   * `suggest.insertMix` committed; `member` defaults to the current member. Returns the new
   * event's index, or null when there was no room.
   */
  insertMix(entry, position, grid, { member = null, spans = [] } = {}) {
    const result = suggest.insertMix(this.#chart, entry, position, grid, member ?? this.#currentMember, { spans });
    if (result.index === null) return null;
    this.apply(result.chart);
    return result.index;
  }

  /** `suggest.fitToLyricGap` committed; returns whether the chart changed. */
  fitToLyricGap(index, spans, grid, { movingStart = false } = {}) {
    return this.apply(suggest.fitToLyricGap(this.#chart, index, spans, grid, { movingStart }));
  }

  /** `suggest.fitAllMixToLyricGaps` committed as one step; returns whether the chart changed. */
  fitAllMixToLyricGaps(spans, grid) {
    return this.apply(suggest.fitAllMixToLyricGaps(this.#chart, spans, grid));
  }

  /** `suggest.redistributeSteps` committed; returns whether the chart changed. */
  redistributeSteps(index, grid, spans = []) {
    return this.apply(suggest.redistributeSteps(this.#chart, index, grid, spans));
  }

  /** `suggest.acceptSuggestion` committed, name slots filled with the current member. */
  accept(suggestion, choice, grid, { spans = [] } = {}) {
    return this.apply(suggest.acceptSuggestion(this.#chart, suggestion, choice, grid, this.#currentMember, { spans }));
  }

  /** `suggest.shift` committed; returns whether the chart changed. */
  shift(index, { start = 0, end = 0 } = {}) {
    return this.apply(suggest.shift(this.#chart, index, { start, end }));
  }
}

/**
 * A new chart for a song: `song` is `{ title, artist, duration, album?, isrc?, appleMusicID? }`
 * (empty album / ISRC / catalog id left out). No members or events yet; the listener (trimmed
 * `author`, none when blank) as author of their own work; `generator` names the tool.
 */
function newChart(song, author, { generator = DEFAULT_GENERATOR } = {}) {
  const out = { title: song.title, artist: song.artist, duration: song.duration };
  for (const key of ['album', 'isrc', 'appleMusicID']) if (isString(song[key]) && song[key] !== '') out[key] = song[key];
  const name = isString(author) ? cheer.trimmed(author) : '';
  const chart = {
    song: out, offset: 0, members: [], events: [],
    credits: { authors: name ? [{ name }] : [], sources: [{ kind: 'self' }], permission: 'original' },
  };
  if (generator) chart.generator = generator;
  return chart;
}

/**
 * One-time calibration: the listener taps along to pulses (same clock, seconds). Each tap is
 * matched to the nearest pulse within half a second; the median lag of four or more matched taps
 * is their reaction time, clamped to 0–0.5 s. Returns null with fewer than four matches.
 */
function calibrationReaction(taps, pulses) {
  const lags = [];
  for (const tap of taps) {
    let nearest = null;
    for (const pulse of pulses) if (nearest === null || Math.abs(pulse - tap) < Math.abs(nearest - tap)) nearest = pulse;
    if (nearest !== null && Math.abs(nearest - tap) <= 0.5) lags.push(tap - nearest);
  }
  const median = suggest.median(lags);
  return lags.length >= 4 ? clampedCompensation(median) : null;
}

// MARK: Sharing

/** What each `credits.permission` reads as (spec/README.md §9). */
const PERMISSION_TITLES = {
  original: '原创', 'open-license': '开放许可', consented: '作者同意转载', 'public-only': '仅公开可见', official: '官方应援法', unknown: '未标明',
};
/** What each `credits.sources[].kind` reads as in the share note. */
const SOURCE_TITLES = { self: '自己听写', 'call-sheet': '粉丝 call 表', video: '视频', official: '官方应援法', other: '其他' };

/** Who may receive the file (spec/README.md §9): 'shareable' or 'localOnly'. */
function sharingOf(credits) {
  const derived = (credits.sources || []).some(source => source.kind !== 'self');
  switch (credits.permission) {
    case 'open-license': case 'consented': return 'shareable';
    case 'original': return derived ? 'localOnly' : 'shareable';
    default: return 'localOnly';
  }
}

// spec/README.md §10: a lyric line can be compared when, normalized as §8, it weighs 8 or more
// (a CJK character 2, others 1); fewer proves nothing.
const lyricWeight = text => [...text].reduce((total, c) => total + (c.codePointAt(0) >= 0x2E80 ? 2 : 1), 0);

/**
 * Whether the lyric comparison proves nothing: the chart carries text (an event's or the credits
 * note) and no lyric line (a string or a `{ text }` line) is long enough to compare. Sharing then
 * asks the maker to confirm. The same rule as lib/lyrics.js's `lyricsUnchecked`.
 */
function cannotCheckLyrics(chart, lyricTexts) {
  const hasText = (chart.events || []).some(event => isString(event.text) && event.text !== '') ||
    (isString(chart.credits?.note) && chart.credits.note !== '');
  const lines = (Array.isArray(lyricTexts) ? lyricTexts : []).map(line => (isString(line) ? line : line && isString(line.text) ? line.text : ''));
  return hasText && !lines.some(line => lyricWeight(cheer.normalizedName(line)) >= 8);
}

/** The sentence a source kind reads as in the note. */
function sourceTitle(kind) {
  return SOURCE_TITLES[kind] ?? SOURCE_TITLES.other;
}

/**
 * What travels instead of a file that may only be used on the maker's own device: the song,
 * authors, permission and every source that is not the maker's own, plus the credits note. Never
 * any event text. Ends with a newline.
 */
function shareNote(chart) {
  const credits = chart.credits;
  const lines = ['映场应援 · 来源说明', `歌曲：${chart.song.title} — ${chart.song.artist}`,
    '作者：' + credits.authors.map(author => author.name).join('、'),
    `授权：${PERMISSION_TITLES[credits.permission] ?? credits.permission}（应援数据只在制作者本机使用，此处只附来源）`];
  const sources = (credits.sources || []).filter(source => source.kind !== 'self');
  if (sources.length) {
    lines.push('来源：');
    for (const source of sources) {
      const parts = [sourceTitle(source.kind), source.title, source.url, isString(source.retrieved) ? '获取于 ' + source.retrieved : undefined];
      lines.push('- ' + parts.filter(part => part !== undefined && part !== null).join(' · '));
    }
  }
  if (isString(credits.note) && credits.note !== '') lines.push('说明：' + credits.note);
  return lines.join('\n') + '\n';
}

/**
 * What sharing produces: `{ kind: 'blocked', issues }` when the chart breaks a rule for shared
 * files or an event repeats the lyrics; `{ kind: 'noteOnly', note }` when the maker may not share
 * the data itself; `{ kind: 'unchecked' }` when the lyrics could not be compared (ask, then call
 * again with `confirmedUnchecked` true); otherwise `{ kind: 'file', text }` (`serialize`).
 * The lyric comparison is `lyricIssues(chart, lyricTexts)` from lib/lyrics.js, required only when
 * this runs, unless `options.lyricIssues` gives another (tests pass a stub); of its issues only
 * `lyricOverlap` blocks. Whether the lyrics can be compared at all is `cannotCheckLyrics`.
 */
function shareOutcome(chart, lyricTexts = [], confirmedUnchecked = false, { lyricIssues } = {}) {
  const { errors } = validateChart(chart, { sharing: true });
  if (errors.length) return { kind: 'blocked', issues: errors };
  const compare = typeof lyricIssues === 'function' ? lyricIssues : require('./lyrics').lyricIssues;
  const overlaps = compare(chart, lyricTexts).filter(found => found.code === 'lyricOverlap');
  if (overlaps.length) return { kind: 'blocked', issues: overlaps };
  if (sharingOf(chart.credits) !== 'shareable') return { kind: 'noteOnly', note: shareNote(chart) };
  if (!confirmedUnchecked && cannotCheckLyrics(chart, lyricTexts)) return { kind: 'unchecked' };
  return { kind: 'file', text: serialize(chart) };
}

/**
 * The share step's starting answer, read back from credits: `{ kind: 'selfMade' }` for the
 * maker's own work, else `{ kind: 'referenced', link, consented }` (the first other source's
 * link, '' when none; consented for an open licence or the author's consent).
 */
function shareOrigin(credits) {
  const others = (credits.sources || []).filter(source => source.kind !== 'self');
  if (credits.permission === 'original' && !others.length) return { kind: 'selfMade' };
  return { kind: 'referenced', link: others[0]?.url ?? '', consented: credits.permission === 'consented' || credits.permission === 'open-license' };
}

/**
 * The chart with the share step's answers in its credits: one author (trimmed `author`, a
 * nickname is fine; none when blank) and the origin — own work, or someone else's version with
 * its link (a source with the same link is kept) and whether its author agreed. A file under an
 * open licence keeps it when the author agreed. Returns a new chart.
 */
function prepareForSharing(chart, author, origin) {
  const next = clone(chart);
  const name = isString(author) ? cheer.trimmed(author) : '';
  next.credits.authors = name ? [{ name }] : [];
  if (!origin || origin.kind === 'selfMade') {
    next.credits.sources = [{ kind: 'self' }];
    next.credits.permission = 'original';
    return next;
  }
  const link = isString(origin.link) ? cheer.trimmed(origin.link) : '';
  const kept = (chart.credits.sources || []).find(source => source.kind !== 'self' && source.url === link);
  next.credits.sources = [kept ? clone(kept) : link ? { kind: 'other', url: link } : { kind: 'other' }];
  next.credits.permission = origin.consented ? (chart.credits.permission === 'open-license' ? 'open-license' : 'consented') : 'public-only';
  return next;
}

// MARK: Presentation

const LABELS = { mix: 'MIX', call: 'Call', part: '演唱', note: '提示' };

/** What a kind is called on the band: "MIX", "Call", "演唱", "提示". */
function eventLabel(kind) {
  return LABELS[kind] ?? kind;
}

/**
 * A text with name slots filled (spec/README.md §5.1): `{name}` the given member ids' names
 * joined with "・", `{name:id}` that member's name; unknown ids give nothing. A text whose braces
 * are not slots comes back as it is.
 */
function fillSlots(text, members, roster) {
  const tokens = cheer.parseSlots(text);
  if (!tokens) return text;
  const names = new Map();
  for (const member of roster || []) if (!names.has(member.id)) names.set(member.id, member.name);
  return tokens.map(token => {
    if (Object.hasOwn(token, 'literal')) return token.literal;
    if (token.name === null) return (members || []).filter(id => names.has(id)).map(id => names.get(id)).join('・');
    return names.get(token.name) ?? '';
  }).join('');
}

// User-perceived characters, as Swift counts `String.count`.
function characters(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
  }
  return [...text];
}

/**
 * The name the countdown and VoiceOver give an event (spec/README.md §4.3): "跟唱" for a
 * sing-along; its own trimmed `name`; the library's name for its `mixRef` or for a library text;
 * else a MIX's first two words (names filled, "…" when more), "Call：" / "提示：" and the first 8
 * characters ("…" when more), or the kind's label alone. `chart` gives the member names (may be
 * null); `library` is the parsed MIX library (may be null).
 */
function eventTitle(event, chart, library) {
  if (event.echo === true) return '跟唱';
  if (isString(event.name)) {
    const name = cheer.trimmed(event.name);
    if (name) return name;
  }
  const entry = suggest.mixEntry(library, event.mixRef) ?? suggest.libraryEntries(library).find(item => item.text === event.text);
  if (entry) return entry.name;
  const text = isString(event.text) ? fillSlots(event.text, event.members, chart?.members) : '';
  switch (event.kind) {
    case 'mix': {
      const words = cheer.words(text);
      if (!words.length) return LABELS.mix;
      return words.slice(0, 2).join('') + (words.length > 2 ? '…' : '');
    }
    case 'call': case 'note': {
      const chars = characters(text);
      const short = chars.length > 8 ? chars.slice(0, 8).join('') + '…' : text;
      return short ? LABELS[event.kind] + '：' + short : LABELS[event.kind];
    }
    default: return eventLabel(event.kind);
  }
}

// Colours: member colours are marks on a dark backdrop, so they need 3:1 against black (4.5:1
// with Increase Contrast); a colour too dark is lifted toward white in 5% steps.
function parseColor(hex) {
  const raw = isString(hex) ? hex.trim().toLowerCase() : '';
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (!match) return [1, 1, 1];
  const digits = match[1].length === 3 ? [...match[1]].map(c => c + c) : [0, 2, 4].map(i => match[1].slice(i, i + 2));
  return digits.map(pair => parseInt(pair, 16) / 255);
}

const blend = (color, amount) => color.map(channel => channel + (1 - channel) * amount);
const toHex = color => '#' + color.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('');

function contrast(color) {
  const linear = value => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
  return (luminance + 0.05) / 0.05;
}

/** WCAG contrast of a `#rgb` / `#rrggbb` colour against black (anything else reads as white). */
function contrastOnBlack(hex) {
  return contrast(parseColor(hex));
}

/**
 * A member colour that holds up on the dark band: `hex` (`#rgb` or `#rrggbb`, any case; anything
 * else reads as white) lifted toward white until it reaches 3:1 against black, 4.5:1 with
 * `increasedContrast`. Returns lowercase `#rrggbb`.
 */
function legibleColor(hex, increasedContrast = false) {
  const color = parseColor(hex), target = increasedContrast ? 4.5 : 3;
  let mix = 0;
  while (mix < 1 && contrast(blend(color, mix)) < target) mix += 0.05;
  return toHex(blend(color, Math.min(1, mix)));
}

// The band.

// A lyric line runs to the next line, or for its own length (4.8 s when unknown); lyric times.
function lineSpan(lines, index) {
  const line = lines[index];
  const next = index + 1 < lines.length ? lines[index + 1].start : null;
  const duration = finite(line.end) && line.end - line.start > 0 ? line.end - line.start : 4.8;
  return [line.start, next !== null ? (next > line.start ? next : line.start + duration) : line.start + duration];
}

// A sing-along's words are the listener's own lyric lines overlapping it, or '' without lyrics.
function echoText(event, chart, context) {
  const lines = context.lyrics && Array.isArray(context.lyrics.lines) ? context.lyrics.lines : [];
  const lyricOffset = context.lyrics && finite(context.lyrics.offset) ? context.lyrics.offset : 0;
  const cheerTime = lyricTime => lyricTime - lyricOffset + offsetOf(chart) + context.userOffset;
  return lines.filter((line, index) => {
    const [start, end] = lineSpan(lines, index);
    return Math.min(cheerTime(end), event.end) - Math.max(cheerTime(start), event.start) > 0.05;
  }).map(line => line.text).filter(text => isString(text) && !cheer.isBlank(text)).join(' / ');
}

// Readings to show: the event's own when they fit its words, else the library's for its text.
// Liveglow also makes missing ones with macOS's Japanese tokenizer; the web band shows none then.
function shownReadings(event, library) {
  if ((event.kind !== 'mix' && event.kind !== 'call') || event.echo === true || !isString(event.text)) return null;
  if (event.readings && cheer.readingsFit(event.readings, event)) return event.readings;
  const entry = suggest.mixEntry(library, event.mixRef) ?? suggest.libraryEntries(library).find(item => item.text === event.text);
  return entry && entry.text === event.text ? entry.readings : null;
}

function singersOf(ids, chart, increasedContrast) {
  const roster = chart.members || [];
  return (ids || []).flatMap(id => {
    const member = roster.find(item => item.id === id);
    return member ? [{ id, name: member.name, color: legibleColor(member.color, increasedContrast) }] : [];
  });
}

function bandItem(event, chart, time, context) {
  let text, words, steps, kana = [], romaji = [];
  if (event.echo === true) {
    text = echoText(event, chart, context);
    words = text ? [text] : [];
    steps = words.length ? [event.start] : [];
  } else {
    if (!isString(event.text)) return null;
    const fill = value => fillSlots(value, event.members, chart.members);
    text = fill(event.text);
    if (!text) return null;
    words = cheer.words(event.text).map(fill);
    steps = suggest.effectiveSteps(event).map(step => event.start + step);
    const readings = shownReadings(event, context.library);
    if (readings) { kana = (readings.kana || []).map(fill); romaji = (readings.romaji || []).map(fill); }
  }
  let activeWord = null;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i] <= time + 1e-6) { activeWord = i; break; }
  return {
    kind: event.kind, echo: event.echo === true, label: event.echo === true ? '跟唱' : eventLabel(event.kind), text,
    singers: singersOf(event.members, chart, context.increasedContrast), start: event.start, end: event.end,
    words, steps, activeWord, kana, romaji, title: eventTitle(event, chart, context.library),
  };
}

// Events sounding at a cheer time: start ≤ t < end, in sorted order.
function activeAt(events, time) {
  const out = [];
  for (const event of events) {
    if (!(event.start <= time)) break;
    if (time < event.end) out.push(event);
  }
  return out;
}

function hintWindow(practice, lead, hint) {
  const everyday = finite(hint) ? Math.max(COUNTDOWN_SECONDS, hint) : DEFAULT_HINT_LEAD;
  return practice && finite(lead) ? Math.max(everyday, lead) : everyday;
}

const hintKinds = practice => (practice ? ['mix', 'call', 'note'] : ['mix', 'call']);

/**
 * What the cheer band shows at cheer `time` (playback + chart offset + the listener's
 * `userOffset`): `{ singers, current, upcoming, countdown, showsUpcomingText, imminent, isEmpty,
 * needsPlate }`. `singers` (`[{ id, name, color }]`, colours made legible) sing the part covering
 * the time; `current` are the MIX, calls and notes sounding, each `{ kind, echo, label, text,
 * singers, start, end, words, steps, activeWord, kana, romaji, title }` with names filled, `steps`
 * the cheer time each word starts and `activeWord` the word being shouted (null before the
 * first). `upcoming` is the next MIX or call (notes too in `practice`) within the hint window
 * (`hint` s, at least 3, default 5; in practice at least `lead`), `countdown` the whole seconds
 * until it, `imminent` the last three ("3 · 2 · 1"), `showsUpcomingText` its words previewed
 * (practice, within max(`lead`, 3) s). A sing-along's text comes from `lyrics` (the lyrics model;
 * '' without). `needsPlate` is false when only singers show.
 */
function bandItems(chart, time, { lead = 0, library = null, lyrics = null, practice = false, hint = DEFAULT_HINT_LEAD, increasedContrast = false, userOffset = 0 } = {}) {
  const t = finite(time) ? time : 0;
  const context = { library, lyrics, increasedContrast, userOffset: finite(userOffset) ? userOffset : 0 };
  const events = sortedEvents(chart.events || []);
  const active = activeAt(events, t);
  const part = active.filter(event => event.kind === 'part').pop();
  const singers = part ? singersOf(part.members, chart, increasedContrast) : [];
  const current = active.filter(event => event.kind !== 'part').map(event => bandItem(event, chart, t, context)).filter(Boolean);
  let upcoming = null, countdown = null, showsUpcomingText = false;
  const kinds = hintKinds(practice);
  const next = events.find(event => event.start > t && kinds.includes(event.kind));
  if (next && next.start - t <= hintWindow(practice, lead, hint)) {
    const item = bandItem(next, chart, t, context);
    if (item) {
      upcoming = item;
      countdown = Math.max(1, Math.ceil(next.start - t));
      showsUpcomingText = practice && next.start - t <= Math.max(finite(lead) ? lead : 0, COUNTDOWN_SECONDS);
    }
  }
  return {
    singers, current, upcoming, countdown, showsUpcomingText,
    imminent: countdown !== null && countdown <= COUNTDOWN_SECONDS,
    isEmpty: !singers.length && !current.length && upcoming === null,
    needsPlate: current.length > 0 || upcoming !== null,
  };
}

/**
 * Seconds of playback until the band next changes (an event starting or ending, the next word,
 * the next MIX or call entering the hint window or its countdown ticking), or null when nothing
 * is left. Same clock and options as `bandItems`.
 */
function secondsUntilChange(chart, time, { practice = false, lead = 0, hint = DEFAULT_HINT_LEAD } = {}) {
  const t = finite(time) ? time : 0;
  const events = sortedEvents(chart.events || []);
  const waits = [];
  const edges = events.flatMap(event => [event.start, event.end]).filter(edge => edge > t);
  if (edges.length) waits.push(Math.min(...edges) - t);
  for (const event of activeAt(events, t)) {
    if (event.kind === 'part') continue;
    const word = suggest.effectiveSteps(event).map(step => event.start + step).find(start => start > t + 1e-6);
    if (word !== undefined) waits.push(word - t);
  }
  const kinds = hintKinds(practice);
  const next = events.find(event => event.start > t && kinds.includes(event.kind));
  if (next) {
    const remaining = next.start - t, window = hintWindow(practice, lead, hint);
    waits.push(remaining > window ? remaining - window : remaining - (Math.ceil(remaining) - 1));
    if (practice && remaining > lead) waits.push(remaining - lead);
  }
  const positive = waits.filter(wait => wait > 0);
  return positive.length ? Math.min(...positive) : null;
}

/**
 * One screen-reader sentence for a band, e.g. "演唱：成员甲。MIX：……。下一条，Call：Hey!"; the
 * last three seconds read "<title> 即将开始". Seconds are left out so it does not change every
 * second. An empty band reads "应援：暂无".
 */
function accessibilityLabel(band) {
  const parts = [];
  if (band.singers.length) parts.push('演唱：' + band.singers.map(singer => singer.name).join('、'));
  for (const item of band.current) parts.push(item.label + (item.text ? '：' + item.text : ''));
  const next = band.upcoming;
  if (next) {
    const extra = band.showsUpcomingText && next.text && !next.title.includes(next.text) ? '：' + next.text : '';
    parts.push((band.imminent ? `${next.title} 即将开始` : `下一条，${next.title}`) + extra);
  }
  return parts.length ? parts.join('。') : '应援：暂无';
}

/** What to read aloud as events begin: the current items of `next` not current in `previous` (once per event, not per word). */
function bandAnnouncements(previous, next) {
  const identity = item => `${item.kind}|${item.start}|${item.text}`;
  const before = new Set((previous ? previous.current : []).map(identity));
  return next.current.filter(item => !before.has(identity(item))).map(item => item.label + (item.text ? '：' + item.text : ''));
}

module.exports = {
  DEFAULT_COMPENSATION, MINIMUM_HOLD, UNDO_LIMIT, CALIBRATION_INTERVAL, SNAP_TOLERANCE, DEFAULT_GENERATOR, DEFAULT_HINT_LEAD, COUNTDOWN_SECONDS,
  PERMISSION_TITLES, SOURCE_TITLES,
  CheerEditor, keyFor, newChart, defaultLength, clampedCompensation, calibrationReaction,
  wordTaps, wordTapLeadIn, wordTapPrompt,
  serialize, validateChart, sortedEvents, sharingOf, cannotCheckLyrics, sourceTitle, shareNote, shareOutcome, shareOrigin, prepareForSharing,
  eventLabel, fillSlots, eventTitle, legibleColor, contrastOnBlack, bandItems, secondsUntilChange, accessibilityLabel, bandAnnouncements,
};
