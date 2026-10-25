'use strict';
// lib/suggest.js against the cases of Liveglow's CheerSuggestTests.swift and the grid, gap and fit
// cases of CheerWordTapsTests.swift, with the same synthetic data: a made-up song at 120 BPM
// (a bar is 2 s): intro 0–16, verses, a repeated chorus, a long interlude and an outro.
const test = require('node:test');
const assert = require('node:assert/strict');
const cheer = require('../lib/cheer');
const suggest = require('../lib/suggest');
const { CheerEditor, validateChart, serialize } = require('../lib/editor');
const library = require('../spec/mix-library.json');

// Lyrics in lib/lyrics.js's model. A line sung for 3.5 s as one timed word.
const line = (start, text, sung = 3.5) => ({ start, text, words: [{ start, end: start + sung, text }] });
const song = {
  lines: [
    line(16, 'Verse one'), line(20, 'Verse two'), line(24, 'Verse three'),   // sung to 27.5
    line(36, 'Chorus line'), line(40, 'Chorus two'),                         // gap 27.5–36 leads into the chorus
    line(64, 'Bridge one'), line(68, 'Bridge two'),                          // interlude 43.5–64
    line(80, 'Chorus line'), line(84, 'Chorus two'),                         // gap 71.5–80 leads into the chorus
  ],
};
const grid = suggest.makeGrid(0.5, 0, 'beatMap');
const tapGrid = suggest.makeGrid(0.5, 0, 'taps');
const entry = id => suggest.entryById(library, id);

function chart({ members = true, duration = 104 } = {}) {
  return {
    song: { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration }, offset: 0,
    members: members ? [{ id: 'm1', name: 'Alpha', color: '#E4007F' }] : [], events: [],
    credits: { authors: [], sources: [], permission: 'original' },
  };
}

const assertClean = value => assert.deepEqual(validateChart(value), { valid: true, errors: [], warnings: [] });
const ids = run => run.map(mix => mix.id);

test('the grid comes from the beat map', () => {
  const beats = Array.from({ length: 16 }, (_, i) => ({ time: 0.25 + i * 0.5, combo: i % 4 === 1 ? 'downbeat' : 'rebound' }));
  const found = suggest.gridFromBeatMap({ beats, gridStep: 0.5 });
  assert.ok(found);
  assert.equal(found.bpm, 120);
  assert.equal(found.anchor, 0.75);
  assert.equal(found.source, 'beatMap');
  assert.equal(suggest.barLine(found, 1), 2.75);
  assert.equal(suggest.nextBeat(found, 1.1), 1.25);
  assert.equal(suggest.nextBeat(found, 1.25), 1.25);
  assert.equal(suggest.gridFromBeatMap({ beats: beats.slice(0, 3) }), null);
  assert.equal(suggest.gridFromBeatMap({}), null);
});

test('taps estimate the tempo and the bar line', () => {
  // Eight taps near 128 BPM with jitter and one double tap.
  const beat = 60 / 128;
  const taps = Array.from({ length: 8 }, (_, i) => 10 + i * beat + (i % 2 === 0 ? 0.01 : -0.01));
  taps.splice(4, 0, taps[3] + 0.08);
  const found = suggest.gridFromTaps(taps);
  assert.ok(found);
  assert.ok(Math.abs(found.bpm - 128) < 3 && found.source === 'taps');
  assert.ok(Math.abs(found.anchor - 10) < 0.03);
  assert.equal(suggest.gridFromTaps([1, 2, 3]), null);
  assert.equal(suggest.gridFromTaps(Array.from({ length: 8 }, (_, i) => i * 2)), null);   // 30 BPM is not a beat.
});

