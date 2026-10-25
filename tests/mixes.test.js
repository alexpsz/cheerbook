'use strict';
// MIX contributions (lib/mixes.js, C-011): proposals for the built-in library and artist MIX, the
// community checks on throw-away repositories, the tool that accepts merged proposals, and how the
// editor's suggestions, inserts and the website use artist MIX. All data is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mixes = require('../lib/mixes');
const suggest = require('../lib/suggest');
const { checkLibrary, checkMixLibrary } = require('../lib/library');
const { serialize, eventTitle, validateChart } = require('../lib/editor');
const { buildSite } = require('../tools/build-site');

const ROOT = path.join(__dirname, '..');
const LIBRARY_TEXT = fs.readFileSync(path.join(ROOT, 'spec', 'mix-library.json'), 'utf8');
const library = JSON.parse(LIBRARY_TEXT);
const BOM = String.fromCodePoint(0xFEFF);

function proposal(overrides = {}) {
  return {
    format: 'cheerbook-mix-proposal', version: 1, id: 'synthetic-chant', name: '合成MIX', kind: 'mix',
    text: 'ゴウセイ！テスト！', romaji: 'Gōsei! Tesuto!', bars: [2, 4], positions: ['intro'],
    readings: { kana: ['ごうせい', 'てすと'], romaji: ['Gōsei', 'Tesuto'] },
    sources: ['https://example.org/a', 'https://example.net/b'], retrieved: '2026-10-20',
    ...overrides,
  };
}

function artistMix(overrides = {}) {
  return {
    format: 'cheerbook-artist-mix', version: 1, artist: '合成组合', id: 'fixture-call', name: '合成口号', kind: 'call',
    text: '合成！最高！', bars: [1, 2], positions: ['chorusLead'],
    credits: { authors: [{ name: '合成作者' }], permission: 'original' },
    ...overrides,
  };
}

/** A repository in a temporary directory: spec/, lib/ and tools/ copied, `files` written as JSON. */
function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheerbook-mix-'));
  for (const dir of ['spec', 'lib', 'tools', 'site']) fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(root, 'cheers'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return root;
}

const fields = problems => problems.map(found => found.field);

test('the library file keeps its own style when written back', () => {
  assert.equal(mixes.serializeLibrary(library), LIBRARY_TEXT);
  assert.deepEqual(checkMixLibrary(ROOT), []);
  // Every built-in entry meets the rules a proposal is held to.
  for (const entry of library.entries) assert.deepEqual(mixes.chantProblems(entry, true), [], entry.id);
});

test('a proposal needs the library’s fields, two pages and a real date', () => {
  assert.deepEqual(mixes.proposalProblems(proposal(), { file: 'mix/proposals/synthetic-chant.mix.json', library, today: '2026-10-26' }), []);
  const without = proposal();
  delete without.readings;
  assert.deepEqual(fields(mixes.proposalProblems(without, { library })), ['readings']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ readings: { kana: ['ごうせい', 'てすと'] } }), { library })), ['readings']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ readings: { kana: ['ごうせい'], romaji: ['Gōsei'] } }), { library })), ['readings']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ romaji: undefined }), { library })), ['romaji']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ id: 'standard' }), { library })), ['id']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ id: 'Upper' }), { library })), ['id']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ text: library.entries[0].text, readings: library.entries[0].readings }), { library })), ['text']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ sources: ['https://example.org/a'] }), { library })), ['sources']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ sources: ['https://example.org/a', 'HTTPS://EXAMPLE.ORG/a'] }), { library })), ['sources']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ sources: ['https://example.org/a', 'javascript:alert(1)'] }), { library })), ['sources']);
  // Links Liveglow's reader would refuse (and with them the whole library): white space, controls.
  for (const url of ['https://exa' + String.fromCharCode(9) + 'mple.org/', 'https://example.org/' + String.fromCharCode(1), 'https://example.org/a b']) {
    assert.deepEqual(fields(mixes.proposalProblems(proposal({ sources: ['https://example.net/b', url] }), { library })), ['sources'], JSON.stringify(url));
  }
  for (const id of ['nul', 'con', 'com1', 'lpt9']) assert.deepEqual(fields(mixes.proposalProblems(proposal({ id }), { library })), ['id'], id);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ retrieved: '2026-02-30' }), { library })), ['retrieved']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ retrieved: '2026-10-27' }), { library, today: '2026-10-26' })), ['retrieved']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ lyrics: 'x' }), { library })), ['']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ bars: [4, 2] }), { library })), ['bars']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ positions: ['intro', 'intro'] }), { library })), ['positions']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ text: '壊れた{name' }), { library })), ['text', 'readings']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal(), { file: 'mix/proposals/other.mix.json', library })), ['id']);
  assert.deepEqual(fields(mixes.proposalProblems(proposal({ format: 'liveglow-cheer' }), { library })), ['format']);
});

