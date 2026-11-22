'use strict';
// contributors.json and automatic merge of new contributions (lib/contributors.js),
// the record tool on throw-away git repositories, and the security properties of the two workflows
// that use them. Synthetic accounts and files only: nothing here reads this repository's
// contributors.json, cheers/ or mix/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contributors = require('../lib/contributors');

const ROOT = path.join(__dirname, '..');
const FAN = { id: 101, login: 'fan-a' };
const OTHER = { id: 202, login: 'fan-b' };
const MAINTAINER = { id: 1, login: 'synthetic-maintainer' };
const ONE = 'cheers/合成组合/合成曲目/作者甲.cheer.json';
const TWO = 'cheers/合成组合/合成曲目/作者乙.cheer.json';
const MOVED = 'cheers/合成组合/改过的曲名/作者甲.cheer.json';
const MIX = 'mix/artists/合成组合/口号.mix.json';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const LINE = String.fromCharCode(10);

const model = (files, recordedThrough) => recordedThrough === undefined
  ? { format: 'cheerbook-contributors', version: 1, files }
  : { format: 'cheerbook-contributors', version: 1, recordedThrough, files };
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------------------------------------
// The model

test('an absent contributors.json is an empty model; the text has a fixed key order, sorted files, 2-space JSON and a final newline', () => {
  assert.deepEqual(contributors.readContributors(null), model({}));
  assert.deepEqual(contributors.readContributors(undefined), model({}));
  assert.equal(contributors.serializeContributors(contributors.emptyContributors()),
    '{\n  "format": "cheerbook-contributors",\n  "version": 1,\n  "files": {}\n}\n');
  const text = JSON.stringify({ files: { [MIX]: FAN, [ONE]: { login: FAN.login, id: FAN.id }, [TWO]: OTHER }, recordedThrough: SHA_A, version: 1, format: 'cheerbook-contributors' });
  const out = contributors.serializeContributors(contributors.readContributors(text));
  assert.equal(out, [
    '{',
    '  "format": "cheerbook-contributors",',
    '  "version": 1,',
    `  "recordedThrough": "${SHA_A}",`,
    '  "files": {',
    `    "${TWO}": {`,
    '      "id": 202,',
    '      "login": "fan-b"',
    '    },',
    `    "${ONE}": {`,
    '      "id": 101,',
    '      "login": "fan-a"',
    '    },',
    `    "${MIX}": {`,
    '      "id": 101,',
    '      "login": "fan-a"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'));
  assert.equal(contributors.serializeContributors(contributors.readContributors(out)), out);
  assert.deepEqual(contributors.contributorOf(contributors.readContributors(out), ONE), FAN);
  assert.equal(contributors.contributorOf(contributors.readContributors(out), 'cheers/x/y/z.cheer.json'), null);
  assert.equal(contributors.contributorOf(contributors.readContributors(out), 'constructor'), null);
});

test('a damaged contributors.json is refused with a clear error instead of being read as "nobody"', () => {
  const record = (files, extra = {}) => JSON.stringify({ format: 'cheerbook-contributors', version: 1, files, ...extra });
  const bad = [
    '',
    'not json',
    '[]',
    'null',
    JSON.stringify({ format: 'cheerbook-index', version: 1, files: {} }),
    JSON.stringify({ format: 'cheerbook-contributors', version: 2, files: {} }),
    record({}, { note: 'x' }),
    record({}, { recordedThrough: 'abc123' }),
    record({}, { recordedThrough: 'HEAD' }),
    record({}, { recordedThrough: null }),
    JSON.stringify({ format: 'cheerbook-contributors', version: 1, files: [] }),
    JSON.stringify({ format: 'cheerbook-contributors', version: 1 }),
    record({ 'README.md': FAN }),
    record({ 'cheers/../lib/x.cheer.json': FAN }),
    record({ 'cheers/a/b/c.json': FAN }),
    record({ 'mix/proposals/x.mix.json': FAN }),
    '{"format": "cheerbook-contributors", "version": 1, "files": {"__proto__": {"id": 101, "login": "fan-a"}}}',
    record({ [ONE]: { id: 0, login: 'fan-a' } }),
    record({ [ONE]: { id: '101', login: 'fan-a' } }),
    record({ [ONE]: { id: 1.5, login: 'fan-a' } }),
    record({ [ONE]: { id: 101, login: 'has space' } }),
    record({ [ONE]: { id: 101, login: '' } }),
    record({ [ONE]: { id: 101 } }),
    record({ [ONE]: { id: 101, login: 'fan-a', email: 'fan@example.com' } }),
    record({ [ONE]: [101, 'fan-a'] }),
  ];
  for (const text of bad) {
    assert.throws(() => contributors.readContributors(text), error => error.code === 'invalidContributors' && /^contributors\.json /.test(error.message), text);
  }
  assert.throws(() => contributors.readContributors(Buffer.from('{}')), error => error.code === 'invalidContributors');
  assert.throws(() => contributors.serializeContributors(model({ [ONE]: { id: -1, login: 'x' } })), error => error.code === 'invalidContributors');
  // GitHub app accounts end in [bot].
  assert.equal(contributors.readContributors(record({ [ONE]: { id: 41898282, login: 'github-actions[bot]' } })).files[ONE].login, 'github-actions[bot]');
});

test('only .cheer.json files under cheers/ and .mix.json files under mix/artists/ are contributions', () => {
  for (const file of [ONE, MIX, MOVED, 'cheers/a/b/c.cheer.json', 'mix/artists/a.mix.json']) assert.ok(contributors.isContributionPath(file), file);
  for (const file of ['cheers/README.md', 'cheers/.cheer.json', 'mix/artists/a.cheer.json', 'mix/proposals/a.mix.json', 'mix/a.mix.json',
    'spec/mix-library.json', 'contributors.json', 'index.json', 'cheers//a.cheer.json', 'cheers/../lib/x.cheer.json', 'cheers/./a.cheer.json',
    './cheers/a.cheer.json', '/cheers/a.cheer.json', 'Cheers/a.cheer.json', 'cheers/a\\b.cheer.json', `cheers/a${LINE}b.cheer.json`,
    '.github/workflows/check.yml', null, 42, undefined]) {
    assert.equal(contributors.isContributionPath(file), false, String(file));
  }
});