test('gaps find the intro, the run-ups to the chorus, the interlude and the outro', () => {
  const found = suggest.gaps(song, 104, grid);
  assert.deepEqual(found.map(gap => gap.kind), ['intro', 'chorusLead', 'interlude', 'chorusLead', 'outro']);
  assert.deepEqual(found.map(gap => gap.bars), [8, 4, 10, 4, 8]);
  assert.deepEqual(found.map(gap => gap.barStart), [0, 28, 44, 72, 88]);
  assert.deepEqual(found.map(gap => gap.title), ['前奏', '副歌前连接段', '间奏', '副歌前连接段', '尾奏']);
  // Without word timing a line is taken to last up to 8 s, so the gaps are narrower.
  const lineOnly = { lines: song.lines.map(({ start, text }) => ({ start, text })) };
  const narrower = suggest.gaps(lineOnly, 104, grid);
  assert.deepEqual(narrower.map(gap => gap.kind), ['intro', 'chorusLead', 'interlude', 'chorusLead', 'outro']);
  assert.deepEqual(narrower.map(gap => gap.bars), [8, 2, 8, 2, 7]);
  // A +2 s lyric offset moves everything 2 s earlier in playback time.
  assert.equal(suggest.gaps({ ...song, offset: 2 }, 104, grid)[0].end, 14);
});

test('suggestions fit MIX to the gap', () => {
  const found = suggest.suggestions(song, 104, grid, chart(), library);
  assert.deepEqual(found.map(item => (item.candidates[0] ? ids(item.candidates[0]) : [])),
    [['standard', 'japanese'], ['standard'], ['chaos'], ['standard'], ['ainu-wisupe']]);
  assert.ok(found.every(item => item.confidence === 'high' && item.confidenceTitle === '把握高'));
  assert.equal(found[2].summary, '间奏 · 0:43–1:04 · 10 小节');
  assert.equal(found[2].id, 'interlude-435');
  // 10 bars of 混沌MIX (8–10) fill the interlude from its bar line.
  const interlude = suggest.suggestionEvents(found[2], 0, grid, 'm1', 0);
  assert.deepEqual(interlude.map(event => [event.start, event.end]), [[44, 64]]);
  assert.equal(interlude[0].mixRef, 'tradition:chaos');
  const intro = suggest.suggestionEvents(found[0], 0, grid, null, 0.5);
  assert.deepEqual(intro.map(event => [event.start, event.end]), [[0.5, 8.5], [8.5, 16.5]]);
  // A 16-bar interlude gets ガチ恋口上 with the member in its slot — but only with a member.
  const long = suggest.candidates(16, 'interlude', true, library);
  assert.deepEqual(ids(long[0]), ['gachikoi']);
  assert.ok(!suggest.candidates(16, 'interlude', false, library).some(run => run.some(mix => mix.id === 'gachikoi')));
  const slot = { gap: { kind: 'interlude', title: '间奏', start: 0, end: 32, barStart: 0, bars: 16 }, candidates: long, confidence: 'high' };
  assert.deepEqual(suggest.suggestionEvents(slot, 0, grid, 'm1', 0)[0].members, ['m1']);
});

test('suggestions skip filled gaps and know when they cannot count bars', () => {
  const filled = chart();
  filled.events = [{ start: 0, end: 15, kind: 'mix', text: 'タイガー！', mixRef: 'tradition:standard' }];
  assert.equal(suggest.suggestions(song, 104, grid, filled, library)[0].gap.kind, 'chorusLead');
  // Without a grid (Apple Music without taps): gaps in seconds, nothing fitted.
  const secondsOnly = suggest.suggestions(song, 104, null, chart(), library);
  assert.deepEqual(secondsOnly.map(item => item.confidence), Array(5).fill('gapOnly'));
  assert.ok(secondsOnly.every(item => item.candidates.length === 0 && item.gap.bars === undefined));
  assert.equal(secondsOnly[0].summary, '前奏 · 0:00–0:16 · 16 秒');
  assert.equal(secondsOnly[0].confidenceTitle, '只标空位');
  assert.deepEqual(suggest.suggestionEvents(secondsOnly[0], 0, null, null, 0), []);
  // Taps give bars, with less certainty than a beat map.
  assert.ok(suggest.suggestions(song, 104, tapGrid, chart(), library).every(item => item.confidence === 'medium'));
});

