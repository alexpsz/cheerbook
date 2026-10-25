#!/usr/bin/env node
'use strict';
// Reads the paths a pull request changes (NUL-separated, as `git diff -z --name-only` prints them)
// and refuses a pull request that mixes contributions (cheers/, mix/proposals/, mix/artists/) with
// any other change: the checks run from the base branch, but a reviewer looking at a contribution
// should not have to review code too. Anything other than plain documentation — checks, format, workflows, the
// website's assets, Cloudflare Pages functions or settings — is flagged for line-by-line review.
//   git diff -z --name-only <base> <head> | node tools/scope.js
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const paths = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
  const contribution = file => ['cheers/', 'mix/proposals/', 'mix/artists/'].some(dir => file.startsWith(dir)) && !file.split('/').includes('..');
  const contributions = paths.filter(contribution);
  const others = paths.filter(file => !contribution(file) && file !== 'index.json');
  const documentation = file => !file.split('/').includes('..') &&
    (file.startsWith('docs/') || file.startsWith('memory-bank/') || (file.endsWith('.md') && !file.includes('/')));
  const sensitive = others.filter(file => !documentation(file));
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  if (contributions.length && others.length) {
    console.log('投稿（cheers/ 与 mix/ 下的文件）请单独发起 Pull Request，不要与其他修改放在一起。');
    if (annotate) console.log('::error::投稿（cheers/ 与 mix/ 下的文件）请单独发起 Pull Request，不要与其他修改放在一起。');
    process.exitCode = 1;
    return;
  }
  if (sensitive.length) {
    console.log(`此 Pull Request 修改了 ${sensitive.length} 个代码、格式、网站或配置文件，需要维护者逐行审查（自动检查用的是基准分支的代码，不代表这些修改正确）。`);
    if (annotate) console.log('::warning::此 Pull Request 修改了代码、格式、网站或配置文件，需要维护者逐行审查。');
  }
  console.log(`修改范围：${contributions.length} 个投稿文件，${others.length} 个其他文件。`);
});