// ---------------------------------------------------------------------------------------------
// Recording merged commits

test('a merged commit credits each new contribution file to its contributor, unless it is already recorded', () => {
  const start = model({ [TWO]: OTHER }, SHA_A);
  const { model: next, actions } = contributors.recordChanges(start, [
    { status: 'added', path: ONE },
    { status: 'added', path: MIX },
    { status: 'added', path: TWO },
    { status: 'added', path: 'README.md' },
    { status: 'added', path: 'mix/proposals/口号.mix.json' },
    { status: 'added', path: 'cheers/README.md' },
    { status: 'modified', path: TWO },
    { status: 'modified', path: 'cheers/x/y/unrecorded.cheer.json' },
  ], FAN);
  assert.deepEqual(next, model({ [TWO]: OTHER, [ONE]: FAN, [MIX]: FAN }, SHA_A));
  assert.deepEqual(Object.keys(next.files), [TWO, ONE, MIX]);
  assert.deepEqual(actions.map(found => [found.action, found.path, found.id]), [['add', ONE, 101], ['add', MIX, 101]]);
  assert.deepEqual(start, model({ [TWO]: OTHER }, SHA_A), 'the input is not changed');
});

test('a removal drops the record, a rename moves it, and a rename never creates one', () => {
  const start = model({ [ONE]: FAN, [TWO]: OTHER, [MIX]: FAN });
  const { model: next, actions } = contributors.recordChanges(start, [
    { status: 'renamed', previousPath: ONE, path: MOVED },
    { status: 'removed', path: TWO },
    { status: 'renamed', previousPath: MIX, path: 'mix/proposals/口号.mix.json' },
    { status: 'renamed', previousPath: 'cheers/x/y/unrecorded.cheer.json', path: 'cheers/x/y/z.cheer.json' },
    { status: 'removed', path: 'cheers/x/y/never.cheer.json' },
  ], MAINTAINER);
  assert.deepEqual(next, model({ [MOVED]: FAN }), 'the renamed file stays with its contributor, not whoever renamed it');
  assert.deepEqual(actions.map(found => [found.action, found.path, found.from]), [['move', MOVED, ONE], ['remove', TWO, undefined], ['remove', MIX, undefined]]);
});

test('unknown change types are refused, and an account is needed only to credit a file', () => {
  assert.throws(() => contributors.recordChanges(model({}), [{ status: 'copied', path: ONE }], FAN), /未知的修改类型/);
  assert.deepEqual(contributors.recordChanges(model({ [ONE]: FAN }), [{ status: 'removed', path: ONE }], null).model, model({}));
  assert.deepEqual(contributors.recordChanges(model({}), [{ status: 'added', path: 'README.md' }], null).model, model({}));
  for (const user of [null, { id: '101', login: 'fan-a' }, { id: 101 }, { id: 101, login: 'a b' }]) {
    assert.throws(() => contributors.recordChanges(model({}), [{ status: 'added', path: ONE }], user), /无法记录/);
  }
  assert.throws(() => contributors.recordChanges({ format: 'x' }, [], FAN), error => error.code === 'invalidContributors');
  const { model: kept, actions } = contributors.dropMissing(model({ [ONE]: FAN, [TWO]: OTHER }, SHA_B), file => file === ONE);
  assert.deepEqual(kept, model({ [ONE]: FAN }, SHA_B));
  assert.deepEqual(actions.map(found => found.path), [TWO]);
});

test('a commit is credited to the pull request whose merge commit it is, and to nobody when that is uncertain', () => {
  const merged = (number, sha, user, ref = 'main', owner = user && user.id) => ({
    number, state: 'closed', merged_at: '2026-10-26T00:00:00Z', merge_commit_sha: sha, base: { ref }, head: { repo: { owner: { id: owner } } }, user,
  });
  const open = { number: 9, state: 'open', merged_at: null, merge_commit_sha: null, base: { ref: 'main' }, user: OTHER };
  assert.deepEqual(contributors.mergedPullRequest(SHA_A, [open, merged(1, SHA_A, FAN)], 'main'), { number: 1, user: FAN });
  assert.deepEqual(contributors.mergedPullRequest(SHA_A, [merged(1, SHA_A, FAN), merged(2, SHA_B, OTHER)], 'main'), { number: 1, user: FAN });
  // A commit that is not a merge commit (a rebased commit, a branch fast-forwarded into main) is
  // credited to whoever pushed it.
  assert.equal(contributors.mergedPullRequest(SHA_A, [merged(2, SHA_B, OTHER)], 'main'), null);
  assert.equal(contributors.mergedPullRequest(SHA_A, [merged(1, SHA_A, FAN), merged(2, SHA_A, OTHER)], 'main'), null);
  assert.equal(contributors.mergedPullRequest(SHA_A, [], 'main'), null);
  assert.equal(contributors.mergedPullRequest(SHA_A, [open], 'main'), null);
  assert.equal(contributors.mergedPullRequest(SHA_A, [merged(1, SHA_A, FAN, 'other')], 'main'), null);
  assert.equal(contributors.mergedPullRequest(SHA_A, [merged(1, SHA_A, { id: '101', login: 'fan-a' })], 'main'), null);
  assert.equal(contributors.mergedPullRequest(SHA_A, { message: 'Not Found' }, 'main'), null);
  // Anyone can open a pull request from someone else's public branch; GitHub marks it merged when
  // that branch reaches main. Only a pull request from its author's own repository counts.
  assert.equal(contributors.mergedPullRequest(SHA_A, [merged(1, SHA_A, OTHER, 'main', MAINTAINER.id)], 'main'), null);
  assert.equal(contributors.mergedPullRequest(SHA_A, [{ ...merged(1, SHA_A, FAN), head: { repo: null } }], 'main'), null);
});

