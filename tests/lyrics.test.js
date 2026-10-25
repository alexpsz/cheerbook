'use strict';
// Lyrics for the web editor (lib/lyrics.js): LRC and plain text, the §10 content-layer lyric check
// ported from Liveglow's CheerLyricsGuard tests, and the LRCLIB helpers. Every line of "lyrics"
// here is invented for the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const lyrics = require('../lib/lyrics');

const BOM = String.fromCodePoint(0xFEFF);
const plainObject = value => JSON.parse(JSON.stringify(value));

test('parseLRC reads every stamp form and keeps lines sorted', () => {
  const { lines, warnings } = lyrics.parseLRC([
    '[00:05:50]five and a half',
    '[00:01]one',
    '[00:02.5]two and a half',
    '[00:03.25]three and a quarter',
    '[00:04.125]four and an eighth',
    '[1:02.00]sixty-two',
    '[100:00.00]six thousand',
  ].join('\n'));
  assert.deepEqual(warnings, []);
  assert.deepEqual(lines.map(line => [line.start, line.text]), [
    [1, 'one'], [2.5, 'two and a half'], [3.25, 'three and a quarter'], [4.125, 'four and an eighth'],
    [5.5, 'five and a half'], [62, 'sixty-two'], [6000, 'six thousand'],
  ]);
  assert.ok(lines.every(line => line.end === undefined && line.words === undefined));
});

test('parseLRC repeats a line for each of its stamps, keeping file order for equal starts', () => {
  const { lines } = lyrics.parseLRC('[00:30.00][00:10.00]Paper lanterns rise\n[00:10.00]Second voice at ten\n[00:20.00]Harbor of glass');
  assert.deepEqual(lines.map(line => [line.start, line.text]), [
    [10, 'Paper lanterns rise'], [10, 'Second voice at ten'], [20, 'Harbor of glass'], [30, 'Paper lanterns rise'],
  ]);
});

test('parseLRC applies [offset] with the LRC sign and clamps at zero', () => {
  const earlier = lyrics.parseLRC('[offset:+500]\n[00:00.20]first\n[00:10.00]second').lines;
  assert.deepEqual(earlier.map(line => line.start), [0, 9.5]);
  const later = lyrics.parseLRC('[00:10.00]second\n[offset:-250]').lines;
  assert.deepEqual(later.map(line => line.start), [10.25]);
  const plainNumber = lyrics.parseLRC('[offset:1200]\n[00:10.00]x').lines;
  assert.deepEqual(plainNumber.map(line => line.start), [8.8]);
});

test('parseLRC reads metadata and reports what it does not understand', () => {
  const result = lyrics.parseLRC([
    '[ti:Synthetic Anthem]', '[AR: Fixture Unit ]', '[al:Test Album]', '[by:Fixture Maker]', '[length: 03:25.50]',
    '[re:Some Editor]', '[ve:1.0]', '[offset:soon]',
    'a line without a stamp',
    '[00:1x.00]broken stamp',
    '[Chorus]',
    '[00:12.00]Lanterns over water',
  ].join('\n'));
  assert.deepEqual(result.meta, { ti: 'Synthetic Anthem', ar: 'Fixture Unit', al: 'Test Album', by: 'Fixture Maker', length: 205.5 });
  assert.deepEqual(result.warnings, [
    { line: 6, code: 'unknownTag', detail: 're' },
    { line: 7, code: 'unknownTag', detail: 've' },
    { line: 8, code: 'badOffset' },
    { line: 9, code: 'untimedLine' },
    { line: 10, code: 'badTime' },
    { line: 11, code: 'untimedLine' },
  ]);
  assert.deepEqual(result.lines, [{ start: 12, text: 'Lanterns over water' }]);
  assert.equal(lyrics.parseLRC('[length:245]').meta.length, 245);
  assert.deepEqual(lyrics.parseLRC('[length:long]').warnings, [{ line: 1, code: 'badLength' }]);
});