test('an artist MIX is credited and licensed like a cheer file', () => {
  const file = 'mix/artists/合成组合/fixture-call.mix.json';
  assert.deepEqual(mixes.artistMixProblems(artistMix(), { file, library }), []);
  // The folder follows the artist and compares without case, as cheer folders do.
  assert.deepEqual(mixes.artistMixProblems(artistMix({ artist: 'Fixture Unit' }), { file: 'mix/artists/FIXTURE UNIT/fixture-call.mix.json' }), []);
  assert.deepEqual(fields(mixes.artistMixProblems(artistMix(), { file: 'mix/artists/别的组合/fixture-call.mix.json' })), ['id']);
  // Readings are optional for a chant in any language, but must fit when given.
  assert.deepEqual(mixes.artistMixProblems(artistMix({ readings: { romaji: ['Gōsei', 'Saikō'] } }), { file }), []);
  assert.deepEqual(fields(mixes.artistMixProblems(artistMix({ readings: { romaji: ['Gōsei'] } }), { file })), ['readings']);
  assert.deepEqual(mixes.artistMixProblems(artistMix({ songs: ['合成曲目', '另一首'] }), { file }), []);
  assert.deepEqual(fields(mixes.artistMixProblems(artistMix({ songs: [] }), { file })), ['songs']);
  assert.deepEqual(fields(mixes.artistMixProblems(artistMix({ songs: ['合成曲目', '合成 曲目'] }), { file })), ['songs']);
  const credits = extra => artistMix({ credits: { authors: [{ name: '合成作者' }], permission: 'original', ...extra } });
  assert.deepEqual(fields(mixes.artistMixProblems(credits({ permission: 'public-only' }), { file })), ['credits.permission']);
  assert.deepEqual(fields(mixes.artistMixProblems(credits({ sources: [{ kind: 'video', url: 'https://example.org/v' }] }), { file })), ['credits.permission']);
  assert.deepEqual(fields(mixes.artistMixProblems(credits({ permission: 'open-license' }), { file })), ['credits.license']);
  assert.deepEqual(mixes.artistMixProblems(credits({ permission: 'open-license', license: 'CC-BY-SA-4.0', sources: [{ kind: 'other', url: 'https://example.org/s' }] }), { file }), []);
  assert.deepEqual(fields(mixes.artistMixProblems(credits({ license: 'MIT' }), { file })), ['credits.license']);
  assert.deepEqual(fields(mixes.artistMixProblems(credits({ authors: [] }), { file })), ['credits.authors']);
  assert.deepEqual(fields(mixes.artistMixProblems(credits({ authors: [{ name: '甲', email: 'x' }] }), { file })), ['credits.authors[0]']);
  assert.deepEqual(fields(mixes.artistMixProblems(artistMix({ name: '名'.repeat(33) }), { file })), ['name']);
  assert.deepEqual(fields(mixes.artistMixProblems(artistMix({ kind: 'mix', text: library.entries[0].text }), { library })), ['text']);
  assert.equal(mixes.licenseOf(artistMix().credits), 'CC-BY-4.0');
  assert.equal(mixes.licenseOf({ permission: 'consented' }), null);
});

