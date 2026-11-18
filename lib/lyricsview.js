'use strict';
// How the web editor's lyric list moves and lights, ported from Liveglow's 歌词 view
// (NowPlayingLyricsModel and LyricsListView): the list moves to a line 0.3 s before it starts,
// the focus line sits at 30% of the list's height, lines below follow as a wave, every line is a
// dim ink with the sung part filling to full ink (word by word when timed, otherwise a smooth
// sweep over the line), other lines are slightly smaller, and a manual scroll holds the list
// for 4 s. Reduce Motion: no movement or scale, whole-line highlight. Pure: no DOM.

const FOCUS_LEAD = 0.3;
const ANCHOR = 0.3;
const MANUAL_SCROLL_HOLD = 4;
const DIM_INK = 0.42;
// Liveglow keeps 4.5:1 against its brightest backdrop; on the site's own surfaces 0.65 does.
const DIM_INK_INCREASED = 0.65;
const OTHER_LINE_SCALE = 0.98;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** The line the list moves to: the last whose start is within `lead` of `position`, or -1. */
function focusIndex(starts, position, lead = FOCUS_LEAD) {
  const t = (finite(position) ? position : 0) + lead;
  let index = -1;
  for (let i = 0; i < starts.length; i++) { if (starts[i] <= t) index = i; else break; }
  return index;
}

/** Seconds until `focusIndex` next changes, or null after the last line. */
function secondsUntilFocusChange(starts, position, lead = FOCUS_LEAD) {
  const t = (finite(position) ? position : 0) + lead;
  const next = starts.find(start => start > t);
  return next === undefined ? null : Math.max(0, next - t);
}

/**
 * The sweep of a line without word timing: `{ start, span }` in song time. It runs to the next
 * line's start; the last line takes its own duration (or 4.8 s), at most the song's end; never
 * shorter than 0.75 s. `lines` are `{ start, end? }` sorted by start.
 */
function sweep(lines, index, songDuration = 0) {
  const line = lines[index];
  if (!line || !finite(line.start)) return null;
  const next = lines[index + 1];
  const given = finite(line.end) && line.end > line.start ? line.end - line.start : 0;
  const lineDuration = Math.max(0.45, Math.min(12, given > 0 ? given : next && next.start > line.start ? next.start - line.start : 4.8));
  const end = next && next.start > line.start ? next.start : Math.min(songDuration > 0 ? songDuration : line.start + 4, line.start + lineDuration);
  return { start: line.start - 0.02, span: Math.max(0.75, end - line.start) };
}

/** A sweep's progress at `time`, eased (smoothstep), 0–1. */
function sweepProgress(lineSweep, time) {
  if (!lineSweep) return 0;
  const linear = Math.min(1, Math.max(0, (time - lineSweep.start) / lineSweep.span));
  return linear * linear * (3 - 2 * linear);
}

/**
 * How much of the focus line is lit, as a width along its characters: `widths` are the drawn
 * widths of its characters in order. With `words` (`[{ start, end, from, to }]`, character
 * ranges [from, to) with their times) each word fills continuously from its start to its end;
 * otherwise `lineSweep` lights the line with its eased progress.
 */
function litWidth(widths, time, { words = null, lineSweep = null } = {}) {
  const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0);
  const left = index => widths.slice(0, index).reduce((sum, width) => sum + Math.max(0, width), 0);
  if (words && words.length) {
    let lit = 0;
    for (const word of words) {
      if (!(time >= word.start)) break;
      const from = left(word.from), to = left(word.to);
      if (finite(word.end) && word.end > word.start && time < word.end) return from + (to - from) * (time - word.start) / (word.end - word.start);
      lit = to;
    }
    return lit;
  }
  return sweepProgress(lineSweep, time) * total;
}

/** A character's ink from dim (0) to full (1): a soft edge `feather` wide leads the fill. */
function brightness(charLeft, lit, feather) {
  if (!(feather > 0)) return lit > charLeft ? 1 : 0;
  return Math.min(1, Math.max(0, (lit - charLeft) / feather));
}

/** The dim ink of every line (and of the focus line's part still to come). */
const dimInk = increasedContrast => (increasedContrast ? DIM_INK_INCREASED : DIM_INK);

/**
 * A line's style at `distance` lines from the focus: `{ opacity, scale }`. The focus keeps the
 * dim ink under its fill; a hovered line is full ink; other lines are slightly smaller unless
 * Reduce Motion, Increase Contrast or browsing (a manual scroll) ask for a plain list.
 */
function lineStyle(distance, { increasedContrast = false, reduceMotion = false, browsing = false, hovered = false } = {}) {
  const dim = dimInk(increasedContrast);
  if (distance === 0) return { opacity: dim, scale: 1 };
  const plain = reduceMotion || increasedContrast || browsing;
  return { opacity: hovered ? 1 : dim, scale: plain ? 1 : OTHER_LINE_SCALE };
}

/** Lines below the focus follow 35 ms apart, at most 0.25 s; lines above move at once. Seconds. */
function staggerDelay(index, focus, reduceMotion = false) {
  return reduceMotion ? 0 : Math.min(0.25, Math.max(0, index - Math.max(0, focus)) * 0.035);
}

/** The scroll position that puts a line whose top is `lineTop` at the anchor of a `height` list. */
function anchorScroll(lineTop, height, anchor = ANCHOR) {
  return Math.max(0, lineTop - height * anchor);
}

/** After a manual scroll the list stays put this long; the next line change brings it back. */
function resumesFollowing(lastManualScroll, now) {
  return !(now - lastManualScroll <= MANUAL_SCROLL_HOLD);
}

