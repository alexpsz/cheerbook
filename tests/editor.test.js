'use strict';
// lib/editor.js against the cases of Liveglow's CheerEditorTests.swift, CheerWordTapsTests.swift,
// CheerShareFlowTests.swift and the band cases of CheerPresentationTests.swift, with the same
// made-up content; plus the file writer against a file Liveglow saved, and a check that the
// browser bundle loads without Node APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheer = require('../lib/cheer');
const suggest = require('../lib/suggest');
const editorModule = require('../lib/editor');
const library = require('../spec/mix-library.json');

const {
  CheerEditor, keyFor, newChart, calibrationReaction, CALIBRATION_INTERVAL, wordTaps, wordTapLeadIn, wordTapPrompt,
  serialize, validateChart, shareOutcome, shareNote, shareOrigin, prepareForSharing, sharingOf,
  eventTitle, legibleColor, contrastOnBlack, bandItems, secondsUntilChange, accessibilityLabel, bandAnnouncements,
} = editorModule;

const songQuery = { id: 'local:1', title: 'Synthetic Anthem', artist: 'Fixture Unit', album: 'QA', duration: 200 };
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not ${expected}`);
const assertClean = chart => assert.deepEqual(validateChart(chart), { valid: true, errors: [], warnings: [] });

function editorWithMembers() {
  const editor = new CheerEditor(newChart(songQuery, 'Fixture Maker'));
  editor.addMember('Alpha', '#E4007F');
  editor.addMember('Beta', '#00A0E9');
  return editor;
}

// Stands in for lib/lyrics.js's `lyricIssues`: an event whose text holds a whole lyric line.
const lyricIssues = (chart, lyrics) => chart.events.flatMap((event, i) =>
  (typeof event.text === 'string' && lyrics.some(line => line.trim() && event.text.includes(line)) ? [{ code: 'lyricOverlap', path: `events[${i}].text` }] : []));
const share = (chart, lyrics, confirmed = false) => shareOutcome(chart, lyrics, confirmed, { lyricIssues });

// MARK: CheerEditorTests.swift

test('editor keys map digits and kinds only', () => {
  assert.deepEqual(keyFor('1'), { member: 0 });
  assert.deepEqual(keyFor('9'), { member: 8 });
  assert.equal(keyFor('M'), 'mix');
  assert.equal(keyFor('c'), 'call');
  assert.equal(keyFor('n'), 'note');
  for (const character of ['0', 'x', ' ', '１', '', '12']) assert.equal(keyFor(character), null, character);
});

test('holding a key records a span with reaction compensation', () => {
  const editor = editorWithMembers();
  assert.deepEqual(editor.chart.members.map(member => member.id), ['m1', 'm2']);
  assert.equal(editor.currentMember, 'm1');
  const pressed = editor.press({ member: 1 }, 10.15);
  const repeated = editor.press({ member: 1 }, 10.5);   // Key repeat is not a new span.
  const both = editor.press('mix', 11.15);              // Two keys at once record overlapping spans.
  assert.ok(pressed && !repeated && both);
  const mix = editor.release('mix', 14.15), part = editor.release({ member: 1 }, 20.15);
  assert.deepEqual(editor.chart.events[mix], { start: 11, end: 14, kind: 'mix', members: ['m2'] });
  assert.deepEqual(editor.chart.events[part], { start: 10, end: 20, kind: 'part', members: ['m2'] });
  // A tap gets the kind's default length; a digit without a member does nothing.
  editor.press('call', 30.15);
  const call = editor.release('call', 30.2);
  assert.deepEqual([editor.chart.events[call].start, editor.chart.events[call].end], [30, 31]);
  assert.equal(editor.press({ member: 5 }, 1), false);
  assert.equal(editor.release({ member: 5 }, 2), null);
  editor.press('note', 40);
  editor.cancelRecordings();
  assert.equal(editor.release('note', 41), null);
  assert.equal(editor.recordings.size, 0);
});

test('a member key may name the member by id', () => {
  const editor = editorWithMembers();
  assert.ok(editor.press({ member: 'm2' }, 5));
  assert.deepEqual([...editor.recordings.keys()], ['member:1']);
  assert.equal(editor.press({ member: 1 }, 6), false);   // The same key, held.
  const index = editor.release({ member: 'm2' }, 8);
  assert.deepEqual(editor.chart.events[index].members, ['m2']);
  assert.equal(editor.press({ member: 'nobody' }, 9), false);
});

test('editor times follow the file offset and stay in the song', () => {
  const editor = editorWithMembers();
  editor.edit(chart => { chart.offset = 1; });
  close(editor.fileTime(10), 10.85);
  editor.compensation = 0;
  assert.equal(editor.fileTime(-3), 0);
  assert.equal(editor.fileTime(Number.NaN), 1);
  // A tap near the end keeps its default length only up to the song's end + 5 s.
  editor.press('mix', 203);
  const index = editor.release('mix', 203.1);
  assert.equal(editor.chart.events[index].end, 205);
});

test('undo, redo and edits', () => {
  const editor = editorWithMembers();
  editor.press({ member: 0 }, 5); editor.release({ member: 0 }, 9);
  editor.press('call', 6); editor.release('call', 7);
  editor.updateEvent(1, { ...editor.chart.events[1], text: 'Hey!' });
  editor.nudge(1, { start: -0.05, end: 0.05 });
  close(editor.chart.events[1].start, 5.8);
  close(editor.chart.events[1].end, 6.9);
  assert.equal(editor.nudge(1, { start: 2 }), false);   // Would cross the end; refused without an undo step.
  close(editor.chart.events[1].start, 5.8);
  editor.undo();
  assert.equal(editor.chart.events[1].text, 'Hey!');
  close(editor.chart.events[1].start, 5.85);
  editor.undo();
  assert.equal(editor.chart.events[1].text, undefined);
  assert.ok(editor.canRedo);
  editor.redo(); editor.redo();
  close(editor.chart.events[1].start, 5.8);
  assert.ok(!editor.canRedo);
  editor.removeMember('m1');
  assert.deepEqual(editor.chart.events.map(event => event.kind), ['call']);
  assert.equal(editor.currentMember, 'm2');
  editor.removeEvent(0);
  assert.deepEqual(editor.chart.events, []);
  editor.undo();
  assert.equal(editor.chart.events.length, 1);
});

test('the chart is read-only outside edits, and edits may return a new chart', () => {
  const source = newChart(songQuery, 'Fixture Maker');
  const editor = new CheerEditor(source);
  source.song.title = 'Changed outside';
  assert.equal(editor.chart.song.title, 'Synthetic Anthem');   // The editor keeps its own copy.
  assert.throws(() => { editor.chart.events.push({}); }, TypeError);
  assert.equal(editor.edit(chart => ({ ...chart, offset: 2 })), true);
  assert.equal(editor.chart.offset, 2);
  assert.equal(editor.edit(() => {}), false);                    // No change, no undo step.
  assert.equal(editor.apply({ ...editor.chart, offset: 2 }), false);
  editor.undo();
  assert.equal(editor.chart.offset, 0);
  assert.ok(!editor.canUndo);
});

test('a new chart is the listener’s own work', () => {
  const chart = newChart(songQuery, 'Fixture Maker');
  assert.deepEqual(chart.song, { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration: 200, album: 'QA' });
  assert.equal(chart.credits.permission, 'original');
  assert.deepEqual(chart.credits.sources, [{ kind: 'self' }]);
  assert.equal(sharingOf(chart.credits), 'shareable');
  // No name is needed to keep a chart, only to share it.
  assertClean(newChart(songQuery, ''));
  assert.deepEqual(newChart(songQuery, '  ').credits.authors, []);
  assert.ok(validateChart(newChart(songQuery, ''), { sharing: true }).errors.some(found => found.code === 'authorMissing' && found.path === 'credits.authors'));
  assert.equal(newChart(songQuery, '', { generator: 'Other tool' }).generator, 'Other tool');
});

test('calibration takes the median lag', () => {
  const pulses = Array.from({ length: 10 }, (_, i) => i * CALIBRATION_INTERVAL);
  const taps = [0.18, 0.95, 1.79, 2.6, 3.4, 9.0];   // The last tap matches no pulse.
  close(calibrationReaction(taps, pulses), 0.19);
  assert.equal(calibrationReaction([0.2, 1.0, 1.8], pulses), null);
  close(calibrationReaction([0.38, 1.18, 1.98, 2.78], pulses), 0.38);
  assert.equal(calibrationReaction([0.7, 1.5, 2.3, 3.1], pulses), 0);   // Early taps clamp to 0.
});

test('sharing follows the permission and the lyrics', () => {
  const editor = editorWithMembers();
  editor.press('call', 6); editor.release('call', 7);
  editor.updateEvent(0, { ...editor.chart.events[0], text: '合成的歌词第一行' });
  const lyrics = ['合成的歌词第一行'];
  assert.deepEqual(share(editor.chart, lyrics), { kind: 'blocked', issues: [{ code: 'lyricOverlap', path: 'events[0].text' }] });
  editor.updateEvent(0, { ...editor.chart.events[0], text: 'Hey!' });
  const file = share(editor.chart, lyrics);
  assert.equal(file.kind, 'file');
  assert.deepEqual(cheer.parse(Buffer.from(file.text)).chart, editor.chart);

  editor.edit(chart => {
    chart.credits.permission = 'public-only';
    chart.credits.sources = [{ kind: 'video', title: 'Synthetic clip', url: 'https://example.com/v', retrieved: '2026-10-18' }];
  });
  const note = share(editor.chart, lyrics);
  assert.equal(note.kind, 'noteOnly');
  assert.ok(note.note.includes('视频 · Synthetic clip · https://example.com/v · 获取于 2026-10-18'));
  assert.ok(note.note.includes('授权：仅公开可见') && !note.note.includes('Hey!'));
  assert.equal(note.note, shareNote(editor.chart));
  const broken = { ...editor.chart, credits: { ...editor.chart.credits, authors: [] } };
  assert.deepEqual(share(broken, []), { kind: 'blocked', issues: [{ code: 'authorMissing', path: 'credits.authors' }] });
});

test('the share note lists the song, authors, permission and other sources', () => {
  const chart = newChart(songQuery, 'Fixture Maker');
  chart.credits = { authors: [{ name: '甲' }, { name: '乙' }], sources: [{ kind: 'self' }, { kind: 'call-sheet', url: 'https://example.com/c' }], permission: 'unknown', note: '合成说明' };
  assert.equal(shareNote(chart), [
    '映场应援 · 来源说明', '歌曲：Synthetic Anthem — Fixture Unit', '作者：甲、乙', '授权：未标明（应援数据只在制作者本机使用，此处只附来源）',
    '来源：', '- 粉丝 call 表 · https://example.com/c', '说明：合成说明', '',
  ].join('\n'));
});

test('typing into one field undoes as one step', () => {
  const editor = editorWithMembers();
  for (const name of ['A', 'Al', 'Ali']) editor.edit(chart => { chart.members[0].name = name; }, 'members[0].name');
  editor.edit(chart => { chart.members[1].name = 'B'; }, 'members[1].name');
  editor.undo();
  assert.deepEqual(editor.chart.members.map(member => member.name), ['Ali', 'Beta']);
  editor.undo();
  assert.deepEqual(editor.chart.members.map(member => member.name), ['Alpha', 'Beta']);
});

test('taps count only while the chart’s song plays', () => {
  const editor = editorWithMembers();
  assert.ok(editor.isEditing(songQuery));
  assert.ok(!editor.isEditing({ ...songQuery, title: 'Elsewhere' }) && !editor.isEditing(null));
  assert.ok(!editor.isEditing({ ...songQuery, duration: 230 }));
});

test('the editor knows unsaved work', () => {
  const editor = new CheerEditor(newChart(songQuery, 'Fixture Maker'));
  assert.ok(!editor.hasUnsavedChanges);
  editor.addMember('Alpha', '#E4007F');
  assert.ok(editor.hasUnsavedChanges);
  editor.markSaved();
  assert.ok(!editor.hasUnsavedChanges);
  editor.undo();
  assert.ok(editor.hasUnsavedChanges);
});

test('unchecked lyrics need confirmation to share', () => {
  const editor = editorWithMembers();
  editor.press('call', 6); editor.release('call', 7);
  editor.updateEvent(0, { ...editor.chart.events[0], text: 'Hey!' });
  assert.deepEqual(share(editor.chart, []), { kind: 'unchecked' });
  assert.deepEqual(share(editor.chart, ['', '  ']), { kind: 'unchecked' });
  assert.equal(share(editor.chart, [], true).kind, 'file');
  // Parts alone carry no text, so there is nothing to check.
  const partsOnly = editorWithMembers();
  partsOnly.press({ member: 0 }, 1); partsOnly.release({ member: 0 }, 5);
  assert.equal(share(partsOnly.chart, []).kind, 'file');
});

// MARK: CheerShareFlowTests.swift

function tappedChart() {
  const chart = newChart(songQuery, '');
  chart.members = [{ id: 'm1', name: 'Alpha', color: '#E4007F' }];
  chart.events = [{ start: 10, end: 20, kind: 'part', members: ['m1'] }, { start: 12, end: 13, kind: 'call', text: 'Hey!' }];
  return chart;
}

test('local copies need no name, but shared files do', () => {
  assertClean(tappedChart());
  assert.deepEqual(validateChart(tappedChart(), { sharing: true }).errors, [{ code: 'authorMissing', path: 'credits.authors' }]);
});

test('the share choice derives the permission', () => {
  const own = prepareForSharing(tappedChart(), '  灯海小队 ', { kind: 'selfMade' });
  assert.deepEqual(own.credits.authors, [{ name: '灯海小队' }]);
  assert.equal(own.credits.permission, 'original');
  assert.equal(sharingOf(own.credits), 'shareable');
  assert.equal(share(own, ['合成的歌词第一行']).kind, 'file');

  const link = 'https://example.com/clip';
  const agreed = prepareForSharing(tappedChart(), '灯海小队', { kind: 'referenced', link, consented: true });
  assert.equal(agreed.credits.permission, 'consented');
  assert.deepEqual(agreed.credits.sources, [{ kind: 'other', url: link }]);
  assert.equal(sharingOf(agreed.credits), 'shareable');

  const unsure = prepareForSharing(tappedChart(), '灯海小队', { kind: 'referenced', link, consented: false });
  assert.equal(unsure.credits.permission, 'public-only');
  assert.equal(sharingOf(unsure.credits), 'localOnly');
  const note = share(unsure, ['合成的歌词第一行']);
  assert.equal(note.kind, 'noteOnly');
  assert.ok(note.note.includes(link) && !note.note.includes('Hey!'));

  // No name, no share.
  assert.deepEqual(share(prepareForSharing(tappedChart(), ' ', { kind: 'selfMade' }), ['x']), { kind: 'blocked', issues: [{ code: 'authorMissing', path: 'credits.authors' }] });
  // An open licence stays when its author agreed; the step reads its own answers back.
  const licensed = tappedChart();
  licensed.credits = { authors: [{ name: 'A' }], sources: [{ kind: 'video', url: 'https://example.com/v' }], permission: 'open-license', license: 'CC-BY-4.0' };
  assert.deepEqual(shareOrigin(licensed.credits), { kind: 'referenced', link: 'https://example.com/v', consented: true });
  const kept = prepareForSharing(licensed, 'A', shareOrigin(licensed.credits));
  assert.equal(kept.credits.permission, 'open-license');
  assert.deepEqual(kept.credits.sources, licensed.credits.sources);
  assert.deepEqual(shareOrigin(tappedChart().credits), { kind: 'selfMade' });
  assert.deepEqual(shareOrigin(unsure.credits), { kind: 'referenced', link, consented: false });
  // The chart given is left alone.
  assert.deepEqual(licensed.credits.authors, [{ name: 'A' }]);
});

test('the share step takes lyricIssues from lib/lyrics.js unless given one', () => {
  let calls = 0;
  const counting = (chart, lyrics) => { calls++; return lyricIssues(chart, lyrics); };
  assert.equal(shareOutcome(tappedChart(), ['合成的歌词第一行'], false, { lyricIssues: counting }).kind, 'blocked');   // No author: not compared.
  assert.equal(calls, 0);
  const named = prepareForSharing(tappedChart(), 'A', { kind: 'selfMade' });
  assert.equal(shareOutcome(named, ['合成的歌词第一行'], false, { lyricIssues: counting }).kind, 'file');
  assert.equal(calls, 1);
  // Only overlaps block; other issues from the comparison are left to `cannotCheckLyrics`.
  assert.equal(shareOutcome(named, ['合成的歌词第一行'], false, { lyricIssues: () => [{ code: 'lyricsUnchecked', path: '' }] }).kind, 'file');
});

// MARK: CheerWordTapsTests.swift

const tapGrid = suggest.makeGrid(0.5, 0, 'taps');                       // 120 BPM.
const truth = Array.from({ length: 8 }, (_, i) => 194 + 0.5 * i);         // One word a beat.
const jitter = [0.03, -0.04, 0.02, 0, -0.03, 0.04, -0.02, 0.01];
const late = 0.15;                                                       // The listener's reaction time.
const presses = (times = truth) => times.map((time, i) => time + late + jitter[i % 8]);
const steps = truth.map(time => time - 194);
const synthetic = (events, offset = 0) => ({
  song: { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration: 240 }, offset, members: [], events,
  credits: { authors: [], sources: [], permission: 'original' },
});

test('word taps snap back to the beat', () => {
  const result = wordTaps(presses(), 8, late, tapGrid, null);
  assert.equal(result.start, 194);
  assert.deepEqual(result.steps, steps);
  assert.deepEqual([result.snapped, result.unsnapped, result.filled, result.dropped], [8, 0, 0, 0]);
  assert.equal(result.end, 198);   // The last word plus one average step.
  assert.equal(result.summary, '已对齐 8 个词到节拍（BPM 120）');
  assert.equal(result.gridFromPresses, false);
});

test('word taps find the tempo on their own', () => {
  const result = wordTaps(presses(), 8, late, null, null);
  assert.ok(result.gridFromPresses && Math.abs(result.grid.bpm - 120) < 1.5);
  assert.equal(result.snapped, 8);
  assert.ok(result.steps.every((step, i) => Math.abs(step - steps[i]) < 0.03));
  // Too few presses for a grid: kept as pressed.
  const two = wordTaps([10.15, 10.65], 2, late, null, null);
  assert.equal(two.grid, null);
  assert.equal(two.summary, '已记录 2 个词');
});

test('word taps leave a stray press where it was', () => {
  const stray = presses();
  stray[3] += 0.2;   // 0.2 s off a 0.5 s beat, more than a quarter beat.
  const result = wordTaps(stray, 8, late, tapGrid, null);
  assert.deepEqual([result.snapped, result.unsnapped], [7, 1]);
  close(result.steps[3], 1.5 + 0.2);
  assert.ok(result.summary.includes('1 个词偏离较大，未吸附'));
});

test('word taps handle too many or too few presses', () => {
  const more = wordTaps(presses([...truth, 198, 198.5]), 8, late, tapGrid, null);
  assert.equal(more.steps.length, 8);
  assert.equal(more.dropped, 2);
  assert.ok(more.summary.includes('多按的 2 下已忽略'));
  const fewer = wordTaps(presses().slice(0, 5), 8, late, tapGrid, null);
  assert.equal(fewer.filled, 3);
  assert.deepEqual(fewer.steps, steps);   // The rest at the average step.
  assert.ok(fewer.summary.includes('少按了 3 下'));
  assert.equal(wordTaps([], 8, late, tapGrid, null), null);
  assert.equal(wordTaps(presses(), 0, late, tapGrid, null), null);
});

test('word taps never run into the next line', () => {
  const result = wordTaps(presses(), 8, late, tapGrid, 197.75);
  assert.equal(result.end, 197.75);
  assert.equal(result.steps.at(-1), 3.5);
  // Without compensation the words would land a beat-fraction late, and snap only by luck.
  const raw = wordTaps(presses(), 8, 0, tapGrid, null);
  assert.ok(raw.snapped < 8 || raw.start !== 194);
});

test('word taps are one undo step', () => {
  const editor = new CheerEditor(synthetic([{ start: 193, end: 210, kind: 'mix', text: 'A！B！C！D！E！F！G！H！' }], 0.5), { compensation: late });
  const lyricSpans = [{ start: 186, end: 193.5, estimated: false }, { start: 203, end: 207, estimated: false }];
  const result = editor.applyWordTaps(0, presses(), tapGrid, lyricSpans);
  assert.equal(result.end, 198);
  // Chart times are playback times plus the chart's offset.
  const event = editor.chart.events[0];
  assert.deepEqual([event.start, event.end, event.steps.length, event.tapped], [194.5, 198.5, 8, true]);
  assertClean(editor.chart);
  editor.undo();
  assert.equal(editor.chart.events[0].start, 193);
  assert.equal(editor.chart.events[0].steps, undefined);
  // An event without words, or out of range, is left alone.
  assert.equal(editor.applyWordTaps(5, presses(), tapGrid, []), null);
});

test('word tapping starts from the line before', () => {
  const lyricSpans = [{ start: 190, end: 192.9, estimated: false }, { start: 203, end: 207, estimated: false }];
  assert.equal(wordTapLeadIn(198, lyricSpans, tapGrid), 189.5);
  assert.equal(wordTapLeadIn(198, lyricSpans, null), 189.4);
  assert.equal(wordTapLeadIn(230, lyricSpans, tapGrid), 229);    // The line before is 27 s back.
  assert.equal(wordTapLeadIn(1, lyricSpans, tapGrid), 0);
  const editor = new CheerEditor(synthetic([{ start: 198, end: 200, kind: 'mix', text: 'A！B！C！D！E！F！G！H！' }]), { compensation: late });
  const applied = editor.applyWordTaps(0, presses(), tapGrid, lyricSpans);
  assert.equal(applied.start, 194);
  assert.deepEqual([editor.chart.events[0].start, editor.chart.events[0].end], [194, 198]);
});

test('the tapping prompt counts in and steps', () => {
  const at = (count, position) => wordTapPrompt(count, 12, position, 194, 0.5);
  assert.deepEqual(at(0, 190), { kind: 'waiting' });
  assert.deepEqual(at(0, 193.2), { kind: 'countdown', value: 2 });
  assert.deepEqual(at(0, 193.5), { kind: 'countdown', value: 1 });
  assert.deepEqual(at(0, 193.9), { kind: 'countdown', value: 1 });
  assert.deepEqual(at(0, 194.2), { kind: 'next', index: 0 });   // Late is fine: the first word is still next.
  assert.deepEqual(at(3, 195), { kind: 'next', index: 3 });
  assert.deepEqual(at(11, 199), { kind: 'next', index: 11 });
  assert.deepEqual(at(12, 199.5), { kind: 'done' });
  assert.deepEqual(at(14, 199.5), { kind: 'done' });
  assert.deepEqual(wordTapPrompt(0, 4, 9, 10, Number.NaN), { kind: 'countdown', value: 2 });   // 0.6 s without a beat.
});

test('a tapped mark keeps its start when aligned', () => {
  const lyricSpans = [{ start: 186, end: 193.5, estimated: false }, { start: 197, end: 201, estimated: false }];   // The next line comes early.
  const editor = new CheerEditor(synthetic([
    { start: 190, end: 210, kind: 'mix', text: 'A！B！C！D！E！F！G！H！' }, { start: 220, end: 230, kind: 'mix', text: 'A！B！' },
  ]), { compensation: late });
  editor.applyWordTaps(0, presses(), tapGrid, []);   // Tapped at 194–198.
  assert.deepEqual([editor.chart.events[0].tapped, editor.chart.events[0].start, editor.chart.events[0].end], [true, 194, 198]);
  const tappedSteps = editor.chart.events[0].steps;
  // Aligning keeps the start and the words; only the end that runs into the next line comes back.
  editor.fitToLyricGap(0, lyricSpans, tapGrid);
  assert.equal(editor.chart.events[0].start, 194);
  assert.deepEqual(editor.chart.events[0].steps, tappedSteps);
  assert.equal(editor.chart.events[0].end, 197.55);   // Just after its last word.
  editor.fitAllMixToLyricGaps(lyricSpans, tapGrid);
  assert.equal(editor.chart.events[0].start, 194);
  assert.deepEqual(editor.chart.events[0].steps, tappedSteps);
  // The mark travels in the file.
  const named = { ...editor.chart, credits: { ...editor.chart.credits, authors: [{ name: 'Fixture Maker' }] } };
  const loaded = cheer.parse(Buffer.from(serialize(named)));
  assert.ok(loaded.chart.events.some(event => event.tapped === true) && loaded.chart.events.some(event => event.tapped === undefined));
  // Asked for, the start moves out of a sung line, the words spread again and the mark goes.
  editor.fitToLyricGap(0, [{ start: 190, end: 195.5, estimated: false }, { start: 203, end: 207, estimated: false }], null, { movingStart: true });
  assert.equal(editor.chart.events[0].start, 195.5);
  assert.notDeepEqual(editor.chart.events[0].steps, tappedSteps);
  assert.equal(editor.chart.events[0].tapped, undefined);
});

// MARK: CheerPresentationTests.swift (the band)

const timeline = {
  song: { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration: 60 }, offset: 0,
  members: [{ id: 'a', name: 'Alpha', color: '#E4007F' }, { id: 'b', name: 'Beta', color: '#101010' }],
  events: [
    { start: 0, end: 10, kind: 'part', members: ['a'] }, { start: 10, end: 20, kind: 'part', members: ['b'] },
    { start: 1, end: 3, kind: 'mix', text: 'Go {name}!', members: ['a'] },
    { start: 12, end: 13, kind: 'call', text: 'Hey!' },
    { start: 14, end: 16, kind: 'call', echo: true },
    { start: 30, end: 31, kind: 'note', text: 'Lights' },
  ],
  credits: { authors: [{ name: 'Fixture Maker' }], sources: [], permission: 'original' },
};
const content = { lines: [{ start: 0, text: 'L1' }, { start: 4, text: 'L2' }, { start: 11, text: 'L3' }, { start: 14, text: 'Sing along' }, { start: 17, text: 'L5' }] };
const band = (chart, time, options = {}) => bandItems(chart, time, { lyrics: content, lead: 2, library, ...options });

test('the band shows current events and singers', () => {
  const now = band(timeline, 1.5, { hint: 15 });
  assert.deepEqual(now.singers.map(singer => singer.name), ['Alpha']);
  assert.deepEqual(now.current.map(item => item.text), ['Go Alpha!']);
  assert.equal(now.current[0].label, 'MIX');
  // The call at 12 s is within a 15 s hint window; seconds stay out of the screen-reader text.
  assert.equal(now.upcoming.label, 'Call');
  assert.equal(now.countdown, 11);
  assert.ok(!now.imminent && !now.showsUpcomingText);
  assert.equal(accessibilityLabel(now), '演唱：Alpha。MIX：Go Alpha!。下一条，Call：Hey!');
  const quiet = band(timeline, 40);
  assert.ok(quiet.isEmpty);
  assert.equal(accessibilityLabel(quiet), '应援：暂无');
});

test('a sing-along shows the listener’s own lyric', () => {
  const now = band(timeline, 14.5);
  assert.deepEqual(now.current.map(item => item.label), ['跟唱']);
  assert.deepEqual(now.current.map(item => item.text), ['Sing along']);
  assert.deepEqual(band(timeline, 14.5, { lyrics: { lines: [] } }).current.map(item => item.text), ['']);
  assert.deepEqual(band(timeline, 14.5, { lyrics: null }).current.map(item => item.text), ['']);
  // Lyric lines are taken to cheer time with the chart offset and the listener's own offset.
  const shifted = { ...timeline, offset: 0.5 };
  assert.deepEqual(band(shifted, 14.5, { userOffset: 0.3 }).current.map(item => item.text), ['L3 / Sing along']);
});

test('practice preview counts down and wakes on time', () => {
  // In practice mode notes count too; the words show within the lead (at least 3 s), and it looks
  // as far ahead as its lead when that beats the everyday 5 s hint.
  assert.equal(band(timeline, 20, { practice: true }).upcoming, null);
  const early = band(timeline, 20, { practice: true, lead: 10 });
  assert.equal(early.upcoming.text, 'Lights');
  assert.equal(early.countdown, 10);
  assert.ok(early.showsUpcomingText);
  const hinted = band(timeline, 25.5, { practice: true });
  assert.equal(hinted.countdown, 5);
  assert.ok(!hinted.showsUpcomingText);
  const near = band(timeline, 27.5, { practice: true });
  assert.equal(near.countdown, 3);
  assert.ok(near.imminent && near.showsUpcomingText);
  assert.equal(accessibilityLabel(near), '提示：Lights 即将开始');
  close(secondsUntilChange(timeline, 26, { practice: true, lead: 2 }), 1);
  close(secondsUntilChange(timeline, 28.3, { practice: true, lead: 2 }), 0.7);
  close(secondsUntilChange(timeline, 28, { practice: true, lead: 2 }), 1);
  close(secondsUntilChange(timeline, 26, { practice: false, lead: 2 }), 4);
  assert.equal(secondsUntilChange(timeline, 31, { practice: true, lead: 2 }), null);
  // Outside practice mode a note is not previewed, and with nothing coming the band is empty.
  const quiet = band(timeline, 28.3);
  assert.ok(quiet.upcoming === null && quiet.isEmpty);
});

test('announcements read only newly started events', () => {
  const before = band(timeline, 0.5, { practice: true });
  const during = band(timeline, 1.5, { practice: true });
  assert.deepEqual(bandAnnouncements(before, during), ['MIX：Go Alpha!']);
  assert.deepEqual(bandAnnouncements(during, during), []);
  assert.deepEqual(bandAnnouncements(null, during), ['MIX：Go Alpha!']);
});

test('member colours are lifted until legible on the dark backdrop', () => {
  assert.ok(contrastOnBlack(legibleColor('#101010', false)) >= 3);
  assert.ok(contrastOnBlack(legibleColor('#101010', true)) >= 4.5);
  assert.equal(legibleColor('#E4007F', true), '#e4007f');
  assert.equal(legibleColor('#FFFFFF', true), '#ffffff');
  assert.equal(legibleColor('#fff'), '#ffffff');
  assert.equal(legibleColor('not a colour'), '#ffffff');
  assert.deepEqual(band(timeline, 15).singers, [{ id: 'b', name: 'Beta', color: legibleColor('#101010', false) }]);
});

const mixTimeline = {
  song: { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration: 60 }, offset: 0, members: [],
  events: [{ start: 20, end: 26, kind: 'mix', text: '有明！十六夜！朧月！' }, { start: 40, end: 44, kind: 'mix', text: 'A！B！', steps: [0, 3] }],
  credits: { authors: [], sources: [], permission: 'original' },
};

test('a MIX lights word by word', () => {
  const at = time => band(mixTimeline, time).current[0];
  assert.deepEqual(at(20.5).words, ['有明！', '十六夜！', '朧月！']);
  assert.deepEqual(at(20.5).steps, [20, 22, 24]);
  assert.equal(at(20.5).activeWord, 0);
  assert.equal(at(23.5).activeWord, 1);
  assert.equal(at(25.9).activeWord, 2);
  assert.equal(at(42).activeWord, 0);
  assert.equal(at(43.1).activeWord, 1);   // Stored steps win.
  // The band wakes for each word, and a new word is not a new event for the screen reader.
  close(secondsUntilChange(mixTimeline, 20.5, { lead: 2 }), 1.5);
  assert.deepEqual(bandAnnouncements(band(mixTimeline, 20.5), band(mixTimeline, 23.5)), []);
});

test('a countdown leads into the MIX', () => {
  const at = time => band(mixTimeline, time);
  assert.ok(at(2).isEmpty && at(14.5).isEmpty);   // Beyond 5 s: nothing drawn.
  assert.equal(at(15.5).upcoming.label, 'MIX');
  assert.equal(at(15.5).countdown, 5);
  assert.ok(!at(15.5).imminent);
  assert.ok(at(17.2).countdown === 3 && at(17.2).imminent);
  assert.equal(at(18.5).countdown, 2);
  assert.equal(at(19.9).countdown, 1);
  assert.equal(accessibilityLabel(at(18.5)), '有明！十六夜！… 即将开始');
  close(secondsUntilChange(mixTimeline, 2, { lead: 2 }), 13);   // Enters the window at 15 s.
  // The listener can ask for an earlier hint (3–15 s); below 3 the countdown still shows.
  const early = band(mixTimeline, 8, { hint: 12 });
  assert.ok(early.countdown === 12 && !early.imminent);
  assert.equal(band(mixTimeline, 17.5, { hint: 1 }).countdown, 3);
  close(secondsUntilChange(mixTimeline, 17.2, { lead: 2 }), 0.8);
});

test('the plate shows only for something to call', () => {
  const at = time => band(timeline, time);
  assert.ok(at(1.5).needsPlate);                                                   // A MIX now.
  assert.ok(at(7.5).singers.map(singer => singer.name).join() === 'Alpha' && at(7.5).needsPlate);   // A call 4.5 s ahead.
  assert.ok(at(5).singers.map(singer => singer.name).join() === 'Alpha' && !at(5).needsPlate);      // 7 s ahead is beyond the hint.
  assert.ok(!at(18).needsPlate && !at(18).isEmpty);                                // Beta sings, nothing to call.
  assert.ok(!at(40).needsPlate && at(40).isEmpty);
});

test('the countdown names the next event', () => {
  const roster = { members: [{ id: 'a', name: 'Alpha', color: '#e4007f' }] };
  const oborozuki = suggest.mixEvent(suggest.entryById(library, 'oborozuki'), 0, 16, null);
  assert.equal(eventTitle(oborozuki, roster, library), '朧月MIX');                  // The library's name.
  const ppph = suggest.mixEvent(suggest.entryById(library, 'ppph'), 0, 8, null);
  assert.equal(eventTitle(ppph, roster, library), 'PPPH');                         // A library call, by its text.
  assert.equal(eventTitle({ start: 0, end: 4, kind: 'mix', text: '有明！十六夜！朧月！', name: '我的 MIX' }, roster, library), '我的 MIX');
  assert.equal(eventTitle({ start: 0, end: 4, kind: 'mix', text: '有明！十六夜！朧月！' }, roster, library), '有明！十六夜！…');
  assert.equal(eventTitle({ start: 0, end: 4, kind: 'mix', text: '虎！火！' }, roster, library), '虎！火！');
  assert.equal(eventTitle({ start: 0, end: 1, kind: 'call', text: '{name}大好き！ずっと一緒！', members: ['a'] }, roster, library), 'Call：Alpha大好き…');
  assert.equal(eventTitle({ start: 0, end: 1, kind: 'call', echo: true }, roster, library), '跟唱');
  assert.equal(eventTitle({ start: 0, end: 1, kind: 'note', text: '' }, roster, library), '提示');
  assert.equal(eventTitle({ start: 0, end: 1, kind: 'part', members: ['a'] }, roster, library), '演唱');
  assert.equal(eventTitle({ start: 0, end: 4, kind: 'mix', text: '虎！火！', mixRef: 'tradition:standard', name: ' ' }, null, null), '虎！火！');
  // A name is for a MIX or call, short and on one line.
  const named = {
    song: { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration: 60 }, offset: 0, members: roster.members,
    events: [{ start: 1, end: 3, kind: 'mix', text: '虎！火！', name: '我的 MIX' }, { start: 4, end: 5, kind: 'note', text: 'Lights', name: 'x' },
      { start: 6, end: 7, kind: 'call', text: 'Hey!', name: '长'.repeat(33) }],
    credits: { authors: [{ name: 'Fixture Maker' }], sources: [], permission: 'original' },
  };
  assert.deepEqual(validateChart(named).errors.filter(found => found.code === 'eventName').map(found => found.path), ['events[1].name', 'events[2].name']);
  const valid = { ...named, events: named.events.slice(0, 1) };
  assert.equal(cheer.parse(Buffer.from(serialize(valid))).chart.events[0].name, '我的 MIX');
  // The band item carries the same title, and library readings with names filled.
  const item = band({ ...timeline, events: [suggest.mixEvent(suggest.entryById(library, 'gachikoi'), 0, 40, 'a')] }, 1).current[0];
  assert.equal(item.title, 'ガチ恋口上');
  assert.ok(item.text.includes('やっぱりAlphaはかわいいよ'));
  assert.equal(item.kana[1], 'やっぱりAlphaはかわいいよ');
  assert.equal(item.romaji.length, item.words.length);
});

// MARK: The file writer

const SAMPLE = path.join(__dirname, '..', 'spec', 'samples', 'valid', 'saved-by-liveglow.cheer.json');

test('serialize writes a file exactly as Liveglow saves it', () => {
  const bytes = fs.readFileSync(SAMPLE);
  const { chart } = cheer.parse(bytes);
  assert.equal(serialize(chart), bytes.toString('utf8'));
  // The editor's own chart writes the same, and events are sorted on the way out.
  const editor = new CheerEditor(chart);
  editor.edit(value => { value.events.reverse(); });
  assert.equal(serialize(editor.chart), bytes.toString('utf8'));
});

test('serialize writes numbers, empty lists and text as Swift’s JSONEncoder does', () => {
  // Expected forms checked against JSONEncoder (.prettyPrinted, .sortedKeys, .withoutEscapingSlashes) on macOS 26.
  const value = synthetic([{ start: 1e-7, end: 2 ** 53 + 2, kind: 'call', text: 'a"b\\c/d\n\t\u{1}\u{7f}\u{2028}é', steps: [0.0001, 9.99e-5, 1e16, 1e15, 123456789.123] }]);
  value.offset = -0;
  const text = serialize(value);
  assert.ok(text.includes('"members" : [\n\n  ],'));
  assert.ok(text.includes('"sources" : [\n\n    ]'));
  assert.ok(text.includes('"offset" : -0,'));
  assert.ok(text.includes('"start" : 1e-07'));
  assert.ok(text.includes('"end" : 9.007199254740994e+15'));
  assert.ok(text.includes('0.0001,\n        9.99e-05,\n        1e+16,\n        1000000000000000,\n        123456789.123\n'));
  assert.ok(text.includes(String.raw`"text" : "a\"b\\c/d\n\t\u0001` + '\u{7f}\u{2028}é"'));
  assert.ok(text.startsWith('{\n  "credits" : {') && text.endsWith('\n  "version" : 1\n}'));
  // Unknown fields are not written; null optional fields are left out.
  const extra = { ...synthetic([{ start: 1, end: 2, kind: 'note', text: 'x', mixRef: null, ui: true }]), draft: 1 };
  assert.ok(!serialize(extra).includes('ui') && !serialize(extra).includes('draft') && !serialize(extra).includes('mixRef'));
  // Numbers JSON cannot hold.
  assert.throws(() => serialize(synthetic([{ start: Number.NaN, end: 2, kind: 'note', text: 'x' }])), TypeError);
  assert.deepEqual(validateChart(synthetic([{ start: Infinity, end: 2, kind: 'note', text: 'x' }])).errors, [{ code: 'malformed', path: '' }]);
});