test('files are read strictly: no byte order mark, no repeated keys, not too large', () => {
  const bytes = text => new TextEncoder().encode(text);
  assert.ok(mixes.readFile(bytes(JSON.stringify(artistMix()))).value);
  assert.match(mixes.readFile(bytes(BOM + '{}')).problems[0].message, /BOM/);
  assert.match(mixes.readFile(bytes('{"id": "a", "id": "b"}')).problems[0].message, /两次/);
  assert.match(mixes.readFile(bytes('{"id": "\\ud800"}')).problems[0].message, /代理项/);
  assert.match(mixes.readFile(bytes('{')).problems[0].message, /JSON/);
  assert.match(mixes.readFile(new Uint8Array(mixes.MAX_BYTES + 1)).problems[0].message, /KB/);
});

test('files are written in a fixed order that reads back the same', () => {
  const { credits, ...rest } = artistMix({ credits: { permission: 'original', authors: [{ url: 'https://example.org/me', name: '甲' }] } });
  const shuffled = { credits, ...rest };
  const text = mixes.serializeArtistMix(shuffled);
  assert.match(text, /^\{\n {2}"format": "cheerbook-artist-mix",\n {2}"version": 1,\n {2}"artist"/);
  assert.match(text, /"bars": \[1, 2\]/);
  assert.match(text, /"name": "甲",\n\s+"url"/);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(shuffled)));
  assert.equal(mixes.serializeProposal(JSON.parse(mixes.serializeProposal(proposal()))), mixes.serializeProposal(proposal()));
  assert.equal(mixes.suggestedID('Taigā! Faiyā! (Saibā)'), 'taiga-faiya-saiba');
  assert.equal(mixes.suggestedID('！？'), '');
  assert.equal(mixes.suggestedID('Taigā! {name}! {name:a}!'), 'taiga');
});

test('accepted proposals join the library with their pages coded', () => {
  const cited = library.sources.C;
  const next = mixes.acceptProposals(library, [
    proposal({ sources: [cited, 'https://example.org/new'] }),
    proposal({ id: 'second-chant', text: 'ニ！バンメ！', romaji: 'Ni! Banme!', readings: { kana: ['に', 'ばんめ'], romaji: ['Ni', 'Banme'] }, sources: ['https://example.org/new', 'https://example.net/other'] }),
  ]);
  assert.equal(library.entries.length + 2, next.entries.length, 'adds to the end');
  assert.notEqual(next, library);
  assert.equal(Object.keys(library.sources).length + 2, Object.keys(next.sources).length);
  const [first, second] = next.entries.slice(-2);
  assert.equal(first.sources[0], 'C', 'a page the library cites keeps its code');
  const fresh = first.sources[1];
  assert.equal(next.sources[fresh], 'https://example.org/new');
  assert.equal(second.sources[0], fresh, 'the same new page gets one code');
  assert.deepEqual(Object.keys(first), ['id', 'name', 'kind', 'text', 'romaji', 'bars', 'positions', 'sources', 'readings', 'retrieved']);
  assert.equal(first.retrieved, '2026-10-20');
  // A new page is stored as the browser resolves it: punycode host, escaped path.
  const resolved = mixes.acceptProposals(library, [proposal({ sources: ['https://例え.テスト/パス', 'https://EXAMPLE.net'] })]);
  assert.deepEqual(resolved.entries.at(-1).sources.map(code => resolved.sources[code]), ['https://xn--r8jz45g.xn--zckzah/%E3%83%91%E3%82%B9', 'https://example.net/']);
  // The players' reader (lib/suggest.js follows Liveglow's CheerMixLibrary) takes both entries.
  const usable = suggest.libraryEntries(next).map(entry => entry.id);
  assert.ok(usable.includes('synthetic-chant') && usable.includes('second-chant'));
  // Source codes run A … Z, then two letters.
  const full = { ...library, sources: Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(code => [code, `https://example.org/${code}`])) };
  assert.equal(mixes.acceptProposals(full, [proposal()]).entries.at(-1).sources[0], 'AA');
});