/**
 * Liveglow's list spring (mass 1, stiffness 140, damping 24: critically damped, no bounce) as a
 * CSS `linear()` easing with its settling duration in milliseconds.
 */
function springEasing({ stiffness = 140, damping = 24, mass = 1, samples = 32 } = {}) {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const at = t => {
    if (zeta >= 1) return 1 - (1 + omega * t) * Math.exp(-omega * t);
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
  };
  let duration = 0.1;
  while (duration < 3 && Math.abs(1 - at(duration)) > 0.001) duration += 0.01;
  const points = [];
  for (let i = 0; i <= samples; i++) points.push(Number(at(duration * i / samples).toFixed(4)));
  points[points.length - 1] = 1;
  return { easing: `linear(${points.join(', ')})`, duration: Math.round(duration * 1000) };
}

// Ported from Liveglow public/js/stage/cheer-band.js (GPL-3.0-only).
var KANJI = /^(?:[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3005-\u3007\u30F5\u30F6]|[\uD840-\uD87F][\uDC00-\uDFFF])$/;
var KANA = /^[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF]$/;

function hiragana(text) {
  return String(text).replace(/[\u30A1-\u30F6]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0x60); });
}

// Mira: 2026-10-29 — the reading is lined up without a regex built from file data: the former
// `^A(.+?)B(.+?)…Z$` backtracked exponentially when a long word's reading did not fit (12 kanji
// runs took seconds). `anchors` are the word's kana (one more than its kanji runs; empty where
// nothing sits between); each kanji run reads at least one kana. The answer is the one that
// pattern found, each run as short as still lets the rest fit: from the end, the latest start
// each anchor can take with everything after it fitting; then from the front, each anchor at its
// first occurrence after one kana for the run before it. Nil when the reading does not fit.
// String indices count characters here because the reading and anchors are BMP kana only.
function rubyAlign(anchors, reading) {
  var last = anchors.length - 1, n = reading.length;
  if (reading.slice(0, anchors[0].length) !== anchors[0]) return null;
  if (last === 0) return anchors[0].length === n ? [] : null;
  var latest = [];
  var tail = n - anchors[last].length;
  latest[last] = tail >= 0 && reading.slice(tail) === anchors[last] ? tail : -1;
  for (var i = last - 1; i >= 1; i--) {
    var bound = latest[i + 1] - 1 - anchors[i].length;
    latest[i] = latest[i + 1] < 0 || bound < 0 ? -1 : reading.lastIndexOf(anchors[i], bound);
  }
  var at = anchors[0].length, rubies = [];
  if (latest[1] < at + 1) return null;
  for (var j = 1; j <= last; j++) {
    var start = j === last ? latest[last] : reading.indexOf(anchors[j], at + 1);
    rubies.push(reading.slice(at, start));
    at = start + anchors[j].length;
  }
  return rubies;
}

function rubySegments(word, kana) {
  var chars = Array.from(word);
  if (!kana || !chars.some(function (ch) { return KANJI.test(ch); })) return [{ base: word, ruby: null }];
  var runs = [], slot = false;
  chars.forEach(function (ch) {
    if (ch === '{') slot = true;
    var kind = slot ? 'other' : KANJI.test(ch) ? 'kanji' : KANA.test(ch) ? 'kana' : 'other';
    if (ch === '}') slot = false;
    if (runs.length && runs[runs.length - 1].kind === kind) runs[runs.length - 1].text += ch; else runs.push({ kind: kind, text: ch });
  });
  var reading = Array.from(hiragana(String(kana).replace(/\{[^}]*\}/g, ''))).filter(function (ch) { return KANA.test(ch); }).join('');
  var anchors = [''];
  runs.forEach(function (run) {
    if (run.kind === 'kanji') anchors.push('');
    else if (run.kind === 'kana') anchors[anchors.length - 1] += hiragana(run.text);
  });
  var rubies = rubyAlign(anchors, reading);
  if (!rubies) return [{ base: word, ruby: kana }];
  var segments = [], group = 0;
  runs.forEach(function (run) {
    if (run.kind === 'kanji') { segments.push({ base: run.text, ruby: rubies[group] }); group += 1; }
    else if (segments.length && segments[segments.length - 1].ruby === null) segments[segments.length - 1].base += run.text;
    else segments.push({ base: run.text, ruby: null });
  });
  return segments;
}

// Mira: D-064 — a word for the layers shown, as CheerRuby.column: with the text off the main row
// is the kana (or the romaji alone); a missing reading falls back to the written word.
function rubyColumn(word, kana, romaji, scripts) {
  kana = kana || null; romaji = romaji || null;
  var under = scripts.romaji && (scripts.original || scripts.kana) ? romaji : null;
  if (scripts.original) return { segments: scripts.kana ? rubySegments(word, kana) : [{ base: word, ruby: null }], romaji: under };
  if (scripts.kana) return { segments: [{ base: kana || word, ruby: null }], romaji: under };
  return { segments: [{ base: romaji || word, ruby: null }], romaji: null };
}

module.exports = {
  rubyColumn, rubySegments,
  FOCUS_LEAD, ANCHOR, MANUAL_SCROLL_HOLD, DIM_INK, DIM_INK_INCREASED, OTHER_LINE_SCALE,
  focusIndex, secondsUntilFocusChange, sweep, sweepProgress, litWidth, brightness, dimInk, lineStyle, staggerDelay,
  anchorScroll, resumesFollowing, springEasing,
};
