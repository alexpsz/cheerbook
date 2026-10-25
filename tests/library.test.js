'use strict';
// The community rules (lib/library.js) and tools on throw-away libraries built from synthetic
// files. Nothing here depends on what is in this repository's cheers/ or index.json: a pull
// request that adds a contribution must not make these tests fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const library = require('../lib/library');

const ROOT = path.join(__dirname, '..');
const BOM = String.fromCodePoint(0xFEFF);
const NBSP = String.fromCodePoint(0xA0);
const ACUTE = String.fromCodePoint(0x301);

function chart(overrides = {}) {
  return {
    format: 'liveglow-cheer',
    version: 1,
    song: { title: '合成曲目', artist: '合成组合', duration: 180, ...overrides.song },
    members: overrides.members || [{ id: 'a', name: '成员甲', color: '#E4007F' }],
    events: overrides.events || [{ start: 20, end: 24, kind: 'mix', text: '合成！口号！', members: ['a'] }],
    credits: { authors: [{ name: '合成作者' }], permission: 'original', ...overrides.credits },
  };
}

/** A library in a temporary directory: `files` maps paths to objects (written as JSON) or strings. */
function makeLibrary(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheerbook-test-'));
  fs.cpSync(path.join(ROOT, 'spec'), path.join(root, 'spec'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cheers'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return root;
}

const codes = result => result.problems.map(found => found.code).sort();
const HOME = 'cheers/合成组合/合成曲目/';

test('a well-formed original file in the right folder passes and is indexed under CC BY 4.0', () => {
  const result = library.checkLibrary(makeLibrary({ [HOME + '作者甲.cheer.json']: chart() }));
  assert.deepEqual(result.problems, []);
  assert.equal(result.entries.length, 1);
  const [entry] = result.entries;
  assert.equal(entry.path, HOME + '作者甲.cheer.json');
  assert.equal(entry.license, 'CC-BY-4.0');
  assert.deepEqual(entry.authors, ['合成作者']);
  assert.equal(entry.events, 1);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
});

test('format errors, local-only material and warnings are refused', () => {
  const result = library.checkLibrary(makeLibrary({
    [HOME + 'bad.cheer.json']: chart({ events: [{ start: 20, end: 24, kind: 'mix', text: '' }] }),
    [HOME + 'video.cheer.json']: chart({ credits: { permission: 'public-only', sources: [{ kind: 'video' }] } }),
    [HOME + 'derived.cheer.json']: chart({ credits: { permission: 'original', sources: [{ kind: 'call-sheet' }] } }),
    [HOME + 'unknown-kind.cheer.json']: chart({ events: [{ start: 1, end: 2, kind: 'lightstick' }] }),
  }));
  assert.deepEqual(codes(result), ['format:textRequired', 'notShareable', 'notShareable', 'warning:derivedMarkedOriginal', 'warning:unknownKind']);
  assert.equal(result.entries.length, 0);
});

test('a file must sit in the folder its song names, as a .cheer.json, without a BOM', () => {
  const result = library.checkLibrary(makeLibrary({
    'cheers/别的组合/合成曲目/x.cheer.json': chart(),
    'cheers/loose.cheer.json': chart(),
    [HOME + 'audio.mp3']: 'not audio',
    [HOME + 'bom.cheer.json']: BOM + JSON.stringify(chart({ song: { duration: 181 } })),
  }));
  assert.deepEqual(codes(result), ['bom', 'folder', 'notCheer', 'path']);
  const folder = result.problems.find(found => found.code === 'folder');
  assert.match(folder.message, /cheers\/合成组合\/合成曲目\//);
});

test('folder names drop characters no file system accepts and avoid Windows device names', () => {
  assert.equal(library.folderName('AC/DC: Live?'), 'AC_DC_ Live_');
  assert.equal(library.folderName(' 末尾的点. '), '末尾的点');
  assert.equal(library.folderName('..'), '_');
  assert.equal(library.folderName('CON'), 'CON_');
  assert.equal(library.folderName('nul.txt'), 'nul.txt_');
  assert.equal(library.folderName('a' + String.fromCodePoint(0x200B) + 'b'), 'ab');
  assert.equal(library.folderName('x'.repeat(79) + NBSP + 'tail'), 'x'.repeat(79));
  assert.equal(library.expectedFolder({ artist: 'e' + ACUTE, title: 'x' }), 'cheers/' + String.fromCodePoint(0xE9) + '/x');
});

test('names that differ only in case share a folder, and a second spelling is refused', () => {
  const upper = chart({ song: { artist: 'FIXTURE' } });
  const lower = chart({ song: { artist: 'fixture', duration: 181 } });
  const accepted = library.checkLibrary(makeLibrary({ 'cheers/FIXTURE/合成曲目/a.cheer.json': upper, 'cheers/FIXTURE/合成曲目/b.cheer.json': lower }));
  assert.deepEqual(accepted.problems, []);
  // Checked on a list: a case-insensitive file system (macOS) cannot hold both spellings.
  const collided = library.caseCollisions(['cheers/FIXTURE/合成曲目/a.cheer.json', 'cheers/fixture/合成曲目/b.cheer.json', 'cheers/FIXTURE/合成曲目/A.cheer.json']);
  assert.deepEqual(collided.map(found => [found.code, found.file]),
    [['caseCollision', 'cheers/fixture/合成曲目/b.cheer.json'], ['caseCollision', 'cheers/FIXTURE/合成曲目/A.cheer.json']]);
});

test('reserved file names, symbolic links and special files are refused', () => {
  const root = makeLibrary({ [HOME + 'nul.cheer.json']: chart(), 'outside.json': chart({ song: { duration: 181 } }) });
  fs.symlinkSync('../../../outside.json', path.join(root, HOME, 'link.cheer.json'));
  fs.symlinkSync('..', path.join(root, HOME, 'loop'));
  const result = library.checkLibrary(root);
  assert.deepEqual(codes(result), ['fileName', 'notRegularFile', 'notRegularFile']);
  assert.equal(result.entries.length, 0);
});

test('licences: only the accepted ones; open-license and consented files are shareable', () => {
  const result = library.checkLibrary(makeLibrary({
    [HOME + 'cc0.cheer.json']: chart({ credits: { license: 'CC0-1.0' }, song: { duration: 181 } }),
    [HOME + 'by-sa.cheer.json']: chart({ credits: { permission: 'open-license', license: 'CC-BY-SA-4.0', sources: [{ kind: 'call-sheet', url: 'https://example.com/sheet' }] }, song: { duration: 182 } }),
    [HOME + 'consented.cheer.json']: chart({ credits: { permission: 'consented', sources: [{ kind: 'call-sheet' }] }, song: { duration: 183 } }),
    [HOME + 'nc.cheer.json']: chart({ credits: { permission: 'open-license', license: 'CC-BY-NC-4.0' }, song: { duration: 184 } }),
  }));
  assert.deepEqual(codes(result), ['license']);
  assert.deepEqual(result.entries.map(entry => [path.basename(entry.path), entry.license]),
    [['by-sa.cheer.json', 'CC-BY-SA-4.0'], ['cc0.cheer.json', 'CC0-1.0'], ['consented.cheer.json', null]]);
});

test('long album names and long author lists are refused, so the index stays small', () => {
  const authors = Array.from({ length: 17 }, (_, i) => ({ name: '作者' + i }));
  const result = library.checkLibrary(makeLibrary({
    [HOME + 'album.cheer.json']: chart({ song: { album: '专'.repeat(201) } }),
    [HOME + 'authors.cheer.json']: chart({ credits: { authors }, song: { duration: 181 } }),
  }));
  assert.deepEqual(codes(result), ['album', 'authors']);
});

test('the same timeline twice is refused even with other credits; the same song by the same author is a notice', () => {
  const same = chart();
  const recredited = chart({ credits: { authors: [{ name: '别人' }] } });
  recredited.generator = 'Other Tool';
  const longer = chart({ events: [{ start: 20, end: 25, kind: 'mix', text: '合成！口号！', members: ['a'] }] });
  const result = library.checkLibrary(makeLibrary({ [HOME + 'a.cheer.json']: same, [HOME + 'b.cheer.json']: recredited, [HOME + 'c.cheer.json']: longer }));
  assert.deepEqual(codes(result), ['duplicate']);
  assert.equal(result.problems[0].file, HOME + 'b.cheer.json');
  assert.deepEqual(result.notices.map(found => found.code), ['sameSongSameAuthor']);
  assert.equal(result.entries.length, 2);
});

test('the MIX library that ships passes every entry rule, and broken entries are caught without crashing', () => {
  assert.deepEqual(library.checkMixLibrary(ROOT), []);
  const root = makeLibrary({});
  const file = path.join(root, 'spec', 'mix-library.json');
  const broken = JSON.parse(fs.readFileSync(file, 'utf8'));
  broken.entries[0].sources = [broken.entries[0].sources[0]];
  broken.entries[1].text = 42;
  fs.writeFileSync(file, JSON.stringify(broken));
  assert.equal(library.checkMixLibrary(root).length, 3);
});

test('the index is the same for the same library, whatever the order files were added in', () => {
  const files = { [HOME + 'a.cheer.json']: chart(), [HOME + 'b.cheer.json']: chart({ song: { duration: 181 }, credits: { authors: [{ name: '别人' }] } }) };
  const first = JSON.stringify(library.buildIndex(library.checkLibrary(makeLibrary(files)).entries));
  const reversed = Object.fromEntries(Object.entries(files).reverse());
  assert.equal(JSON.stringify(library.buildIndex(library.checkLibrary(makeLibrary(reversed)).entries)), first);
  assert.equal(JSON.parse(first).count, 2);
});

test('nothing a contributor writes can start a workflow command line', () => {
  const evil = 'z\n::error title=Maintainer approved::LGTM\n::stop-commands::hide';
  const root = makeLibrary({ [HOME + 'evil, name.cheer.json']: chart({ members: [{ id: evil, name: '甲', color: '#000000' }] }) });
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check.js'), root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
  assert.equal(run.status, 1);
  const commands = run.stdout.split('\n').filter(line => line.startsWith('::'));
  assert.ok(commands.length > 0);
  for (const line of commands) assert.match(line, /^::error file=cheers\/[^:,]*::/);
  assert.match(run.stdout, /evil%2C name/);
});

test('a pull request may not mix contributions with other changes', () => {
  const scope = input => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'scope.js')], { input, encoding: 'utf8' });
  assert.equal(scope('cheers/a/b/c.cheer.json\0lib/cheer.js\0').status, 1);
  assert.equal(scope('cheers/a/b/c.cheer.json\0cheers/a/b/d.cheer.json\0').status, 0);
  const code = scope('lib/cheer.js\0README.md\0');
  assert.equal(code.status, 0);
  assert.match(code.stdout, /逐行审查/);
});