test('the pull request to merge is the single open one into the default branch from the checked repository, branch and commit', () => {
  const pull = (number, sha, { ref = 'main', state = 'open', repo = 7, branch = 'patch-1' } = {}) =>
    ({ number, state, head: { sha, ref: branch, repo: repo === null ? null : { id: repo } }, base: { ref } });
  const run = { head_sha: SHA_A, head_branch: 'patch-1', head_repository: { id: 7 } };
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A), pull(6, SHA_B), pull(7, SHA_A, { ref: 'other' })], SHA_A, 'main').number, 5);
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A), pull(8, SHA_A, { repo: 8 })], SHA_A, 'main', run).number, 5);
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A), pull(8, SHA_A, { branch: 'other' })], SHA_A, 'main', run).number, 5);
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A, { repo: 8 })], SHA_A, 'main', run).number, null);
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A, { repo: null })], SHA_A, 'main', run).number, null);
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A)], SHA_A, 'main', null).number, null);
  assert.equal(contributors.pullRequestForHead([pull(6, SHA_B)], SHA_A, 'main').number, null);
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A, { state: 'closed' })], SHA_A, 'main').number, null);
  assert.equal(contributors.pullRequestForHead([pull(5, SHA_A), pull(8, SHA_A)], SHA_A, 'main').number, null);
  assert.equal(contributors.pullRequestForHead([pull(5, 'A'.repeat(40))], 'A'.repeat(40), 'main').number, null);
  assert.equal(contributors.pullRequestForHead([pull('5', SHA_A)], SHA_A, 'main').number, null);
  assert.equal(contributors.pullRequestForHead(null, SHA_A, 'main').number, null);
});

// ---------------------------------------------------------------------------------------------
// The automatic merge decision

const RECORDS = model({ [ONE]: FAN, [TWO]: OTHER, [MIX]: FAN }, SHA_B);
const decide = (files, overrides = {}) => contributors.autoMergeDecision({
  changedFiles: files.length, files, draft: false, headSha: SHA_A, checkedSha: SHA_A,
  baseSha: SHA_B, expectedBase: SHA_B, ...overrides,
});
const added = filename => ({ status: 'added', filename });

test('all-new timelines and artist MIX qualify regardless of the human or app opening the PR', () => {
  for (const files of [[added(ONE)], [added(MIX)], [added(ONE), added(MIX)]]) {
    assert.equal(decide(files).merge, true);
  }
});

test('edits, moves, removals, common MIX and mixed changes always require manual review', () => {
  for (const change of [
    ...['modified', 'renamed', 'removed', 'changed', 'copied', 'unchanged'].map(status => ({ status, filename: ONE })),
    { ...added(MOVED), previous_filename: ONE }, added('mix/proposals/口号.mix.json'),
    added('spec/mix-library.json'), added('index.json'), added('.github/workflows/check.yml'),
    added('cheers/不分目录.cheer.json'), added('mix/artists/../口号.mix.json'),
  ]) {
    assert.equal(decide([change]).merge, false);
    assert.equal(decide([added(TWO), change]).merge, false);
  }
});

test('only a current, complete, unambiguous and non-draft change set qualifies', () => {
  for (const overrides of [{ draft: true }, { draft: undefined }, { baseSha: undefined },
    { expectedBase: SHA_A }, { headSha: SHA_B }, { changedFiles: 301 }, { files: undefined }]) {
    assert.equal(decide([added(ONE)], overrides).merge, false);
  }
  assert.equal(decide([]).merge, false);
  assert.equal(decide([added(ONE), added(ONE)]).merge, false);
  assert.equal(contributors.autoMergeDecision().merge, false);
});

// tools/record-contributors.js on throw-away repositories

const hasGit = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: '合成维护者',
  GIT_AUTHOR_EMAIL: 'maintainer@example.com',
  GIT_COMMITTER_NAME: '合成维护者',
  GIT_COMMITTER_EMAIL: 'maintainer@example.com',
};

function repository() {
  const root = temp('cheerbook-contributors-');
  const git = (...args) => {
    const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const commit = (message, files = {}, removed = []) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
      git('add', '--', file);
    }
    for (const file of removed) git('rm', '-q', '--', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const move = (from, to) => {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    git('mv', '--', from, to);
    git('commit', '-q', '-m', 'rename');
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit, move };
}

const record = (root, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'record-contributors.js'), '--root', root, ...args], { encoding: 'utf8', env: GIT_ENV });
const merged = (number, sha, user) => [{ number, state: 'closed', merged_at: '2026-10-26T00:00:00Z', merge_commit_sha: sha, base: { ref: 'main' }, head: { repo: { owner: { id: user.id } } }, user }];
const readRecords = root => contributors.readContributors(fs.readFileSync(path.join(root, 'contributors.json'), 'utf8'));
const writeRecords = (root, value) => fs.writeFileSync(path.join(root, 'contributors.json'), contributors.serializeContributors(value));
const pullsFor = entries => {
  const dir = temp('cheerbook-pulls-');
  for (const [sha, pulls] of Object.entries(entries)) fs.writeFileSync(path.join(dir, sha + '.json'), JSON.stringify(pulls));
  return dir;
};
const actor = ['--actor', MAINTAINER.login, '--actor-id', String(MAINTAINER.id)];
const content = name => JSON.stringify({ synthetic: name, events: [name, name + name, name + name + name] }) + '\n';

