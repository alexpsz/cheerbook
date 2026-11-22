#!/usr/bin/env node
'use strict';
// Compare GitHub's temporary merge commit with the default-branch checkout. Only after
// proving that its entire delta is added regular data files may the checker open that tree.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { isContributionPath } = require('../lib/contributors');

function verifyMergeTree(checkedSha, files, root = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const sha = ref => git('rev-parse', '--verify', ref).trim();
  const base = sha('HEAD');
  const merge = sha('FETCH_HEAD');
  if (git('show', '-s', '--format=%P', merge).trim() !== base + ' ' + checkedSha)
    throw new Error('GitHub 待合并版本的基准或提交已变化。');
  const expected = new Map(files.map(file => [file.filename, file.sha]));
  const raw = git('diff-tree', '-r', '--raw', '--no-abbrev', '--no-renames', '-z', base, merge).split('\0');
  if (raw.pop() !== '' || !files.length || expected.size !== files.length || raw.length !== 2 * files.length)
    throw new Error('待合并的文件列表不完整，或与已检查的提交不同。');
  for (let i = 0; i < raw.length; i += 2) {
    const [, id] = /^:000000 100644 0+ ([a-f0-9]{40}(?:[a-f0-9]{24})?) A$/.exec(raw[i]) || [];
    const file = raw[i + 1];
    if (!id || !isContributionPath(file) || file.split('/').length !== 4 || expected.get(file) !== id)
      throw new Error('待合并内容须为已经检查过的新增普通投稿文件。');
    expected.delete(file);
  }
  return merge;
}

if (require.main === module) {
  const [head, compare, destination] = process.argv.slice(2);
  const merge = verifyMergeTree(head, JSON.parse(fs.readFileSync(compare, 'utf8')).files);
  execFileSync('git', ['worktree', 'add', '--quiet', '--detach', destination, merge], { stdio: 'inherit' });
}
module.exports = { verifyMergeTree };