test('the community check covers mix/: proposals one after another, artist MIX, stray files', () => {
  const root = makeRepo({
    'mix/proposals/synthetic-chant.mix.json': proposal(),
    'mix/proposals/twin-chant.mix.json': proposal({ id: 'twin-chant' }),
    'mix/artists/合成组合/fixture-call.mix.json': artistMix(),
    'mix/artists/合成组合/same-chant.mix.json': artistMix({ id: 'same-chant' }),
    'mix/artists/合成组合/notes.txt': 'x',
    'mix/README.md': '# MIX',
  });
  const { problems, proposals, mixes: records } = checkLibrary(root);
  assert.deepEqual(proposals.map(item => item.path), ['mix/proposals/synthetic-chant.mix.json']);
  assert.deepEqual(problems.map(found => [found.file, found.code]), [
    ['mix/artists/合成组合/notes.txt', 'mixPath'],
    ['mix/proposals/twin-chant.mix.json', 'mix:text'],
    ['mix/artists/合成组合/same-chant.mix.json', 'duplicate'],
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], sha256: 'x' }, {
    path: 'mix/artists/合成组合/fixture-call.mix.json', sha256: 'x', artist: '合成组合', id: 'fixture-call', name: '合成口号', kind: 'call',
    text: '合成！最高！', authors: ['合成作者'], permission: 'original', license: 'CC-BY-4.0',
  });
});

test('a chant is either an artist MIX or a library proposal, never both', () => {
  // Accepting the proposal would turn the published artist MIX into a duplicate of the library.
  const root = makeRepo({
    'mix/artists/合成组合/fixture-call.mix.json': artistMix({ kind: 'mix', text: 'ゴウセイ！テスト！' }),
    'mix/proposals/synthetic-chant.mix.json': proposal(),
  });
  const { problems, proposals, mixes: records } = checkLibrary(root);
  assert.deepEqual(problems.map(found => [found.file, found.code]), [['mix/proposals/synthetic-chant.mix.json', 'mix:text']]);
  assert.match(problems[0].message, /艺人专属 MIX/);
  assert.equal(proposals.length, 0);
  assert.equal(records.length, 1);
  // An artist MIX is checked against the library as it will be after the pending proposals.
  const later = makeRepo({
    'mix/proposals/synthetic-chant.mix.json': proposal(),
    'mix/artists/合成组合/fixture-call.mix.json': artistMix({ kind: 'mix', text: 'ゴウセイ！テスト！', id: 'fixture-call' }),
  });
  assert.equal(checkLibrary(later).problems.length, 1);
});