test('a MIX inserts on the next beat, and accepting a suggestion is one step', () => {
  const editor = new CheerEditor(chart());
  const index = editor.insertMix(entry('standard'), 10.1, grid);
  assert.notEqual(index, null);
  assert.deepEqual([editor.chart.events[index].start, editor.chart.events[index].end], [10.5, 18.5]);
  const free = editor.insertMix(entry('standard'), 30.2, null);
  assert.deepEqual([editor.chart.events[free].start, editor.chart.events[free].end], [30.2, 38.2]);
  assertClean(editor.chart);
  const suggestion = suggest.suggestions(song, 104, grid, chart(), library)[0];
  editor.accept(suggestion, 0, grid);
  assert.equal(editor.chart.events.length, 4);
  editor.undo();
  assert.equal(editor.chart.events.length, 2);
});

test('the chart functions leave their arguments alone and return new charts', () => {
  const original = chart();
  original.events = [{ start: 10, end: 12, kind: 'mix', text: 'A！B！', steps: [0, 1] }];
  const before = JSON.stringify(original);
  const inserted = suggest.insertMix(original, entry('standard'), 20, grid, 'm1');
  assert.equal(inserted.index, 1);
  assert.notEqual(inserted.chart, original);
  for (const next of [
    suggest.fitToLyricGap(original, 0, suggest.spans(song), grid), suggest.fitAllMixToLyricGaps(original, suggest.spans(song), grid),
    suggest.redistributeSteps(original, 0, grid), suggest.shift(original, 0, { end: 1 }), suggest.shift(original, 5, { end: 1 }),
    suggest.acceptSuggestion(original, suggest.suggestions(song, 104, grid, chart(), library)[2], 0, grid, 'm1'),
  ]) assert.notEqual(next, original);
  assert.equal(JSON.stringify(original), before);
  // No room: an unchanged copy and no index.
  const late = suggest.insertMix(original, entry('standard'), 200, null, null);
  assert.equal(late.index, null);
  assert.deepEqual(late.chart, original);
  assert.equal(suggest.insertMix(original, entry('standard'), Number.NaN, null, null).index, null);
});

// Second MIX round: an 8-bar interlude gets 朧月MIX; a chant without bar counts (アラビア語MIX) is never suggested.
test('朧月MIX fills an eight-bar interlude', () => {
  assert.deepEqual(ids(suggest.candidates(8, 'interlude', true, library)[0]), ['oborozuki']);
  assert.deepEqual(ids(suggest.candidates(10, 'interlude', true, library)[0]), ['chaos']);
  assert.ok(!suggest.RUNS.some(run => run.length === 1 && run[0] === 'arabic'));
});

test('words split on exclamation marks', () => {
  assert.deepEqual(cheer.words('（よっしゃー！いくぞー！）タイガー！ファイヤー！'), ['（よっしゃー！', 'いくぞー！）', 'タイガー！', 'ファイヤー！']);
  assert.deepEqual(cheer.words('パン パパン（ヒュー）× 4'), ['パン パパン（ヒュー）× 4']);
  assert.deepEqual(cheer.words('虎！火！（飛！除去！）'), ['虎！', '火！', '（飛！', '除去！）']);
  assert.deepEqual(cheer.words('Go! Go!'), ['Go!', 'Go!']);
  assert.deepEqual(cheer.words(''), []);
});

test('steps land on beats or spread evenly', () => {
  // 3 words over 8 beats (4 s at 120 BPM) from 10.1: beats at 10.5, 11.0 …; spread over them.
  assert.deepEqual(suggest.autoSteps(3, 10.1, 14.1, grid).map(step => Math.round(step * 100) / 100), [0.4, 1.4, 2.9]);
  assert.deepEqual(suggest.autoSteps(4, 0, 8, null), [0, 2, 4, 6]);
  assert.deepEqual(suggest.autoSteps(5, 0, 1, grid).map(step => Math.round(step * 10) / 10), [0, 0.2, 0.4, 0.6, 0.8]);   // Too few beats.
  assert.deepEqual(suggest.autoSteps(0, 0, 1, grid), []);
  const withSteps = steps => {
    const value = chart({ members: false, duration: 60 });
    value.song.title = 'S'; value.song.artist = 'A';
    value.events = [{ start: 1, end: 5, kind: 'mix', text: 'A！B！', steps }];
    return validateChart(value).errors;
  };
  assert.deepEqual(withSteps([0, 2]), []);
  assert.deepEqual(withSteps([0, 2, 3]), [{ code: 'steps', path: 'events[0].steps' }]);
  assert.deepEqual(withSteps([2, 1]), [{ code: 'steps', path: 'events[0].steps' }]);
  assert.deepEqual(withSteps([0, 4]), [{ code: 'steps', path: 'events[0].steps' }]);
});