test('the record tool credits new files to their pull request authors, follows renames and removals, and remembers where it stopped', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, commit, move } = repository();
  const c0 = commit('start', { 'README.md': '# 合成\n' });
  const c1 = commit('pull request 1', { [ONE]: content('one') });
  const c2 = commit('direct push', { [MIX]: content('mix'), 'docs/notes.md': 'notes\n' });
  const c3 = move(ONE, MOVED);
  const c4 = commit('pull request 3', { [TWO]: content('two') }, [MIX]);

  const list = record(root, '--before', c0, '--after', c4, '--list');
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split('\n'), [c1, c2, c4], 'only commits that add contribution files need an account');
  const pulls = pullsFor({
    [c1]: [...merged(1, c1, FAN), { number: 9, state: 'open', merged_at: null, base: { ref: 'main' }, user: OTHER }],
    [c2]: [],
    [c4]: merged(3, c4, OTHER),
  });

  // A pull request that cannot be looked up, or a direct push without the pusher, stops the run
  // and writes nothing.
  const missing = record(root, '--before', c0, '--after', c4, '--pulls', pullsFor({}), ...actor);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /缺少提交/);
  const noActor = record(root, '--before', c0, '--after', c4, '--pulls', pulls);
  assert.equal(noActor.status, 1);
  assert.match(noActor.stderr, /--actor/);
  assert.equal(fs.existsSync(path.join(root, 'contributors.json')), false);

  const run = record(root, '--before', c0, '--after', c4, '--pulls', pulls, ...actor);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readRecords(root), model({ [MOVED]: FAN, [TWO]: OTHER }, c4));
  assert.match(run.stdout, /Pull Request #1/);
  assert.match(run.stdout, /直接推送/);
  assert.match(run.stdout, /改名/);
  const text = fs.readFileSync(path.join(root, 'contributors.json'), 'utf8');

  // Running again, as a manual run, or with any --before changes nothing: the records say where they stand.
  for (const args of [['--before', c0], [], ['--before', '0'.repeat(40)], ['--before', c3]]) {
    const again = record(root, ...args, '--after', c4, '--pulls', pulls, ...actor);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /没有变化/);
    assert.equal(fs.readFileSync(path.join(root, 'contributors.json'), 'utf8'), text);
  }
  const pending = record(root, '--pending');
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stdout, '[]\n');
});

test('a run that failed or was cancelled is caught up by the next, so an old record never stays on a new file', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, commit } = repository();
  commit('start', { 'README.md': '# 合成\n' });
  const c1 = commit('pull request 1', { [ONE]: content('one') });
  writeRecords(root, model({ [ONE]: FAN }, c1));
  // FAN removes their file (auto-merged); OTHER's new file lands at the same path; then a docs
  // change. The runs for the first two never finished.
  const c2 = commit('pull request 2', {}, [ONE]);
  const c3 = commit('pull request 3', { [ONE]: content('another one') });
  // A direct push from that time: who pushed it is no longer known.
  const c4 = commit('direct push', { [MIX]: content('mix') });
  const c5 = commit('docs', { 'docs/notes.md': 'notes\n' });
  assert.equal(c2.length, 40);

  const pending = record(root, '--after', c5, '--pending');
  assert.equal(pending.status, 0, pending.stderr);
  assert.deepEqual(JSON.parse(pending.stdout), [ONE, MIX].sort(), 'until the records catch up, the automatic merge leaves these files alone');
  const list = record(root, '--before', c4, '--after', c5, '--list');
  assert.deepEqual(list.stdout.trim().split('\n'), [c3, c4]);
  const run = record(root, '--before', c4, '--after', c5, '--pulls', pullsFor({ [c3]: merged(3, c3, OTHER), [c4]: [] }), ...actor);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readRecords(root), model({ [ONE]: OTHER }, c5));
  assert.match(run.stderr, /没有记录 "mix\/artists\/合成组合\/口号\.mix\.json" 的投稿者/, 'not credited to whoever pushed now');
  assert.equal(record(root, '--after', c5, '--pending').stdout, '[]\n');
});

test('quiet runs leave contributors.json alone; edits made on main do not hold up the automatic merge', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, commit } = repository();
  commit('start', { 'README.md': '# 合成\n' });
  const c1 = commit('pull request 1', { [ONE]: content('one') });
  writeRecords(root, model({ [ONE]: FAN }, c1));
  const text = fs.readFileSync(path.join(root, 'contributors.json'), 'utf8');
  const c2 = commit('auto-merged edit', { [ONE]: content('one, improved') });
  const c3 = commit('docs', { 'docs/notes.md': 'notes\n' });
  const run = record(root, '--before', c2, '--after', c3, ...actor);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /没有变化/);
  assert.equal(fs.readFileSync(path.join(root, 'contributors.json'), 'utf8'), text);
  assert.equal(record(root, '--after', c3, '--pending').stdout, '[]\n');
  // A cursor that is not in the history (rewritten), or no records at all: nothing can be told.
  writeRecords(root, model({ [ONE]: FAN }, 'f'.repeat(40)));
  assert.equal(record(root, '--after', c3, '--pending').stdout, 'null\n');
  fs.rmSync(path.join(root, 'contributors.json'));
  assert.equal(record(root, '--after', c3, '--pending').stdout, 'null\n');
});

test('a file moved and changed in one commit is credited to that commit\'s contributor', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, commit } = repository();
  commit('start', { 'README.md': '# 合成\n' });
  const c1 = commit('pull request 1', { [ONE]: content('one') });
  writeRecords(root, model({ [ONE]: FAN }, c1));
  // OTHER's reviewed pull request removes FAN's file and adds a similar file of their own.
  const c2 = commit('pull request 2', { [TWO]: content('one').replace('"one"', '"two"') }, [ONE]);
  const run = record(root, '--before', c1, '--after', c2, '--pulls', pullsFor({ [c2]: merged(2, c2, OTHER) }), ...actor);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readRecords(root), model({ [TWO]: OTHER }, c2));
});

test('when main is fast-forwarded to a branch that merged main, nobody is credited for files from the side line', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, git, commit } = repository();
  const c0 = commit('start', { 'README.md': '# 合成\n' });
  const m1 = commit('pull request 1', { [TWO]: content('two') });
  writeRecords(root, model({ [TWO]: OTHER }, m1));
  // A contributor's branch from c0 adds a file and merges main into itself; main is then
  // fast-forwarded to it, so the merge's first parent is the branch.
  git('checkout', '-q', '-b', 'feature', c0);
  const f1 = commit('feature', { [ONE]: content('one') });
  git('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const fm = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feature');
  writeRecords(root, model({ [TWO]: OTHER }, m1));

  const list = record(root, '--before', m1, '--after', fm, '--list');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, '', 'no commit is looked up');
  assert.equal(record(root, '--after', fm, '--pending').stdout, 'null\n');
  const pulls = pullsFor({ [f1]: merged(4, f1, FAN), [fm]: merged(4, fm, FAN) });
  const run = record(root, '--before', m1, '--after', fm, '--pulls', pulls, ...actor);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /不是一条首父提交链/);
  assert.deepEqual(readRecords(root), model({ [TWO]: OTHER }, fm), 'the file on main keeps its contributor; the new file has none');
});

