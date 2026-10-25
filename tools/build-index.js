#!/usr/bin/env node
'use strict';
// Writes index.json from the files under cheers/ that pass every check.
//   node tools/build-index.js [--check]
// --check writes nothing and exits 1 when index.json is out of date. The output has no date or
// other changing field, so the same library always gives the same bytes.
const fs = require('node:fs');
const path = require('node:path');
const { checkLibrary, buildIndex } = require('../lib/library');

const root = path.join(__dirname, '..');
const target = path.join(root, 'index.json');
const { problems, entries } = checkLibrary(root);
if (problems.length) {
  console.error(`有 ${problems.length} 个问题，先运行 node tools/check.js 修正后再生成索引。`);
  process.exit(1);
}
const text = JSON.stringify(buildIndex(entries), null, 2) + '\n';
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
if (process.argv.includes('--check')) {
  if (current !== text) { console.error('index.json 不是最新的：运行 node tools/build-index.js。'); process.exit(1); }
  console.log(`index.json 是最新的（${entries.length} 个应援文件）。`);
} else if (current !== text) {
  fs.writeFileSync(target, text);
  console.log(`已更新 index.json（${entries.length} 个应援文件）。`);
} else {
  console.log(`index.json 已是最新（${entries.length} 个应援文件）。`);
}
