#!/usr/bin/env node
'use strict';
// Reads the paths a pull request changes (NUL-separated, as `git diff -z --name-only` prints them)
// and refuses a pull request that mixes contributions (cheers/, mix/proposals/, mix/artists/) with
// any other change: the checks run from the base branch, but a reviewer looking at a contribution
// should not have to review code too. Anything other than plain documentation — checks, format, workflows, the
// website's assets, Cloudflare Pages functions or settings — is flagged for line-by-line review.
// One mix is allowed: proposals that the pull request removes, together with
// spec/mix-library.json (and contributors.json), which is what accepting proposals into the
// built-in library looks like ("更新记录", tools/accept-mix-proposals.js). The paths alone do not say
// whether a proposal is added or removed, so the exception needs --root, the pull request's files,
// and holds only when none of the listed proposals exists there: adding a proposal and editing the
// library in one pull request is still refused. It is flagged like any other change to the
// library, and only the maintainer can approve it (tools/review-policy.js).
//   git diff -z --no-renames --name-only <base> <head> | node tools/scope.js [--root <head's files>]
const fs = require('node:fs');
const path = require('node:path');

const rootFlag = process.argv.indexOf('--root');
const root = rootFlag >= 0 && process.argv[rootFlag + 1] ? path.resolve(process.argv[rootFlag + 1]) : null;
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const paths = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
  const contribution = file => ['cheers/', 'mix/proposals/', 'mix/artists/'].some(dir => file.startsWith(dir)) && !file.split('/').includes('..');
  const contributions = paths.filter(contribution);
  const others = paths.filter(file => !contribution(file));
  const documentation = file => !file.split('/').includes('..') &&
    (file.startsWith('docs/') || file.startsWith('memory-bank/') || (file.endsWith('.md') && !file.includes('/')));
  const sensitive = others.filter(file => !documentation(file));
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  const records = ['spec/mix-library.json', 'contributors.json'];
  // contribution() has already refused ".." segments, so the path stays inside root.
  const removed = file => fs.lstatSync(path.join(root, file), { throwIfNoEntry: false }) === undefined;
  const acceptsProposals = root !== null && contributions.every(file => file.startsWith('mix/proposals/') && removed(file)) &&
    others.includes('spec/mix-library.json') && others.every(file => records.includes(file));
  if (contributions.length && others.length && !acceptsProposals) {
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