test('a merge commit never credits the files it brings in, even when the line of first parents looks unbroken', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, git, commit } = repository();
  const c0 = commit('start', { 'README.md': '# 合成\n' });
  // OTHER's file lands on main, but its run never finishes: the records still stand at c0.
  const mm = commit('pull request 1', { [TWO]: content('two') });
  // A contributor's branch from c0 adds a file and merges main (with OTHER's file) into itself;
  // main is fast-forwarded to it. From c0 the first parents run f1, fm without a break.
  git('checkout', '-q', '-b', 'feature', c0);
  const f1 = commit('feature', { [ONE]: content('one') });
  git('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const fm = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feature');
  const pulls = pullsFor({ [f1]: [], [fm]: merged(5, fm, FAN), [mm]: merged(1, mm, OTHER) });
  // The push run: main stood at mm, which is not on the line, so nothing is credited.
  writeRecords(root, model({}, c0));
  const pushRun = record(root, '--before', mm, '--after', fm, '--pulls', pulls, ...actor);
  assert.equal(pushRun.status, 0, pushRun.stderr);
  assert.deepEqual(readRecords(root), model({}, fm));
  // A manual run (no --before): the merge commit is not credited, and f1, which came with no push
  // this run knows of and no pull request, neither.
  writeRecords(root, model({}, c0));
  const list = record(root, '--after', fm, '--list');
  assert.deepEqual(list.stdout.trim().split('\n'), [f1], 'merge commits are not looked up');
  const manualRun = record(root, '--after', fm, '--pulls', pulls, ...actor);
  assert.equal(manualRun.status, 0, manualRun.stderr);
  assert.deepEqual(readRecords(root), model({}, fm), 'OTHER\'s file is never credited to FAN');
  assert.match(manualRun.stderr, /合并提交/);
  // "更新记录" calls it exactly like this: no --before and nobody to credit a push to.
  writeRecords(root, model({}, c0));
  const workflowRun = record(root, '--after', fm, '--pulls', pulls, '--branch', 'main');
  assert.equal(workflowRun.status, 0, workflowRun.stderr);
  assert.deepEqual(readRecords(root), model({}, fm));
  assert.match(workflowRun.stderr, /等这次记录合并到 main 之后/);
  // A cursor that is not in history stops a manual run instead of skipping the commits in between;
  // --pending still answers "cannot tell", so only the maintainer can approve meanwhile.
  writeRecords(root, model({}, 'f'.repeat(40)));
  const lost = record(root, '--after', fm, '--pulls', pulls, '--branch', 'main');
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /recordedThrough 不在/);
  assert.deepEqual(readRecords(root), model({}, 'f'.repeat(40)), 'nothing is written');
  assert.equal(record(root, '--after', fm, '--pending').stdout.trim(), 'null');
});

test('when the line is broken, a file deleted and added again in between loses its old record', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, git, commit } = repository();
  const c0 = commit('start', { 'README.md': '# 合成\n', [ONE]: content('one') });
  // A side branch deletes FAN's file and adds a different one at the same path; main moves on;
  // the branch merges main and main is fast-forwarded to it.
  git('checkout', '-q', '-b', 'side', c0);
  commit('remove', {}, [ONE]);
  commit('add again', { [ONE]: content('someone else') });
  git('checkout', '-q', 'main');
  const m1 = commit('docs', { 'docs/notes.md': 'notes\n' });
  git('checkout', '-q', 'side');
  git('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const sm = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'side');
  writeRecords(root, model({ [ONE]: FAN }, c0));
  const run = record(root, '--before', m1, '--after', sm, '--pulls', pullsFor({}), ...actor);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readRecords(root), model({}, sm));
  assert.match(run.stdout, /被删除过/);
});

test('the record tool creates contributors.json when missing, keeps --list output clean and refuses a damaged file', { skip: !hasGit && 'git is not installed' }, () => {
  const { root, commit } = repository();
  const c0 = commit('start', { 'README.md': '# 合成\n' });
  const c1 = commit('pull request 1', { [ONE]: content('one') });
  // A --before that no longer exists (a force push) falls back to the newest commit, with the
  // warning on stderr so that stdout stays a list of commits.
  const list = record(root, '--before', 'e'.repeat(40), '--after', c1, '--list');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, c1 + '\n');
  assert.match(list.stderr, /找不到提交/);
  const run = record(root, '--after', c0);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readRecords(root), model({}, c0));
  // A file the tools removed from the working tree (not yet committed) loses its record.
  writeRecords(root, model({ [ONE]: FAN }, c1));
  fs.rmSync(path.join(root, ONE));
  const removed = record(root, '--after', c1);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(readRecords(root), model({}, c1));
  assert.match(removed.stdout, /文件已不在仓库中/);
  fs.writeFileSync(path.join(root, 'contributors.json'), '{"format": "cheerbook-contributors"}');
  const damaged = record(root, '--after', c0);
  assert.equal(damaged.status, 1);
  assert.match(damaged.stderr, /contributors\.json/);
  const unknown = record(root, '--after', 'f'.repeat(40));
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /找不到提交/);
});

// ---------------------------------------------------------------------------------------------
// The workflows

const workflow = name => fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
const indentOf = line => line.length - line.trimStart().length;