test('a folder named like a contribution is refused', () => {
  const root = makeRepo({});
  fs.mkdirSync(path.join(root, 'mix', 'artists', '合成组合', 'fixture-call.mix.json'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cheers', '甲', '乙', '丙.cheer.json'), { recursive: true });
  assert.deepEqual(checkLibrary(root).problems.map(found => [found.file, found.code]), [
    ['cheers/甲/乙/丙.cheer.json', 'notRegularFile'],
    ['mix/artists/合成组合/fixture-call.mix.json', 'notRegularFile'],
  ]);
});

test('symbolic links under mix/ are refused, not followed', () => {
  const root = makeRepo({});
  fs.mkdirSync(path.join(root, 'mix', 'artists'), { recursive: true });
  fs.symlinkSync(path.join(root, 'spec'), path.join(root, 'mix', 'artists', 'link'));
  assert.deepEqual(checkLibrary(root).problems.map(found => [found.file, found.code]), [['mix/artists/link', 'notRegularFile']]);
});

test('the accept tool moves merged proposals into the library and deletes them', () => {
  const root = makeRepo({ 'mix/proposals/synthetic-chant.mix.json': proposal() });
  const tool = (...args) => spawnSync(process.execPath, [path.join(root, 'tools', 'accept-mix-proposals.js'), '--root', root, ...args], { encoding: 'utf8' });
  const dry = tool('--check');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /可以并入 1 条/);
  assert.equal(fs.readFileSync(path.join(root, 'spec', 'mix-library.json'), 'utf8'), LIBRARY_TEXT);
  const run = tool();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!fs.existsSync(path.join(root, 'mix', 'proposals', 'synthetic-chant.mix.json')));
  const written = fs.readFileSync(path.join(root, 'spec', 'mix-library.json'), 'utf8');
  assert.equal(JSON.parse(written).entries.at(-1).id, 'synthetic-chant');
  assert.equal(mixes.serializeLibrary(JSON.parse(written)), written);
  assert.deepEqual(checkLibrary(root).problems, []);
  assert.match(tool().stdout, /没有待并入/);
});

test('a proposal that clashes after both merged is left for the maintainer; the rest of the work goes on', () => {
  // Two pull requests, each green against the library of its time, merged one after the other.
  const root = makeRepo({
    'mix/proposals/synthetic-chant.mix.json': proposal(),
    'mix/proposals/twin-chant.mix.json': proposal({ id: 'twin-chant' }),
  });
  const run = spawnSync(process.execPath, [path.join(root, 'tools', 'accept-mix-proposals.js'), '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /twin-chant\.mix\.json/);
  assert.match(run.stdout, /留在原处/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'spec', 'mix-library.json'), 'utf8')).entries.at(-1).id, 'synthetic-chant');
  assert.ok(!fs.existsSync(path.join(root, 'mix', 'proposals', 'synthetic-chant.mix.json')));
  assert.ok(fs.existsSync(path.join(root, 'mix', 'proposals', 'twin-chant.mix.json')));
  // The check stays red, but the index and the site still build.
  assert.equal(spawnSync(process.execPath, [path.join(root, 'tools', 'check.js'), root], { encoding: 'utf8' }).status, 1);
  const index = spawnSync(process.execPath, [path.join(root, 'tools', 'build-index.js')], { encoding: 'utf8' });
  assert.equal(index.status, 0, index.stderr);
  assert.deepEqual(buildSite(root, path.join(root, '_site')), { entries: 0, mixes: 0 });
  // A broken library itself still stops the tool.
  fs.writeFileSync(path.join(root, 'spec', 'mix-library.json'), '{');
  assert.equal(spawnSync(process.execPath, [path.join(root, 'tools', 'accept-mix-proposals.js'), '--root', root], { encoding: 'utf8' }).status, 1);
});

test('an artist MIX applies to its artist, and to named songs only when it names them', () => {
  const all = artistMix();
  const named = artistMix({ id: 'named', songs: ['合成曲目'] });
  assert.equal(mixes.appliesTo(all, { title: '任何歌', artist: '合成组合' }), 'artist');
  assert.equal(mixes.appliesTo(all, { title: '任何歌', artist: '合成組合' }), null);
  assert.equal(mixes.appliesTo(all, { title: '任何歌', artist: '别的组合、合成组合' }), 'artist');
  assert.equal(mixes.appliesTo(all, { title: '任何歌', artist: '别的组合 feat. 合成组合' }), 'artist');
  assert.equal(mixes.appliesTo(named, { title: '合成曲目', artist: '合成组合' }), 'song');
  assert.equal(mixes.appliesTo(named, { title: '另一首', artist: '合成组合' }), null);
  const list = [
    { path: 'mix/artists/合成组合/fixture-call.mix.json', ...all },
    { path: 'mix/artists/合成组合/named.mix.json', ...named },
    { path: 'mix/artists/合成组合/broken.mix.json', ...artistMix({ id: 'broken', bars: [0, 1] }) },
    { path: 'mix/artists/别的组合/fixture-call.mix.json', ...artistMix({ artist: '别的组合' }) },
  ];
  const found = mixes.artistEntries(list, { title: '合成曲目', artist: '合成组合' });
  assert.deepEqual(found.map(entry => [entry.id, entry.match]), [['named', 'song'], ['fixture-call', 'artist']]);
  assert.equal(found[0].scope, 'artist');
  assert.deepEqual(mixes.artistEntries(null, {}), []);
});