test('parseLRC lets a blank timed line end the line before it', () => {
  const { lines } = lyrics.parseLRC('[00:01.00]Morning tide\n[00:04.00]\n[00:06.00]Evening tide\n[00:09.00]Night tide\n[00:12.50]  ');
  assert.deepEqual(plainObject(lines), [
    { start: 1, end: 4, text: 'Morning tide' },
    { start: 6, text: 'Evening tide' },
    { start: 9, end: 12.5, text: 'Night tide' },
  ]);
});

test('parseLRC reads enhanced word timing', () => {
  const { lines } = lyrics.parseLRC([
    '[00:10.00]<00:10.00>Lan<00:10.40>tern <00:10.80>light<00:11.60>',
    '[00:12.00]Over <00:12.50>the <00:13.00>bay',
    '[00:15.00]<00:15.00>Quiet<00:15.50> <00:15.70>hum',
    '[00:17.00]',
  ].join('\n'));
  assert.deepEqual(plainObject(lines), [
    { start: 10, end: 11.6, text: 'Lantern light', words: [
      { start: 10, end: 10.4, text: 'Lan' }, { start: 10.4, end: 10.8, text: 'tern ' }, { start: 10.8, end: 11.6, text: 'light' },
    ] },
    // The segment before the first word stamp starts with the line; the last word ends at the next line.
    { start: 12, end: 15, text: 'Over the bay', words: [
      { start: 12, end: 12.5, text: 'Over ' }, { start: 12.5, end: 13, text: 'the ' }, { start: 13, end: 15, text: 'bay' },
    ] },
    // A stamp before a space ends the word; the blank line at 17 s ends the last one.
    { start: 15, end: 17, text: 'Quiet hum', words: [
      { start: 15, end: 15.5, text: 'Quiet ' }, { start: 15.7, end: 17, text: 'hum' },
    ] },
  ]);
  for (const line of lines) assert.equal(line.words.map(word => word.text).join(''), line.text);
});

test('parseLRC shifts word times for repeated stamps and leaves the last word open at the end', () => {
  const { lines } = lyrics.parseLRC('[00:10.00][00:40.00]<00:10.00>Echo <00:10.50>again\n[offset:+100]');
  assert.deepEqual(plainObject(lines), [
    { start: 9.9, end: 39.9, text: 'Echo again', words: [{ start: 9.9, end: 10.4, text: 'Echo ' }, { start: 10.4, end: 39.9, text: 'again' }] },
    { start: 39.9, text: 'Echo again', words: [{ start: 39.9, end: 40.4, text: 'Echo ' }, { start: 40.4, text: 'again' }] },
  ]);
});

test('parseLRC accepts CRLF, CR and a leading BOM', () => {
  const crlf = lyrics.parseLRC(BOM + '[ti:Synthetic]\r\n[00:01.00]one\r\n[00:02.00]two\r[00:03.00]three\r\n');
  assert.deepEqual(crlf.meta, { ti: 'Synthetic' });
  assert.deepEqual(crlf.lines.map(line => line.text), ['one', 'two', 'three']);
  assert.deepEqual(crlf.warnings, []);
});

test('parseLRC never throws on odd text, only on a non-string', () => {
  const odd = ['', '[', ']]]', '[00:01.00', '[]', '[:]', '<00:01.00>', '[00:01.00]<00:01.00>', '[00:01.00]<bad>text<00:0x>',
    '[00:01.00][ti:x]text', '[99999999999:59.999]far', '[00:01.00]' + '<00:01.00>'.repeat(3) + 'a'];
  for (const text of odd) assert.doesNotThrow(() => lyrics.parseLRC(text), text);
  assert.deepEqual(lyrics.parseLRC('[00:01.00]<bad>text<00:0x>').lines.map(line => line.text), ['<bad>text<00:0x>']);
  assert.deepEqual(lyrics.parseLRC('[00:01.00][ti:x]text').lines.map(line => line.text), ['[ti:x]text']);
  assert.deepEqual(lyrics.parseLRC('[00:01.00]<00:01.00>').lines, []);
  assert.throws(() => lyrics.parseLRC(null), TypeError);
  assert.throws(() => lyrics.parsePlain(42), TypeError);
});