test('validateChart names events by their place in the chart, not sorted', () => {
  const value = synthetic([{ start: 10, end: 11, kind: 'note', text: 'ok' }, { start: 1, end: 2, kind: 'note', text: ' ' }]);
  assert.deepEqual(validateChart(value).errors, [{ code: 'textRequired', path: 'events[1].text' }]);
  const derived = synthetic([]);
  derived.credits.sources = [{ kind: 'video' }];
  assert.deepEqual(validateChart(derived).warnings, [{ code: 'derivedMarkedOriginal', path: 'credits.permission' }]);
});

// MARK: The browser bundle

test('lib/editor.js and lib/suggest.js load in a bundle without Node APIs', () => {
  const names = ['cheer', 'suggest', 'editor'];
  const sources = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(__dirname, '..', 'lib', name + '.js'), 'utf8')]));
  for (const name of ['suggest', 'editor']) {
    const code = sources[name].replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(Buffer|process|__dirname|__filename|setImmediate)\b/.test(code), name);
    for (const [, target] of code.matchAll(/require\(([^)]*)\)/g)) assert.match(target, /^'\.\/[a-z-]+'$/, `${name} requires ${target}`);
  }
  // A loader like the site's: each file a function of (module, exports, require), resolved by name.
  const context = vm.createContext({ TextEncoder, TextDecoder, URL });
  const modules = {};
  const load = name => {
    if (modules[name]) return modules[name].exports;
    const module = { exports: {} };
    modules[name] = module;
    vm.runInContext(`(function (module, exports, require) {\n${sources[name]}\n})`, context)(module, module.exports, target => load(target.replace(/^\.\//, '')));
    return module.exports;
  };
  const bundled = load('editor');
  const sample = fs.readFileSync(SAMPLE, 'utf8');
  const chart = load('cheer').parse(new TextEncoder().encode(sample)).chart;
  assert.equal(bundled.serialize(chart), sample);
  const editor = new bundled.CheerEditor(chart);
  assert.equal(editor.insertMix(load('suggest').entryById(JSON.parse(JSON.stringify(library)), 'standard'), 100, null), 7);
  assert.equal(bundled.eventTitle(editor.chart.events[7], editor.chart, library), 'スタンダードMIX');
});
