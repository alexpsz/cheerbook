#!/usr/bin/env node
'use strict';
// Moves merged proposals (mix/proposals/<id>.mix.json) into the built-in MIX library
// spec/mix-library.json and deletes them (C-011 ③). Runs on main after a merge, before the index
// is rebuilt (.github/workflows/index.yml); a maintainer can run it by hand too.
//   node tools/accept-mix-proposals.js [--check] [--root <repository root>]
// Each proposal must pass the community checks against the library as it grows. One that does not
// (two pull requests checked green one at a time can still clash once both are merged) is left in
// place and reported, and the others are accepted, so the rest of the post-merge work (contributor
// records, index.json) is not held up; "检查" on main stays red until a maintainer removes or fixes
// it. The exit code is 1 only when the library itself is broken.
// --check writes nothing and only reports what would be accepted.
const fs = require('node:fs');
const path = require('node:path');
const { checkMixLibrary, checkMixContributions, regularFile } = require('../lib/library');
const mixes = require('../lib/mixes');

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = path.resolve(rootFlag >= 0 ? args[rootFlag + 1] : path.join(__dirname, '..'));
const libraryFile = 'spec/mix-library.json';
const LINE_BREAKING = /[\x00-\x1F\x7F\x85\u{2028}\u{2029}]/gu;
const plain = text => String(text).replace(LINE_BREAKING, c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));

const libraryProblems = checkMixLibrary(root);
if (libraryProblems.length) {
  for (const found of libraryProblems) console.error(`✗ ${plain(found.file)}：${plain(found.message)}`);
  console.error('内置 MIX 库本身有问题，先修正再并入提议。');
  process.exit(1);
}
regularFile(root, libraryFile);
const library = JSON.parse(fs.readFileSync(path.join(root, libraryFile), 'utf8'));
const { problems, proposals } = checkMixContributions(root, library);
const proposalProblems = problems.filter(found => found.file.startsWith(mixes.PROPOSALS_DIR + '/'));
if (proposalProblems.length) {
  for (const found of proposalProblems) console.log(`✗ ${plain(found.file)}：${plain(found.message)}`);
  console.log(`有 ${proposalProblems.length} 个问题，这些提议留在原处没有并入，请维护者修正或删除。`);
}
if (!proposals.length) {
  console.log('没有待并入的通用 MIX 提议。');
  process.exit(0);
}
const next = mixes.acceptProposals(library, proposals.map(item => item.proposal));
const names = proposals.map(item => `${item.proposal.id}（${item.proposal.name}）`).map(plain).join('、');
if (args.includes('--check')) {
  console.log(`可以并入 ${proposals.length} 条：${names}。`);
  process.exit(0);
}
fs.writeFileSync(path.join(root, libraryFile), mixes.serializeLibrary(next));
for (const item of proposals) {
  regularFile(root, item.path);
  fs.unlinkSync(path.join(root, item.path));
}
console.log(`已并入内置 MIX 库 ${proposals.length} 条：${names}。`);