test('parsePlain keeps the text, one stanza break per run of blank lines', () => {
  const result = lyrics.parsePlain(BOM + '\r\n  Paper lanterns rise \r\nHarbor of glass\r\n\r\n\r\nSecond verse\n\n');
  assert.deepEqual(result, { lines: [{ text: 'Paper lanterns rise' }, { text: 'Harbor of glass' }, { text: '' }, { text: 'Second verse' }], meta: {}, warnings: [] });
  assert.deepEqual(lyrics.parsePlain('').lines, []);
});

// The chart Liveglow's CheerChartTests builds: members a (Alpha) and b (Beta).
function chart(events, note) {
  return {
    song: { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration: 200 },
    offset: 0,
    members: [{ id: 'a', name: 'Alpha', color: '#E4007F' }, { id: 'b', name: 'Beta', color: '#00A0E9' }],
    events,
    credits: { authors: [{ name: 'Fixture Maker' }], sources: [], permission: 'original', ...(note === undefined ? {} : { note }) },
  };
}

// Ported from CheerChartTests.cheerLyricsGuardFlagsCopiedLinesNotShortShouts.
test('lyricIssues flags copied lines, not short shouts', () => {
  const lines = ['合成的歌词第一行', 'We sing a synthetic chorus tonight', 'Hi'];
  const sample = chart([
    { start: 1, end: 2, kind: 'call', text: 'Hi! Hi!' },
    { start: 3, end: 4, kind: 'call', text: '成的歌词' },
    { start: 5, end: 6, kind: 'call', text: '歌词' },
    { start: 7, end: 8, kind: 'note', text: 'SYNTHETIC CHORUS!' },
    { start: 9, end: 10, kind: 'mix', text: '{name} chorus', members: ['a'] },
    { start: 11, end: 12, kind: 'call', echo: true },
  ], 'from: we sing a synthetic');
  assert.deepEqual(lyrics.lyricIssues(sample, lines), [
    { code: 'lyricOverlap', path: 'events[1].text' }, { code: 'lyricOverlap', path: 'events[3].text' }, { code: 'lyricOverlap', path: 'credits.note' },
  ]);
  // Liveglow's overlaps() finds nothing without lyrics; its cannotCheck() then makes it "unchecked".
  assert.deepEqual(lyrics.lyricIssues(sample, []), [{ code: 'lyricsUnchecked', path: '' }]);
});

// Ported from CheerReadingsTests.cheerReadingsAreCheckedForLyricsToo.
test('lyricIssues checks readings too', () => {
  const event = { start: 2, end: 6, kind: 'call', text: 'Go！', readings: { kana: ['きみのなまえをよぶよ'] } };
  assert.deepEqual(lyrics.lyricIssues(chart([event]), ['きみのなまえをよぶよ']).map(found => found.path), ['events[0].readings']);
  const romaji = { start: 2, end: 6, kind: 'call', text: 'Go！', readings: { kana: [''], romaji: ['Kimi no', 'namae'] } };
  assert.deepEqual(lyrics.lyricIssues(chart([romaji]), ['kimi no namae wo yobu']).map(found => found.path), ['events[0].readings']);
});

// Ported from CheerEditorTests (sharing, import preview, unchecked lyrics) and CheerShareFlowTests.
test('lyricIssues follows the share and import cases of Liveglow', () => {
  const copied = chart([{ start: 6, end: 7, kind: 'call', text: '合成的歌词第一行' }]);
  assert.deepEqual(lyrics.lyricIssues(copied, ['合成的歌词第一行']), [{ code: 'lyricOverlap', path: 'events[0].text' }]);
  const hey = chart([{ start: 10, end: 20, kind: 'part', members: ['a'] }, { start: 12, end: 13, kind: 'call', text: 'Hey!' }]);
  assert.deepEqual(lyrics.lyricIssues(hey, ['合成的歌词第一行']), []);
  // No lyrics, or none long enough to compare, is not a pass.
  assert.deepEqual(lyrics.lyricIssues(hey, []), [{ code: 'lyricsUnchecked', path: '' }]);
  assert.deepEqual(lyrics.lyricIssues(hey, ['', '  ']), [{ code: 'lyricsUnchecked', path: '' }]);
  assert.deepEqual(lyrics.lyricIssues(hey, ['x']), [{ code: 'lyricsUnchecked', path: '' }]);
  // Parts and sing-along calls carry no text, so there is nothing to check.
  const partsOnly = chart([{ start: 1, end: 5, kind: 'part', members: ['a'] }, { start: 6, end: 7, kind: 'call', echo: true }]);
  assert.deepEqual(lyrics.lyricIssues(partsOnly, []), []);
  // The note alone is text.
  assert.deepEqual(lyrics.lyricIssues(chart([], 'tapped by ear'), []), [{ code: 'lyricsUnchecked', path: '' }]);
});