test('an inserted artist MIX carries its own name, and suggestions offer it for its gap', () => {
  const [entry] = mixes.artistEntries([{ path: 'mix/artists/合成组合/fixture-mix.mix.json', ...artistMix({ id: 'fixture-mix', kind: 'mix', bars: [4, 4], positions: ['interlude'], readings: { romaji: ['Gōsei', 'Saikō'] } }) }], { title: '曲', artist: '合成组合' });
  const event = suggest.mixEvent(entry, 10, 18, 'm1');
  assert.equal(event.name, '合成口号');
  assert.equal(event.mixRef, undefined);
  assert.deepEqual(event.readings, { romaji: ['Gōsei', 'Saikō'] });
  const base = {
    format: 'liveglow-cheer', version: 1, song: { title: '曲', artist: '合成组合', duration: 104 }, offset: 0,
    members: [{ id: 'm1', name: 'Alpha', color: '#E4007F' }], events: [], credits: { authors: [{ name: '甲' }], sources: [], permission: 'original' },
  };
  const grid = suggest.makeGrid(0.5, 0, 'beatMap');
  const inserted = suggest.insertMix(base, entry, 50, grid, 'm1');
  const placed = inserted.chart.events[inserted.index];
  assert.equal(placed.name, '合成口号');
  assert.equal(eventTitle(placed, inserted.chart, library), '合成口号');
  assert.deepEqual(validateChart(inserted.chart).errors, []);
  assert.match(serialize(inserted.chart), /"name" : "合成口号"/);
  const line = (start, text) => ({ start, text, words: [{ start, end: start + 3.5, text }] });
  const lyrics = { lines: [line(16, 'a'), line(20, 'b'), line(24, 'c'), line(64, 'd'), line(68, 'e')] };
  const offered = suggest.suggestions(lyrics, 104, grid, base, library, { extra: [entry] });
  const interlude = offered.find(item => item.gap.kind === 'interlude');
  assert.ok(interlude.candidates.some(run => run.length === 1 && run[0].scope === 'artist'));
  const without = suggest.suggestions(lyrics, 104, grid, base, library).find(item => item.gap.kind === 'interlude');
  assert.ok(without.candidates.every(run => run.every(mix => mix.scope !== 'artist')));
  // Only where its usual places say: not for the intro, and never with no places at all.
  assert.ok(offered.find(item => item.gap.kind === 'intro').candidates.every(run => run[0].scope !== 'artist'));
  const nowhere = { ...entry, positions: [] };
  assert.ok(suggest.suggestions(lyrics, 104, grid, base, library, { extra: [nowhere] }).every(item => item.candidates.every(run => run[0] !== nowhere)));
});