/** The steps of a workflow's job: `{ name, shell, run, text }`, with `run` unindented. */
function stepsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line === '    steps:');
  assert.ok(start > 0, 'the job has steps');
  const steps = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= 4) break;
    if (indentOf(line) === 6 && line.trimStart().startsWith('- ')) steps.push([' '.repeat(8) + line.trimStart().slice(2)]);
    else steps.at(-1).push(line);
  }
  return steps.map(own => {
    const value = key => {
      const found = own.find(line => line.startsWith(' '.repeat(8) + key + ':'));
      return found === undefined ? undefined : found.slice(found.indexOf(':') + 1).trim();
    };
    let run = value('run');
    if (run === '|') {
      const at = own.findIndex(line => line.startsWith(' '.repeat(8) + 'run:'));
      const block = [];
      for (const line of own.slice(at + 1)) {
        if (line.trim() !== '' && indentOf(line) <= 8) break;
        block.push(line.slice(10));
      }
      while (block.length && block.at(-1) === '') block.pop();
      run = block.join('\n') + '\n';
    }
    return { name: value('name'), shell: value('shell'), run, text: own.join('\n') };
  });
}

const pins = text => [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map(found => found[1]);
const expressions = text => [...text.matchAll(/\$\{\{\s*(.*?)\s*\}\}/g)].map(found => found[1]);
const jobPermissions = text => /^ {4}permissions:\n((?: {6}\S.*\n)+)/m.exec(text)[1].trim().split('\n').map(line => line.trim()).sort();

test('"检查" is the workflow that auto-merge waits for', () => {
  const check = workflow('check.yml');
  assert.match(check, /^name: 检查$/m);
  assert.match(check, /working-directory: base\n        run: node --test/);
  assert.match(check, /npm ci --prefix base\/worker --ignore-scripts/);
  assert.doesNotMatch(check, /working-directory: target|npm ci --prefix target/);
});

test('auto-merge runs only after "检查" passes on a pull request and never runs the pull request\'s code', () => {
  const text = workflow('auto-merge.yml');
  const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'));
  assert.equal(triggers, '\non:\n  workflow_run:\n    workflows: [检查]\n    types: [completed]\n');
  assert.doesNotMatch(text, /pull_request_target/);
  assert.match(text, /^permissions: \{\}$/m);
  assert.deepEqual(jobPermissions(text), ['contents: write', 'pull-requests: write', 'statuses: read']);
  // The merge is the only write: nothing is started or pushed afterwards (the website builds its own index).
  assert.doesNotMatch(text, /dispatches|git push|git commit/);
  for (const condition of ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'pull_request'",
    "github.event.workflow_run.path == '.github/workflows/check.yml'"]) {
    assert.ok(text.includes(condition), condition);
  }
  // Only trusted values are interpolated: the checked commit, the default branch, the token and
  // this workflow's own step output. Never a branch name, title or anything else from the pull request.
  assert.deepEqual([...new Set(expressions(text))].sort(), [
    'github.event.repository.default_branch', 'github.event.workflow_run.head_sha', 'github.token', 'steps.find.outputs.number',
  ]);
  assert.doesNotMatch(text, /head_branch|head_repository|head_commit|display_title|\.title\b|\.body\b|head\.ref/);
  const steps = stepsOf(text);
  const checkout = steps.find(step => step.text.includes('actions/checkout@'));
  assert.match(checkout.text, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(checkout.text, /fetch-depth: 0/);
  assert.match(checkout.text, /persist-credentials: false/);
  for (const step of steps.filter(step => step.run !== undefined)) {
    assert.doesNotMatch(step.run, /\$\{\{/, step.name);
    const token = /GH_TOKEN|github\.token|secrets\./.test(step.text);
    // Steps with the token only call the API; steps that run code have no token.
    if (token) assert.doesNotMatch(step.run, /\bnode\b|require\(/, step.name);
    if (step.shell === 'node {0}' || /\bnode\b/.test(step.run)) assert.equal(token, false, step.name);
  }
  assert.ok(steps.some(step => step.run && step.run.includes('node tools/check-merge-tree.js') && step.run.includes('node tools/check.js')));
  const merge = steps.find(step => step.run && step.run.includes('gh api --method PUT'));
  assert.match(merge.run, /--method PUT "repos\/\$GITHUB_REPOSITORY\/pulls\/\$NUMBER\/merge" -f merge_method=squash -f sha="\$CHECKED_SHA"/);
  assert.match(merge.run, /cheerbook\/review-policy/);
  assert.match(merge.run, /for attempt in \{1\.\.24\}/);
  assert.match(merge.text, /if: steps\.decide\.outputs\.merge == 'true'/);
  const files = steps.find(step => step.run && step.run.includes('/compare/'));
  assert.match(files.run, /compare\/\$BASE\.\.\.\$CHECKED_SHA/, 'the files are listed for exactly the checked commit');
});

test('both workflows pin their actions to the commits check.yml uses and keep no token in the checkout', () => {
  const allowed = new Set(pins(workflow('check.yml')));
  for (const name of ['auto-merge.yml', 'records.yml']) {
    const text = workflow(name);
    assert.ok(pins(text).length >= 2, name);
    for (const use of pins(text)) {
      assert.match(use, /@[0-9a-f]{40}$/, `${name}: ${use}`);
      assert.ok(allowed.has(use), `${name}: ${use}`);
    }
    for (const step of stepsOf(text).filter(step => step.text.includes('actions/checkout@'))) assert.match(step.text, /persist-credentials: false/, name);
    assert.doesNotMatch(text, /pull_request_target/, name);
  }
});

test('the records workflow runs only by hand and pushes its result to a records/ branch, never to main, with the token only where needed', () => {
  const text = workflow('records.yml');
  const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'));
  // Started by a maintainer only: a merge does not start it, and it cannot be reached from a pull request.
  assert.equal(triggers, '\non:\n  workflow_dispatch:\n');
  assert.match(text, /^permissions: \{\}$/m);
  assert.deepEqual(jobPermissions(text), ['contents: write', 'pull-requests: read']);
  assert.match(text, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.deepEqual([...new Set(expressions(text))].sort(), ['secrets.GITHUB_TOKEN']);
  const steps = stepsOf(text);
  assert.match(steps.find(step => step.text.includes('actions/checkout@')).text, /fetch-depth: 0/);
  // The exception for accepting proposals depends on both: every path listed, and the files to look at.
  assert.match(workflow('check.yml'), /diff -z --no-renames --name-only HEAD\^1 HEAD \| node base\/tools\/scope\.js --root target\n/);
  const order = ['--list', 'tools/accept-mix-proposals.js', '--pulls', 'git push'].map(marker => steps.findIndex(step => step.run && step.run.includes(marker)));
  assert.ok(order.every(at => at >= 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `order ${order}`);
  const withToken = steps.filter(step => /GH_TOKEN|PUSH_TOKEN|secrets\./.test(step.text)).map(step => step.name);
  assert.deepEqual(withToken, ['查询这些提交来自哪个 Pull Request', '推送到记录分支']);
  for (const step of steps.filter(step => step.run !== undefined)) {
    assert.doesNotMatch(step.run, /\$\{\{/, step.name);
    if (withToken.includes(step.name)) assert.doesNotMatch(step.run, /\bnode\b/, step.name);
  }
  const lookup = steps.find(step => step.name === '查询这些提交来自哪个 Pull Request');
  assert.match(lookup.run, /\^\[0-9a-f\]\{40\}/, 'only commit ids reach the API call');
  const recordStep = steps.find(step => step.run && step.run.includes('--pulls'));
  // A manual run has no pusher to credit: only pull requests' authors are recorded.
  assert.match(recordStep.run, /--after "\$GITHUB_SHA" --pulls "\$RUNNER_TEMP\/pulls" --branch "\$GITHUB_REF_NAME"$/);
  const push = steps.find(step => step.run && step.run.includes('git push'));
  assert.match(push.run, /for file in spec\/mix-library\.json mix\/proposals contributors\.json; do/);
  assert.doesNotMatch(push.run, /git add (-A|\.)(\s|$)/);
  // The branch name is made of the run's own numbers, and the only push goes there.
  assert.match(push.run, /branch="records\/\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/);
  assert.deepEqual(push.run.match(/git push .*/g).map(line => line.split(' ').at(-1)), ['"HEAD:refs/heads/$branch"']);
});

test('no workflow writes to main except by merging a checked pull request, and index.json is not kept in the repository', () => {
  const folder = path.join(__dirname, '..', '.github', 'workflows');
  const names = fs.readdirSync(folder).filter(name => name.endsWith('.yml')).sort();
  assert.deepEqual(names, ['auto-merge.yml', 'check.yml', 'records.yml', 'review-policy.yml']);
  for (const name of names) {
    const text = workflow(name);
    assert.doesNotMatch(text, /HEAD:main|HEAD:refs\/heads\/main|:main\b|actions\/workflows\/.*dispatches/, name);
    if (name !== 'records.yml') assert.doesNotMatch(text, /git push/, name);
    // Only the merge and the records branch need to write contents.
    assert.equal(/contents: write/.test(text), name === 'auto-merge.yml' || name === 'records.yml', name);
  }
  // The website builds index.json from the merged files (tests/site.test.js); a copy in the
  // repository would need a push to main after every merge.
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'index.json')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'tools', 'build-index.js')), false);
});

// The two node steps of auto-merge.yml, run as the runner would (`shell: node {0}`) on fixtures.
function runStep(name, { records, files: runnerFiles, event = {}, env = {} }) {
  const step = stepsOf(workflow('auto-merge.yml')).find(found => found.name === name);
  assert.equal(step.shell, 'node {0}');
  const workspace = temp('cheerbook-workspace-');
  fs.mkdirSync(path.join(workspace, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'lib', 'contributors.js'), path.join(workspace, 'lib', 'contributors.js'));
  if (records !== undefined) fs.writeFileSync(path.join(workspace, 'contributors.json'), records);
  const runner = temp('cheerbook-runner-');
  for (const [file, value] of Object.entries(runnerFiles)) fs.writeFileSync(path.join(runner, file), typeof value === 'string' ? value : JSON.stringify(value));
  fs.writeFileSync(path.join(runner, 'event.json'), JSON.stringify(event));
  const script = path.join(runner, 'step');
  fs.writeFileSync(script, step.run);
  const output = path.join(runner, 'output');
  fs.writeFileSync(output, '');
  const run = spawnSync(process.execPath, [script], {
    cwd: workspace,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RUNNER_TEMP: runner, GITHUB_OUTPUT: output, GITHUB_EVENT_PATH: path.join(runner, 'event.json'), DEFAULT_BRANCH: 'main', CHECKED_SHA: SHA_A, ...env },
  });
  assert.equal(run.status, 0, run.stderr);
  return { stdout: run.stdout, output: fs.readFileSync(output, 'utf8') };
}

test('auto-merge finds the pull request by the checked commit, repository and branch, without printing its title or branch', () => {
  const head = (sha, ref, repo) => ({ sha, ref, repo: { id: repo } });
  const evil = `x${LINE}::error::y`;
  const open = [[
    { number: 5, state: 'open', draft: false, head: head(SHA_A, evil, 77), base: { ref: 'main' }, title: `::warning::${LINE}evil`, user: FAN },
    { number: 6, state: 'open', head: head(SHA_B, 'patch-2', 77), base: { ref: 'main' } },
    { number: 8, state: 'open', head: head(SHA_A, 'copy', 88), base: { ref: 'main' } },
  ], [
    { number: 7, state: 'open', head: head(SHA_A, evil, 77), base: { ref: 'other' } },
  ]];
  const event = { workflow_run: { head_sha: SHA_A, head_branch: evil, head_repository: { id: 77 } } };
  const found = runStep('找到检查对应的 Pull Request', { files: { 'open.json': open }, event });
  assert.equal(found.output, 'number=5\n');
  assert.doesNotMatch(found.stdout, /evil|::/);
  assert.equal(runStep('找到检查对应的 Pull Request', { files: { 'open.json': open }, event, env: { CHECKED_SHA: 'c'.repeat(40) } }).output, '');
  assert.equal(runStep('找到检查对应的 Pull Request', { files: { 'open.json': open }, event: {} }).output, '', 'no run, no match');
});

test('the decision step pins head and base, allows app submissions and refuses stale, mixed and partial comparisons', () => {
  const pull = { number: 5, state: 'open', draft: false, base: { ref: 'main', sha: SHA_B },
    head: { sha: SHA_A }, user: { id: 123, login: 'example[bot]' }, changed_files: 1 };
  const decideStep = (overrides = {}) => runStep('判断能否自动合并', {
    files: {
      'pull.json': { ...pull, ...overrides.pull },
      'compare.json': overrides.compare || { files: [added(ONE)] },
      'base.txt': SHA_B,
    },
    env: { NUMBER: '5' },
  });
  assert.equal(decideStep().output, 'merge=true\n');
  for (const overrides of [
    { compare: { files: [{ status: 'modified', filename: ONE }] } },
    { compare: { files: [added('spec/mix-library.json')] } }, { compare: 'not json' },
    { pull: { state: 'closed' } }, { pull: { base: { ref: 'other', sha: SHA_B } } },
    { pull: { base: { ref: 'main', sha: SHA_A } } }, { pull: { number: 6 } },
    { pull: { head: { sha: SHA_B } } }, { pull: { draft: true } }, { pull: { changed_files: 2 } },
  ]) assert.equal(decideStep(overrides).output, 'merge=false\n');
});

test('app-submitted contributions never acquire the app or the merging maintainer as their human author', { skip: !hasGit }, () => {
  const { root, commit } = repository();
  const c0 = commit('start', { 'README.md': 'example' });
  const c1 = commit('app contribution', { [ONE]: content('one') });
  const pulls = merged(1, c1, { id: 202, login: 'synthetic[bot]', type: 'Bot' });
  pulls[0].head.repo.owner.id = MAINTAINER.id;
  const run = record(root, '--before', c0, '--after', c1, '--pulls', pullsFor({ [c1]: pulls }), ...actor);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readRecords(root).files, {});
});

test('the synthetic merge must match both commits and add exactly the verified regular blobs', { skip: !hasGit }, () => {
  const { verifyMergeTree } = require('../tools/check-merge-tree');
  const { root, git, commit } = repository();
  const base = commit('base', { 'README.md': 'example' });
  git('checkout', '-qb', 'submit');
  const head = commit('submit', { [ONE]: content('one') });
  const file = { ...added(ONE), sha: git('rev-parse', head + ':' + ONE) };
  const tree = git('rev-parse', head + '^{tree}');
  const merge = git('commit-tree', tree, '-p', base, '-p', head, '-m', 'synthetic merge');
  git('checkout', '-q', 'main');
  git('fetch', '-q', '.', merge);
  assert.equal(verifyMergeTree(head, [file], root), merge);
  assert.throws(() => verifyMergeTree(SHA_B, [file], root));
  assert.throws(() => verifyMergeTree(head, [{ ...file, sha: SHA_A }], root));
  assert.throws(() => verifyMergeTree(head, [file, file], root));
  git('checkout', '-q', 'submit');
  git('update-index', '--chmod=+x', ONE);
  const mode = git('write-tree');
  git('fetch', '-q', '.', git('commit-tree', mode, '-p', base, '-p', head, '-m', 'wrong mode'));
  git('restore', '--staged', '--', ONE);
  git('checkout', '-q', 'main');
  assert.throws(() => verifyMergeTree(head, [file], root));
});

test('the required review status binds real human approvals to this PR head and every affected path', () => {
  const { matchingApprovals, policy } = require('../tools/review-policy');
  const comment = (id, head = SHA_A, type = 'User') => ({
    author: { databaseId: id, __typename: type }, body: '/cheerbook approve ' + head, lastEditedAt: null, isMinimized: false,
  });
  const approvals = matchingApprovals([comment(FAN.id), comment(OTHER.id, SHA_B), comment(77, SHA_A, 'Bot'),
    { ...comment(88), lastEditedAt: 't1' }, { ...comment(89), isMinimized: true }, { ...comment(99), body: 'quoted /cheerbook approve ' + SHA_A }], SHA_A);
  assert.deepEqual([...approvals], [FAN.id]);
  const approve = (files, overrides = {}) => policy({
    pull: { changed_files: files.length, draft: false, base: { ref: 'main', sha: SHA_B }, head: { sha: SHA_A } },
    files, base: SHA_B, owners: model({ [ONE]: FAN, [TWO]: OTHER }), pending: [], approvals,
    maintainer: MAINTAINER.id, ...overrides,
  });
  const edit = filename => ({ filename, status: 'modified' });
  assert.ok(approve([added(ONE)], { approvals: new Set() }));
  assert.ok(approve([edit(ONE)]));
  assert.equal(approve([edit(ONE)], { pending: [ONE] }), false);
  assert.equal(approve([edit(ONE), edit(TWO)]), false);
  assert.ok(approve([edit(ONE), edit(TWO)], { approvals: new Set([FAN.id, OTHER.id]) }));
  assert.equal(approve([edit(MOVED)]), false);
  assert.equal(approve([added('mix/proposals/test.mix.json')]), false);
  assert.ok(approve([added('mix/proposals/test.mix.json')], { approvals: new Set([MAINTAINER.id]) }));
  assert.ok(approve([edit(MOVED)], { approvals: new Set([MAINTAINER.id]) }));
  assert.equal(approve([edit(ONE)], { base: SHA_A }), false);
  const reviewWorkflow = workflow('review-policy.yml');
  assert.match(reviewWorkflow, /ref: main/);
  assert.doesNotMatch(reviewWorkflow, /contents: write|pull-requests: write|pull_request\.head/);
  for (const step of stepsOf(reviewWorkflow)) if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
  assert.match(reviewWorkflow, /statuses: write/);
  // Merges are queued one at a time; nothing else writes to main.
  assert.match(workflow('auto-merge.yml'), /group: cheerbook-main-writers\n\s+queue: max/);
});
