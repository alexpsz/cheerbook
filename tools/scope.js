#!/usr/bin/env node
'use strict';
// Reads the paths a pull request changes (NUL-separated, as `git diff -z --name-only` prints them)
// and refuses a pull request that mixes contributions under cheers/ with any other change: the
// checks run from the base branch, but a reviewer looking at a contribution should not have to
// review code too. Changes to the checks, the format or the workflows are flagged for review.
//   git diff -z --name-only <base> <head> | node tools/scope.js
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const paths = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
  const contributions = paths.filter(file => file.startsWith('cheers/'));
  const others = paths.filter(file => !file.startsWith('cheers/') && file !== 'index.json');
  const sensitive = others.filter(file => /^(lib|tools|tests|spec|\.github)\//.test(file) || file === 'package.json');
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  if (contributions.length && others.length) {
    console.log('投稿（cheers/ 下的文件）请单独发起 Pull Request，不要与其他修改放在一起。');
    if (annotate) console.log('::error::投稿（cheers/ 下的文件）请单独发起 Pull Request，不要与其他修改放在一起。');
    process.exitCode = 1;
    return;
  }
  if (sensitive.length) {
    console.log(`此 Pull Request 修改了 ${sensitive.length} 个检查代码、格式或工作流文件，需要维护者逐行审查（自动检查用的是基准分支的代码，不代表这些修改正确）。`);
    if (annotate) console.log('::warning::此 Pull Request 修改了检查代码、格式或工作流，需要维护者逐行审查。');
  }
  console.log(`修改范围：${contributions.length} 个投稿文件，${others.length} 个其他文件。`);
});