test('effective steps and the active word', () => {
  assert.deepEqual(suggest.effectiveSteps({ start: 20, end: 26, kind: 'mix', text: '有明！十六夜！朧月！' }), [0, 2, 4]);
  assert.deepEqual(suggest.effectiveSteps({ start: 40, end: 44, kind: 'mix', text: 'A！B！', steps: [0, 3] }), [0, 3]);
  assert.deepEqual(suggest.effectiveSteps({ start: 40, end: 44, kind: 'mix', text: 'A！B！', steps: [0] }), [0, 2]);
  assert.equal(suggest.activeWord([0, 2, 4], 20, 19.9), null);
  assert.equal(suggest.activeWord([0, 2, 4], 20, 21.9999999), 1);
  assert.equal(suggest.activeWord([0, 2, 4], 20, 30), 2);
});

test('steps survive the file, and absent steps stay absent', () => {
  const value = {
    song: { title: 'S', artist: 'A', duration: 60 }, offset: 0, members: [],
    events: [{ start: 1, end: 5, kind: 'mix', text: 'A！B！', steps: [0, 2] }, { start: 6, end: 7, kind: 'call', text: 'C！' }],
    credits: { authors: [{ name: 'Maker' }], sources: [], permission: 'original' },
  };
  const text = serialize(value);
  assert.deepEqual(cheer.parse(Buffer.from(text)).chart, value);
  assert.equal(text.split('"steps"').length, 2);
});

test('an inserted MIX sits in the lyric gap', () => {
  const lyricSpans = suggest.spans(song);
  const editor = new CheerEditor(chart());
  // In the interlude (43.5–64): from the next beat to the bar line before the next line.
  const a = editor.insertMix(entry('oborozuki'), 44.2, grid, { spans: lyricSpans });
  assert.deepEqual([editor.chart.events[a].start, editor.chart.events[a].end], [44.5, 64]);
  assert.equal(editor.chart.events[a].steps.length, 12);
  assertClean(editor.chart);
  // Asked for mid-line (20–23.5), it waits for the line to end and stops before the next.
  const b = editor.insertMix(entry('oborozuki'), 21, null, { spans: lyricSpans });
  assert.deepEqual([editor.chart.events[b].start, editor.chart.events[b].end], [23.5, 24]);
  // No lyrics: its own length, 8 bars at two seconds a bar.
  const c = editor.insertMix(entry('oborozuki'), 90, null);
  assert.equal(editor.chart.events[c].end, 106);
});

test('chained cheers meet without overlapping', () => {
  const lyricSpans = suggest.spans(song);
  const editor = new CheerEditor(chart());
  const mix = editor.insertMix(entry('oborozuki'), 44, null, { spans: lyricSpans });
  const call = editor.insertMix(entry('ppph'), 56, null, { spans: lyricSpans });
  // The MIX now ends where the call starts; the call still ends before the next line.
  assert.equal(editor.chart.events[mix].end, 56);
  assert.deepEqual([editor.chart.events[call].start, editor.chart.events[call].end], [56, 64]);
  assertClean(editor.chart);
  // A MIX inserted before an existing call stops at it.
  const other = new CheerEditor(chart());
  other.edit(value => { value.events.push({ start: 50, end: 52, kind: 'call', text: 'Alpha！' }); });
  const early = other.insertMix(entry('oborozuki'), 44, null, { spans: lyricSpans });
  assert.equal(other.chart.events[early].end, 50);
});

