#!/usr/bin/env node
'use strict';
// Keeps contributors.json up to date after merges to main (C-011, lib/contributors.js): walks the
// first-parent commits on main since the commit the records were last brought up to date with
// (`recordedThrough` in contributors.json; without it, since --before) and credits every new file
// under cheers/ or mix/artists/ to the GitHub account that contributed it. A removed file loses its
// record; an exact rename keeps it (a file moved and changed in one commit counts as removed and
// added). Git is only read; the only file written is contributors.json, created when missing.
// Because each run continues from `recordedThrough`, a run that failed or was cancelled is caught
// up by the next one.
//
//   node tools/record-contributors.js --after <sha> [--before <sha>] --list
//     Prints the single-parent commits that add contribution files, one per line (warnings go to
//     stderr). For
//     each, the workflow saves the response of GET /repos/{repo}/commits/{sha}/pulls as
//     <dir>/<sha>.json.
//   node tools/record-contributors.js --after <sha> [--before <sha>] [--pulls <dir>] [--branch main]
//       [--actor <login> --actor-id <id>]
//     Records them. A single-parent commit that is the merge commit of a pull request merged into
//     <branch> (default main), opened from its author's own fork, is credited to the pull
//     request's author: in practice, a squash merge. --before is the commit main pointed to before
//     the push being handled: any other single-parent commit in <before>..<after> was pushed
//     directly and is credited to --actor, who pushed it. Files added by a merge commit (which may
//     bring in other people's files) or by a direct push from an earlier, failed run (who pushed
//     it is no longer known) get no record, and a warning names them. --before is also where the
//     walk starts when contributors.json has no usable `recordedThrough`; without either, only
//     <after> is recorded.
//   node tools/record-contributors.js [--after <sha>] --pending
//     Prints, as a JSON array, the contribution files added, removed or renamed on main after
//     `recordedThrough` up to <after> (default HEAD), whose records may not be current yet; or
//     null when that cannot be told. The automatic merge does not touch those files.
// Every mode takes --root <repository> (default: this repository).
//
// When main's history is not one unbroken line of first parents from the starting commit through
// the commit main pointed to before the push (for example main was fast-forwarded to a branch that
// had merged main into itself), commits cannot be told apart: renames are still applied, every file
// deleted anywhere in between loses its record, and new files get no record (their authors' edits
// then wait for review); a warning names them.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const contributors = require('../lib/contributors');