test('lyricIssues weighs CJK as two, folds case and width, and drops name slots and tags', () => {
  const lines = ['<b>Lantern</b> 星の海を渡る', 'drifting synthetic harbor'];
  const issues = texts => lyrics.lyricIssues(chart(texts.map((text, i) => ({ start: i, end: i + 1, kind: 'call', text }))), lines);
  assert.deepEqual(issues(['星の海を']), [{ code: 'lyricOverlap', path: 'events[0].text' }]);   // 4 × 2 = 8
  assert.deepEqual(issues(['星の海']), []);                                                    // 6
  assert.deepEqual(issues(['n星の海']), []);                                                   // "n" is not next to 星 in the line
  assert.deepEqual(issues(['tern星の海']), [{ code: 'lyricOverlap', path: 'events[0].text' }]); // tags dropped, space removed: 4 + 6
  assert.deepEqual(issues(['ＳＹＮＴＨＥＴＩＣ']), [{ code: 'lyricOverlap', path: 'events[0].text' }]);
  assert.deepEqual(issues(['Drift-ing!']), [{ code: 'lyricOverlap', path: 'events[0].text' }]);
  assert.deepEqual(issues(['drift']), []);
  // Slots are removed, not filled: "{name:a} harbor" is "harbor" (6), never "Alpha harbor".
  const slotted = chart([{ start: 0, end: 1, kind: 'mix', text: '{name:a} harbor', members: ['a'] }]);
  assert.deepEqual(lyrics.lyricIssues(slotted, ['Alpha harbor lights']), []);
  // The pieces around a slot are joined by a space, which normalizing removes.
  const split = chart([{ start: 0, end: 1, kind: 'mix', text: 'drif{name:a}ting', members: ['a'] }]);
  assert.deepEqual(lyrics.lyricIssues(split, lines), [{ code: 'lyricOverlap', path: 'events[0].text' }]);
  // Lines may be parsed lyric lines; the event index is the chart's own order.
  const parsed = lyrics.parseLRC('[00:01.00]drifting synthetic harbor').lines;
  const later = chart([{ start: 9, end: 10, kind: 'note', text: 'ok' }, { start: 1, end: 2, kind: 'call', text: 'synthetic harbor' }]);
  assert.deepEqual(lyrics.lyricIssues(later, parsed), [{ code: 'lyricOverlap', path: 'events[1].text' }]);
});

test('lyricIssues tolerates a half-built chart', () => {
  assert.deepEqual(lyrics.lyricIssues({}, ['drifting synthetic harbor']), []);
  assert.deepEqual(lyrics.lyricIssues(null, null), []);
  const odd = { events: [null, { text: null }, { text: 'drifting', readings: { kana: null, romaji: [7] } }], credits: { note: null } };
  assert.deepEqual(lyrics.lyricIssues(odd, ['drifting synthetic harbor']), [{ code: 'lyricOverlap', path: 'events[2].text' }]);
});