test('old events are fitted only when asked', () => {
  const lyricSpans = suggest.spans(song);
  const editor = new CheerEditor(chart());
  editor.edit(value => {
    value.events = [
      { start: 60, end: 70, kind: 'mix', text: '有明！十六夜！' },   // Runs over the line at 64.
      { start: 65, end: 66, kind: 'call', text: 'Hey!' },           // A call sung over a line.
      { start: 81, end: 83, kind: 'call', echo: true },
    ];
  });
  assert.equal(editor.chart.events[0].end, 70);                     // Untouched until asked.
  editor.fitAllMixToLyricGaps(lyricSpans, grid);
  assert.deepEqual([editor.chart.events[0].start, editor.chart.events[0].end, editor.chart.events[0].steps.length], [60, 64, 2]);
  assert.equal(editor.chart.events[1].start, 65);
  assert.deepEqual(editor.chart.events[2], { start: 81, end: 83, kind: 'call', echo: true });
  editor.undo();
  assert.equal(editor.chart.events[0].end, 70);                     // One undo step.
  // A single call can be fitted on its own: it waits for the line (64–67.5).
  editor.fitToLyricGap(1, lyricSpans, null);
  assert.deepEqual([editor.chart.events[1].start, editor.chart.events[1].end], [67.5, 68]);
});

test('edges shift by seconds or beats', () => {
  const editor = new CheerEditor(chart());
  editor.edit(value => { value.events = [{ start: 10, end: 12, kind: 'mix', text: 'A！B！', steps: [0, 1] }]; });
  editor.shift(0, { end: 0.5 });
  assert.equal(editor.chart.events[0].end, 12.5);
  assert.deepEqual(editor.chart.events[0].steps, [0, 1.25]);
  editor.shift(0, { start: -0.1 });
  assert.ok(Math.abs(editor.chart.events[0].start - 9.9) < 1e-9);
  assertClean(editor.chart);
  editor.shift(0, { start: 10 });                                   // Would cross the end: refused.
  assert.ok(Math.abs(editor.chart.events[0].start - 9.9) < 1e-9);
});

test('an accepted suggestion fits the gap', () => {
  const editor = new CheerEditor(chart());
  const suggestion = suggest.suggestions(song, 104, grid, chart(), library)[2];
  editor.accept(suggestion, 0, grid, { spans: suggest.spans(song) });
  assert.equal(editor.chart.events.at(-1).end, 64);
  assertClean(editor.chart);
});

test('respread words finish before the next line', () => {
  const editor = new CheerEditor(chart());
  editor.edit(value => { value.events = [{ start: 60, end: 70, kind: 'mix', text: 'A！B！C！D！' }]; });
  editor.redistributeSteps(0, null, suggest.spans(song));
  // The line at 64 is where the words must be done; the edges stay where they were.
  assert.deepEqual(editor.chart.events[0].steps, [0, 1, 2, 3]);
  assert.equal(editor.chart.events[0].end, 70);
  editor.redistributeSteps(0, null);
  assert.deepEqual(editor.chart.events[0].steps, [0, 2.5, 5, 7.5]);
});

// From CheerWordTapsTests.swift.

const oborozukiAt = (start, end) => new CheerEditor({
  ...chart({ members: false, duration: 240 }), events: [{ start, end, kind: 'mix', text: entry('oborozuki').text }],
});

test('the user’s case: an old 朧月MIX fits before the next line', () => {
  const editor = oborozukiAt(194, 210);
  const lyricSpans = [{ start: 186, end: 193.5, estimated: false }, { start: 203, end: 207, estimated: false }];
  editor.fitToLyricGap(0, lyricSpans, null);
  assert.deepEqual([editor.chart.events[0].start, editor.chart.events[0].end], [194, 203]);
  // With tapped bars it stops on the bar line before the line (bars every 2 s from 0).
  const barred = new CheerEditor(editor.chart);
  barred.edit(value => { value.events[0].end = 210; });
  barred.fitToLyricGap(0, lyricSpans, tapGrid);
  assert.equal(barred.chart.events[0].end, 202);
  assert.ok(barred.chart.events[0].steps.every(step => (194 + step) % 0.5 === 0));
});

