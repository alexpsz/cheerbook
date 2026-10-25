'use strict';
// The reader against the format's own samples (spec/README.md §12) and match cases (§8). Liveglow's
// Swift reader runs the same files, so passing here means both read every sample alike.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheer = require('../lib/cheer');

const SAMPLES = path.join(__dirname, '..', 'spec', 'samples');
const expected = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8'));
const matchCases = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'match-cases.json'), 'utf8'));

// Errors and warnings compare as sets (§12).
const asSet = issues => [...new Set((issues || []).map(found => JSON.stringify([found.code, found.path, found.detail ?? null])))].sort();

test('every sample on disk is listed in expected.json, and every listed sample exists', () => {
  const onDisk = ['valid', 'invalid'].flatMap(group => fs.readdirSync(path.join(SAMPLES, group)).map(name => group + '/' + name)).sort();
  assert.deepEqual(expected.samples.map(sample => sample.file).sort(), onDisk);
});

for (const sample of expected.samples) {
  test(`reads ${sample.file} as expected`, () => {
    const result = cheer.parse(fs.readFileSync(path.join(SAMPLES, sample.file)));
    assert.equal(result.valid, sample.valid, JSON.stringify(result.errors || result.warnings));
    if (!sample.valid) {
      assert.deepEqual(asSet(result.errors), asSet(sample.errors));
      return;
    }
    assert.deepEqual(asSet(result.warnings), asSet(sample.warnings));
    assert.equal(result.sharing, sample.sharing);
    assert.deepEqual(result.chart.events.map(event => event.start), sample.eventStarts);
    if (sample.isrc !== undefined) assert.equal(result.chart.song.isrc, sample.isrc);
  });
}

for (const [i, testCase] of matchCases.cases.entries()) {
  test(`match case ${i + 1}: ${testCase.description}`, () => {
    assert.equal(cheer.matchSong(testCase.file, testCase.playing), testCase.expected);
  });
}

test('words split after each exclamation mark and keep closing brackets with the word before', () => {
  assert.deepEqual(cheer.words('タイガー！ファイヤー！'), ['タイガー！', 'ファイヤー！']);
  assert.deepEqual(cheer.words('（合成！）甲！'), ['（合成！）', '甲！']);
  assert.deepEqual(cheer.words('甲！ ）'), ['甲！）']);
  assert.deepEqual(cheer.words('no marks here'), ['no marks here']);
  assert.deepEqual(cheer.words('  '), []);
});

test('lengths count code points and trims use the format’s white-space set', () => {
  assert.equal(cheer.length('e\u0301'), 2);
  assert.equal(cheer.length('😀'), 1);
  assert.equal(cheer.trimmed('\u200B\u0085 a \uFEFF'), 'a');
  assert.equal(cheer.isBlank('\u3000\u200B'), true);
});

// Cases the shared samples do not reach, where the Swift reader's behaviour was checked directly.
const minimal = fs.readFileSync(path.join(SAMPLES, 'valid', 'minimal.cheer.json'), 'utf8');
const withSong = song => Buffer.from(minimal.replace('"title": "合成曲目"', `"title": ${song}`));

test('text the Swift parser refuses is not JSON here either', () => {
  assert.deepEqual(cheer.parse(withSong('"\\uD800"')).errors, [{ code: 'notJSON', path: '' }]);
  assert.deepEqual(cheer.parse(withSong('"a\\uDC00b"')).errors, [{ code: 'notJSON', path: '' }]);
  assert.equal(cheer.parse(withSong('"\\uD83D\\uDE00"')).valid, true);
  const huge = Buffer.from(minimal.replace('"duration": 180', '"duration": 1e400'));
  assert.deepEqual(cheer.parse(huge).errors, [{ code: 'notJSON', path: '' }]);
});

test('names fold width, Latin diacritics and case, but keep kana voicing and compatibility digits', () => {
  const song = (title, duration = 200) => ({ title, artist: '合成组合', duration });
  assert.equal(cheer.matchSong(song('ガッコウ'), song('カッコウ')), null);
  assert.equal(cheer.matchSong(song('パン'), song('ハン')), null);
  assert.equal(cheer.matchSong(song('\uFF76\uFF9E\uFF6F\uFF7A\uFF73'), song('ガッコウ')), 'metadata');
  assert.equal(cheer.matchSong(song('\uFF23\uFF41\uFF46é'), song('cafe')), 'metadata');
  assert.equal(cheer.matchSong(song('Straße'), song('STRASSE')), 'metadata');
  assert.equal(cheer.matchSong(song('①'), song('1')), null);
});

test('splitting words stays linear on a long run of closing brackets', () => {
  const started = process.hrtime.bigint();
  const words = cheer.words('a！' + '）'.repeat(200000) + '！');
  assert.deepEqual(words.map(word => [...word].length), [200002, 1]);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e9 < 2);
});

test('dates before the Gregorian reform follow the Julian calendar, as the Swift reader does', () => {
  assert.equal(cheer.isDay('1582-10-10'), false);
  assert.equal(cheer.isDay('1582-10-15'), true);
  assert.equal(cheer.isDay('1500-02-29'), true);
  assert.equal(cheer.isDay('1900-02-29'), false);
  assert.equal(cheer.isDay('2024-02-29'), true);
});