test('an accepted proposal is suggested where its places say, and the built-in suggestions stay as they were', () => {
  const grid = suggest.makeGrid(0.5, 0, 'beatMap');
  const line = (start, text) => ({ start, text, words: [{ start, end: start + 3.5, text }] });
  const lyrics = { lines: [line(16, 'a'), line(20, 'b'), line(24, 'c'), line(64, 'd'), line(68, 'e')] };
  const base = {
    format: 'liveglow-cheer', version: 1, song: { title: '曲', artist: '组', duration: 104 }, offset: 0,
    members: [{ id: 'm1', name: 'Alpha', color: '#E4007F' }], events: [], credits: { authors: [{ name: '甲' }], sources: [], permission: 'original' },
  };
  // It competes like any other run: here it fits the 18-bar interlude as well as the longest ones.
  const grown = mixes.acceptProposals(library, [proposal({ positions: ['interlude'], bars: [8, 18] })]);
  const runsOf = lib => suggest.suggestions(lyrics, 104, grid, base, lib).map(item => [item.gap.kind, item.candidates.map(run => run.map(mix => mix.id).join('+'))]);
  const before = runsOf(library), after = runsOf(grown);
  assert.deepEqual(after.find(([kind]) => kind === 'intro'), before.find(([kind]) => kind === 'intro'));
  assert.ok(after.find(([kind]) => kind === 'interlude')[1].includes('synthetic-chant'));
  // PPPH (verse only) and the Arabic MIX (no places) are not in the conventional runs and stay out.
  assert.ok(before.every(([, runs]) => runs.every(run => !run.includes('ppph') && !run.includes('arabic'))));
});

test('the website lists artist MIX, publishes their files and one list for the editor', () => {
  const evil = '<b>合成</b>';
  const file = `mix/artists/${evil.replace(/[<>/]/g, '_')}/fixture-call.mix.json`;
  const root = makeRepo({ [file]: artistMix({ artist: evil, songs: ['<i>曲</i>'] }) });
  const out = path.join(root, '_site');
  assert.deepEqual(buildSite(root, out), { entries: 0, mixes: 1 });
  const page = fs.readFileSync(path.join(out, 'mix', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /<b>合成|<i>曲/);
  assert.match(page, /&lt;b&gt;合成&lt;\/b&gt;/);
  assert.match(page, /\/editor\/mix\/\?mix=/);
  assert.match(page, /\/editor\/mix\/\?type=proposal/);
  assert.ok(fs.existsSync(path.join(out, file)));
  const list = JSON.parse(fs.readFileSync(path.join(out, 'mix', 'artists.json'), 'utf8'));
  assert.equal(list.mixes.length, 1);
  assert.equal(list.mixes[0].path, file);
  assert.equal(list.mixes[0].artist, evil);
  const index = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(index.mixes[0].path, file);
  assert.match(fs.readFileSync(path.join(out, '_headers'), 'utf8'), /\/mix\/artists\/\*\n {2}Access-Control-Allow-Origin: \*/);
});

test('a pull request keeps MIX contributions apart from other changes', () => {
  const scope = input => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'scope.js')], { input, encoding: 'utf8' });
  assert.equal(scope('mix/proposals/a.mix.json\0').status, 0);
  assert.equal(scope('mix/artists/甲/a.mix.json\0cheers/a/b/c.cheer.json\0').status, 0);
  assert.equal(scope('mix/artists/甲/a.mix.json\0lib/mixes.js\0').status, 1);
  assert.equal(scope('mix/proposals/a.mix.json\0spec/mix-library.json\0').status, 1);
  assert.equal(scope('mix/artists/甲/a.mix.json\0contributors.json\0').status, 1);
  assert.match(scope('contributors.json\0').stdout, /逐行审查/);
});

test('a damaged contributors.json fails the check', () => {
  const ok = makeRepo({ 'contributors.json': { format: 'cheerbook-contributors', version: 1, files: {} } });
  assert.deepEqual(checkLibrary(ok).problems, []);
  const broken = makeRepo({ 'contributors.json': '{"format": "cheerbook-contributors", "version": 1, "files": {"cheers/a/b/c.cheer.json": {"id": "x"}}}' });
  assert.deepEqual(checkLibrary(broken).problems.map(found => [found.file, found.code]), [['contributors.json', 'contributors']]);
});