test('a MIX inserted with tapped bars starts on the next beat', () => {
  const editor = new CheerEditor(chart({ members: false, duration: 240 }));
  const index = editor.insertMix(entry('standard'), 10.2, tapGrid);
  assert.equal(editor.chart.events[index].start, 10.5);
});

test('guessed line ends do not squeeze the MIX', () => {
  // Line-timed lyrics give no line ends; the guessed end of the line before must not push the MIX
  // into the last seconds before the next line.
  const lyrics = { lines: [{ start: 190, text: '前のフレーズ' }, { start: 203, text: '次のフレーズ' }] };
  const lyricSpans = suggest.spans(lyrics);
  assert.deepEqual(lyricSpans.map(span => span.estimated), [true, true]);
  assert.equal(lyricSpans[0].end, 198);
  const editor = oborozukiAt(194, 210);
  editor.fitToLyricGap(0, lyricSpans, null);
  assert.deepEqual([editor.chart.events[0].start, editor.chart.events[0].end], [194, 203]);
});

test('a stretched last word does not swallow the interlude', () => {
  // Eight characters 0.3 s apart from 3:10, a quarter second each; the last one "lasts" until 3:23.
  const text = '今夜サプライズを';
  const words = [...text].map((character, i) => {
    const start = 190 + i * 0.3;
    return { start, end: start + (i === 7 ? 203 - (190 + 2.1) : 0.25), text: character };
  });
  const lyrics = {
    lines: [{ start: 190, text, words },
      { start: 203, text: '魔法みたい', words: [{ start: 203, end: 203.3, text: '魔' }, { start: 203.3, end: 203.6, text: '法' }, { start: 203.6, end: 203.9, text: 'み' }] }],
  };
  // Sung until the last character starts (192.1) plus at most max(0.8, 2.5 × 0.25) s.
  assert.ok(Math.abs(suggest.lineEnds(lyrics)[0] - 192.9) < 1e-9);
  const lyricSpans = suggest.spans(lyrics);
  assert.equal(lyricSpans[0].estimated, false);
  // The interlude is found, and a MIX fitted into it starts after the line and ends before the next.
  assert.ok(suggest.gaps(lyrics, 240, null).some(gap => Math.abs(gap.start - 192.9) < 1e-9 && gap.end === 203));
  const editor = oborozukiAt(198, 200);
  editor.fitToLyricGap(0, lyricSpans, null);
  assert.deepEqual([editor.chart.events[0].start, editor.chart.events[0].end], [198, 203]);
});

// User report (2026-10-18): 「魔法みたい」 starts at 3:20.2 and the line before "ended" at 3:18.4
// in three different ways; none may move the MIX start any more.
function fitted(firstLine, mixStart) {
  const lyricSpans = suggest.spans({ lines: [firstLine, { start: 200.2, text: '魔法みたい' }] });
  const editor = oborozukiAt(mixStart, 210);
  editor.fitToLyricGap(0, lyricSpans, null);
  return { span: lyricSpans[0], start: editor.chart.events[0].start, end: editor.chart.events[0].end };
}

test('evenly stretched characters are only a guess', () => {
  // Ten characters spread evenly from 3:10 to 3:18.4 (0.84 s each): nobody sings a line that slowly.
  const text = '今夜サプライズを君に';
  const words = [...text].map((character, i) => ({ start: 190 + i * 0.84, end: 190 + i * 0.84 + 0.84, text: character }));
  const result = fitted({ start: 190, text, words }, 192);
  assert.ok(result.span.estimated);
  assert.deepEqual([result.start, result.end], [192, 200.2]);
});