const FILE = 'contributors.json';
const { quote, isContributionPath } = contributors;
const short = sha => sha.slice(0, 12);
const warn = message => console.error(message);

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      before: { type: 'string', default: '' },
      after: { type: 'string', default: 'HEAD' },
      list: { type: 'boolean', default: false },
      pending: { type: 'boolean', default: false },
      pulls: { type: 'string' },
      branch: { type: 'string', default: 'main' },
      actor: { type: 'string' },
      'actor-id': { type: 'string' },
      root: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const root = path.resolve(values.root || path.join(__dirname, '..'));

  const git = args => {
    const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`git ${args[0]} 失败：${run.stderr.trim()}`);
    return run.stdout;
  };
  const commit = ref => {
    const run = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], { encoding: 'utf8' });
    return run.status === 0 ? run.stdout.trim() : null;
  };
  const parentOf = sha => commit(sha + '^1');
  const isAncestor = (older, newer) => spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', older, newer]).status === 0;

  // The changes from one tree to another; only exact renames count as renames.
  const diff = (from, to) => {
    const fields = git(['diff-tree', '-r', '-z', '-M100%', '--name-status', '--no-commit-id', ...(from ? [from, to] : ['--root', to])]).split('\0');
    const changes = [];
    for (let i = 0; i < fields.length - 1;) {
      const letter = fields[i++].charAt(0);
      if (letter === 'R') {
        changes.push({ status: 'renamed', previousPath: fields[i++], path: fields[i++] });
      } else if (letter === 'C') {
        i++;
        changes.push({ status: 'added', path: fields[i++] });
      } else {
        const status = { A: 'added', M: 'modified', T: 'modified', D: 'removed' }[letter];
        if (!status) throw new Error(`${short(to)} 中有无法识别的修改类型 ${quote(letter)}。`);
        changes.push({ status, path: fields[i++] });
      }
    }
    return changes;
  };
  const changesOf = sha => diff(parentOf(sha), sha);
  const addsContribution = changes => changes.some(change => change.status === 'added' && isContributionPath(change.path));
  const touchesContribution = change => change.status !== 'modified' && (isContributionPath(change.path) || isContributionPath(change.previousPath));
  // The commits after `start` up to `after` along first parents, oldest first; null when they do
  // not form one unbroken line from `start`. A null `start` means `after` is the first commit.
  const line = (start, after) => {
    if (!start) return [after];
    const commits = git(['rev-list', '--first-parent', '--reverse', `${start}..${after}`]).split('\n').filter(Boolean);
    return commits.length && parentOf(commits[0]) !== start ? null : commits;
  };

  const after = commit(values.after);
  if (!after) throw new Error(`找不到提交 ${quote(values.after)}。`);
  const target = path.join(root, FILE);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`${FILE} 不是普通文件（不能是符号链接）。`);
  const current = stat ? fs.readFileSync(target, 'utf8') : null;
  let model = contributors.readContributors(current);

  // Where the records stand: the commit they were last brought up to date with.
  let cursor = null;
  if (model.recordedThrough !== undefined) {
    cursor = commit(model.recordedThrough);
    if (!cursor || !isAncestor(cursor, after)) {
      warn(`${FILE} 记录到的提交 ${short(model.recordedThrough)} 不在 ${short(after)} 之前的历史中（可能改写过历史），改从 --before 开始。`);
      cursor = null;
    }
  }

  if (values.pending) {
    const commits = cursor ? line(cursor, after) : null;
    if (!commits) {
      console.log('null');
      return;
    }
    const paths = new Set();
    for (const sha of commits) {
      for (const change of changesOf(sha).filter(touchesContribution)) {
        for (const file of [change.path, change.previousPath]) if (isContributionPath(file)) paths.add(file);
      }
    }
    console.log(JSON.stringify([...paths].sort()));
    return;
  }

  // The commit main pointed to before the push being handled, and the commits that push brought.
  let pushedFrom = null;
  if (values.before !== '' && !/^0+$/.test(values.before)) {
    pushedFrom = commit(values.before);
    if (!pushedFrom) warn(`找不到提交 ${quote(values.before)}（可能是强制推送之前的提交）${cursor ? '' : `，只记录 ${short(after)}`}。`);
  }
  const pushed = new Set(pushedFrom ? git(['rev-list', `${pushedFrom}..${after}`]).split('\n').filter(Boolean) : []);
  const start = cursor || pushedFrom || parentOf(after);
  let commits = line(start, after);
  // Where main stood before the push must lie on the line too; if it does not, main was moved to
  // another line of history (a fast-forward to a side branch), and its commits cannot be told apart.
  if (commits && pushedFrom && pushedFrom !== start && !commits.includes(pushedFrom)) commits = null;

  if (values.list) {
    for (const sha of commits || []) if (addsContribution(changesOf(sha)) && commit(sha + '^2') === null) console.log(sha);
    return;
  }

  // Who contributed a commit: the author of the pull request it merged, or whoever pushed it when
  // it came with this push; null when that is not known.
  const accountFor = sha => {
    if (values.pulls !== undefined) {
      const file = path.join(values.pulls, sha + '.json');
      if (!fs.existsSync(file)) throw new Error(`缺少提交 ${short(sha)} 的 Pull Request 信息（${file}）。`);
      const found = contributors.mergedPullRequest(sha, JSON.parse(fs.readFileSync(file, 'utf8')), values.branch);
      if (found) return { user: found.user, via: `Pull Request #${found.number}` };
    }
    if (!pushed.has(sha)) return null;
    const id = values['actor-id'];
    const user = { id: /^[1-9][0-9]{0,15}$/.test(id || '') ? Number(id) : NaN, login: values.actor };
    if (!contributors.isAccount(user)) {
      throw new Error(`提交 ${short(sha)} 不是合并到 ${values.branch} 的 Pull Request 的合并提交，需要用 --actor 与 --actor-id 指定推送它的账号。`);
    }
    return { user, via: '直接推送' };
  };

  const report = (actions, via, why) => {
    for (const found of actions) {
      if (found.action === 'add') console.log(`记录 ${quote(found.path)}：${quote(found.login)}（账号编号 ${found.id}，${via}）`);
      else if (found.action === 'move') console.log(`改名 ${quote(found.from)} → ${quote(found.path)}，记录随之移动（${quote(found.login)}）`);
      else console.log(`删除 ${quote(found.path)} 的记录（${why}）`);
    }
  };
  const recordsBefore = JSON.stringify(model.files);

  // A record for a file that did not exist where the walk starts can only be left over from an
  // earlier mistake; it must not credit a new file at that path to the wrong account.
  const atStart = new Set(start ? git(['ls-tree', '-r', '-z', '--name-only', start, '--', 'cheers', 'mix/artists']).split('\0').filter(Boolean) : []);
  let step = contributors.dropMissing(model, file => atStart.has(file));
  report(step.actions, '', start ? `${short(start)} 中没有这个文件` : '起点之前没有这个文件');
  model = step.model;

  let touched = false;
  if (commits) {
    for (const sha of commits) {
      let changes = changesOf(sha);
      touched = touched || changes.some(touchesContribution);
      // A merge commit's diff against its first parent also shows what the other side brought in,
      // which may be other people's files: only squashed or other single-parent commits are credited.
      const merge = commit(sha + '^2') !== null;
      const who = addsContribution(changes) && !merge ? accountFor(sha) : null;
      if (addsContribution(changes) && !who) {
        const why = merge ? '是有多个父提交的合并提交，其中的新文件可能来自别人' : '不是 Pull Request 的合并提交，也不是这次推送的，无法确认是谁推送的';
        for (const change of changes) {
          if (change.status === 'added' && isContributionPath(change.path)) {
            warn(`没有记录 ${quote(change.path)} 的投稿者：提交 ${short(sha)} ${why}。需要时，等这次运行的提交推送到 main 之后，再在 ${FILE} 中手动补记。`);
          }
        }
        changes = changes.filter(change => change.status !== 'added');
      }
      step = contributors.recordChanges(model, changes, who && who.user);
      report(step.actions, who ? `${short(sha)}，${who.via}` : short(sha), `${short(sha)} 删除了这个文件`);
      model = step.model;
    }
  } else {
    warn(`从 ${short(start)} 到 ${short(after)} 不是一条首父提交链（例如 main 被快进到一个合并过 main 的分支），无法逐个提交确认投稿者：删除与改名照常处理，新增的文件不记录投稿者。`);
    const changes = diff(start, after);
    touched = true;
    for (const change of changes) {
      if (change.status === 'added' && isContributionPath(change.path)) warn(`没有记录 ${quote(change.path)} 的投稿者；需要时，等这次运行的提交推送到 main 之后，再在 ${FILE} 中手动补记。`);
    }
    step = contributors.recordChanges(model, changes.filter(change => change.status !== 'added'), null);
    report(step.actions, '', `${short(after)} 中已没有这个文件`);
    model = step.model;
    // A file deleted and added again in between looks unchanged from end to end, but it may be
    // someone else's file now: drop the record of every file deleted anywhere in the range.
    const deleted = new Set(git(['log', '--format=', '--name-only', '-z', '-m', '--diff-filter=D', '--no-renames', `${start}..${after}`, '--', 'cheers', 'mix/artists'])
      .split('\0').map(file => file.replace(/^\n+/, '')).filter(Boolean));
    step = contributors.dropMissing(model, file => !deleted.has(file));
    report(step.actions, '', '这个文件在这段历史中被删除过');
    model = step.model;
  }

  // Every part of the path must be a real folder or file: a symbolic link is not a contribution.
  const present = file => {
    const parts = file.split('/');
    return parts.every((part, i) => {
      const found = fs.lstatSync(path.join(root, ...parts.slice(0, i + 1)), { throwIfNoEntry: false });
      return found && (i === parts.length - 1 ? found.isFile() : found.isDirectory());
    });
  };
  step = contributors.dropMissing(model, present);
  report(step.actions, '', '文件已不在仓库中');
  model = step.model;

  // Move the cursor on whenever the records could have changed, so the automatic merge knows they
  // are current; leave the file as it is otherwise, so a quiet run makes no commit.
  if (!cursor || !commits || touched || JSON.stringify(model.files) !== recordsBefore) model = { ...model, recordedThrough: after };
  const text = contributors.serializeContributors(model);
  const count = Object.keys(model.files).length;
  if (text !== current) {
    fs.writeFileSync(target, text);
    console.log(`已更新 ${FILE}（${count} 个文件有投稿者记录，记录到 ${short(model.recordedThrough)}）。`);
  } else {
    console.log(`${FILE} 没有变化（${count} 个文件有投稿者记录）。`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`记录投稿者失败：${error.message}`);
  process.exitCode = 1;
}
