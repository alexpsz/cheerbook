#!/usr/bin/env node
'use strict';
// Checks every contribution under cheers/ and mix/, and the MIX library (lib/library.js).
//   node tools/check.js [repository root]
// Exits 1 when any file breaks a rule. On GitHub Actions each problem is also written as an
// annotation on the file, so it shows in the pull request. File names and messages carry text
// from contributors, so every line is printed with control and line-break characters escaped:
// nothing a contributor writes can start a line of its own, where the runner would read it as a
// workflow command.
const path = require('node:path');
const { checkLibrary } = require('../lib/library');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { problems, notices, entries, mixes, proposals } = checkLibrary(root);
const annotate = process.env.GITHUB_ACTIONS === 'true';
const LINE_BREAKING = /[\x00-\x1F\x7F\x85\u{2028}\u{2029}]/gu;
const plain = text => String(text).replace(LINE_BREAKING, c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));
// Workflow command escaping: data escapes % CR LF; properties also escape : and ,.
const data = text => plain(text).replace(/%/g, '%25');
const property = text => data(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

for (const [list, mark, level] of [[problems, '✗', 'error'], [notices, '·', 'notice']]) {
  for (const found of list) {
    console.log(`${mark} ${plain(found.file)}：${plain(found.message)}`);
    if (annotate) console.log(`::${level} file=${property(found.file)}::${data(found.message)}`);
  }
}
const counts = `${entries.length} 个应援文件，${mixes.length} 条艺人专属 MIX，${proposals.length} 条通用 MIX 提议`;
console.log(problems.length
  ? `检查未通过：${problems.length} 个问题（通过的：${counts}）。`
  : `检查通过：${counts}，MIX 库无问题。`);
process.exitCode = problems.length ? 1 : 0;