test('a stretched last phrase is held at its own speed', () => {
  // Phrase-sized "words"; the last one runs 5.4 s, to 3:18.4.
  const words = [{ start: 190, end: 191.8, text: '今夜 ' }, { start: 191.2, end: 193, text: 'サプライズを' }, { start: 193, end: 198.4, text: '君に！' }];
  const result = fitted({ start: 190, text: '今夜 サプライズを君に！', words }, 197);
  // 0.45 s a character (median of 0.6 and 0.3) × 3 characters × 2.5 = 3.375 s after 3:13.
  assert.equal(result.span.estimated, false);
  assert.ok(Math.abs(result.span.end - 196.375) < 1e-9);
  assert.deepEqual([result.start, result.end], [197, 200.2]);
});

test('a line’s own length alone is only a guess', () => {
  const result = fitted({ start: 190, end: 198.4, text: '今夜 サプライズを君に！' }, 192);
  assert.ok(result.span.estimated);
  assert.deepEqual([result.start, result.end], [192, 200.2]);
});

test('word presses alone give a grid', () => {
  // Words two beats apart still give 120 BPM, not 60.
  const slow = suggest.gridFromWordPresses(Array.from({ length: 6 }, (_, i) => 10 + i));
  assert.ok(Math.abs(slow.bpm - 120) < 0.5);
  assert.equal(suggest.gridFromWordPresses([1, 2]), null);         // Two presses are not enough.
});

// From CheerShareFlowTests.swift: the built-in MIX library.
test('the MIX library is the cross-checked set, and each entry makes a valid event', () => {
  const entries = suggest.libraryEntries(library);
  assert.deepEqual(entries.map(mix => mix.id), ['standard', 'japanese', 'ainu', 'ainu-wisupe', 'chaos', 'gachikoi', 'ppph', 'encho', 'oborozuki', 'spanish', 'arabic']);
  for (const mix of entries) {
    assert.ok(mix.sources.length >= 2 && mix.sources.every(code => Object.hasOwn(library.sources, code)), mix.id);
    const value = chart({ duration: 200 });
    value.events = [{ start: 30, end: 40, kind: mix.kind, text: mix.text, members: ['m1'], ...(mix.kind === 'mix' ? { mixRef: 'tradition:' + mix.id } : {}) }];
    assert.deepEqual(validateChart(value).errors, [], mix.id);
    assert.equal(suggest.mixEntry(library, 'tradition:' + mix.id), mix);
    // As an event made from the library, with its readings, it is valid too.
    const event = suggest.mixEvent(mix, 30, 40, 'm1');
    value.events = [event];
    assertClean(value);
  }
  assert.ok(suggest.hasNameSlot(entry('gachikoi')) && !suggest.hasNameSlot(entry('standard')));
  assert.equal(suggest.mixEntry(library, 'custom:standard'), null);
  assert.equal(suggest.mixEvent(entry('gachikoi'), -1, 30, null).start, 0);
  assert.equal(suggest.mixEvent(entry('gachikoi'), 0, 30, null).members, undefined);
  assert.equal(suggest.mixEvent(entry('standard'), 0, 30, 'm1').members, undefined);
  assert.equal(suggest.mixEvent(entry('ppph'), 0, 30, 'm1').mixRef, undefined);
});

test('a library that breaks a header rule gives nothing; a bad entry is left out', () => {
  assert.deepEqual(suggest.libraryEntries(null), []);
  assert.deepEqual(suggest.libraryEntries({ ...library, license: 'MIT' }), []);
  const broken = structuredClone(library);
  broken.entries[0].bars = [6, 4];
  broken.entries[1].sources = ['C'];
  broken.entries.push({ ...structuredClone(library.entries[2]) });   // A duplicate id.
  assert.deepEqual(suggest.libraryEntries(broken).map(mix => mix.id), ['ainu', 'ainu-wisupe', 'chaos', 'gachikoi', 'ppph', 'encho', 'oborozuki', 'spanish', 'arabic']);
});

test('clock reads minutes and seconds', () => {
  assert.equal(suggest.clock(0), '0:00');
  assert.equal(suggest.clock(64.9), '1:04');
  assert.equal(suggest.clock(-3), '0:00');
  assert.equal(suggest.clock(Number.NaN), '0:00');
});