test('lrclibGetURL and lrclibSearchURL build encoded addresses', () => {
  assert.equal(lyrics.lrclibGetURL({ title: ' Synthetic Anthem ', artist: 'Fixture & Unit', duration: 199.6 }),
    'https://lrclib.net/api/get?track_name=Synthetic%20Anthem&artist_name=Fixture%20%26%20Unit&duration=200');
  assert.equal(lyrics.lrclibGetURL({ title: '星の海', artist: 'ユニット', album: 'A/B?', duration: 180 }),
    'https://lrclib.net/api/get?track_name=%E6%98%9F%E3%81%AE%E6%B5%B7&artist_name=%E3%83%A6%E3%83%8B%E3%83%83%E3%83%88&album_name=A%2FB%3F&duration=180');
  assert.equal(lyrics.lrclibGetURL({ title: 'x', artist: ' ', duration: 180 }), null);
  assert.equal(lyrics.lrclibGetURL({ title: 'x', artist: 'y' }), null);
  assert.equal(lyrics.lrclibGetURL({ title: 'x', artist: 'y', duration: 0.4 }), null);
  assert.equal(lyrics.lrclibGetURL(), null);
  assert.equal(lyrics.lrclibSearchURL({ title: 'Synthetic Anthem', artist: 'Fixture Unit' }),
    'https://lrclib.net/api/search?track_name=Synthetic%20Anthem&artist_name=Fixture%20Unit');
  assert.equal(lyrics.lrclibSearchURL({ title: 'Synthetic Anthem' }), 'https://lrclib.net/api/search?track_name=Synthetic%20Anthem');
  assert.equal(lyrics.lrclibSearchURL({ title: '' }), null);
});

const record = (fields) => ({
  trackName: 'Synthetic Anthem', artistName: 'Fixture Unit', albumName: 'Test Album', duration: 200, instrumental: false,
  plainLyrics: 'Paper lanterns rise', syncedLyrics: '[00:01.00]Paper lanterns rise', ...fields,
});

test('pickLRCLIB takes the same song by normalized names and duration', () => {
  const song = { title: 'Synthetic Anthem', artist: 'Fixture Unit', duration: 200 };
  const wrongArtist = record({ artistName: 'Other Unit' });
  const tooLong = record({ duration: 203.5 });
  const plainOnly = record({ duration: 201, syncedLyrics: null });
  const synced = record({ trackName: 'ＳＹＮＴＨＥＴＩＣ ANTHEM', artistName: 'fixture-unit', duration: 202.5 });
  const closer = record({ duration: 199 });
  assert.equal(lyrics.pickLRCLIB([wrongArtist, tooLong, plainOnly, synced], song), synced);
  assert.equal(lyrics.pickLRCLIB([wrongArtist, synced, closer], song), closer);
  assert.equal(lyrics.pickLRCLIB([plainOnly, record({ instrumental: true, plainLyrics: null, syncedLyrics: null })], song), plainOnly);
  assert.equal(lyrics.pickLRCLIB([wrongArtist, tooLong], song), null);
  // 1.5 % of a long song is more than 3 s.
  const long = { ...song, duration: 400 };
  assert.ok(lyrics.pickLRCLIB([record({ duration: 405.9 })], long));
  assert.equal(lyrics.pickLRCLIB([record({ duration: 406.1 })], long), null);
  // Nothing to compare: no match rather than a wrong one.
  assert.equal(lyrics.pickLRCLIB([record({})], { ...song, duration: 0 }), null);
  assert.equal(lyrics.pickLRCLIB([record({})], { ...song, artist: '!!' }), null);
  assert.equal(lyrics.pickLRCLIB([record({ duration: null }), null, 'x', record({ trackName: 7 })], song), null);
  assert.equal(lyrics.pickLRCLIB({ error: 'busy' }, song), null);
});

test('fromLRCLIB reads the fields the editor uses', () => {
  assert.deepEqual(lyrics.fromLRCLIB(record({})), {
    synced: '[00:01.00]Paper lanterns rise', plain: 'Paper lanterns rise', instrumental: false, duration: 200,
    title: 'Synthetic Anthem', artist: 'Fixture Unit', album: 'Test Album',
  });
  assert.deepEqual(lyrics.fromLRCLIB(record({ instrumental: true, plainLyrics: null, syncedLyrics: '  ', albumName: '' })), {
    synced: null, plain: null, instrumental: true, duration: 200, title: 'Synthetic Anthem', artist: 'Fixture Unit', album: null,
  });
  const empty = { synced: null, plain: null, instrumental: false, duration: null, title: null, artist: null, album: null };
  for (const odd of [null, undefined, 'text', [], { duration: -1, instrumental: 'yes' }]) assert.deepEqual(lyrics.fromLRCLIB(odd), empty);
  const reply = lyrics.fromLRCLIB(record({}));
  assert.deepEqual(lyrics.parseLRC(reply.synced).lines, [{ start: 1, text: 'Paper lanterns rise' }]);
});
