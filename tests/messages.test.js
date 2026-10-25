'use strict';
// Every issue code the format can report has a sentence, and places read as Liveglow's do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { issueMessage, issuePlace, isWarning, SENTENCE_CODES } = require('../lib/messages');

test('every error and warning code in the spec has a sentence', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'spec', 'README.md'), 'utf8');
  const section = spec.slice(spec.indexOf('## 7.'), spec.indexOf('## 8.'));
  const codes = [...section.matchAll(/^\| `([A-Za-z]+)`/gm)].map(match => match[1]);
  assert.ok(codes.length > 40);
  for (const code of codes) assert.ok(SENTENCE_CODES.includes(code), code);
  for (const code of ['lyricOverlap', 'lyricsUnchecked']) assert.ok(SENTENCE_CODES.includes(code), code);
});

test('places are named in words', () => {
  assert.equal(issueMessage({ code: 'textRequired', path: 'events[2].text' }), '第 3 条应援：请填写文字。');
  assert.equal(issueMessage({ code: 'memberName', path: 'members[0].name' }), '第 1 位成员：请填写成员名字（最多 32 个字）。');
  assert.equal(issueMessage({ code: 'url', path: 'credits.authors[1].url' }), '第 2 位作者的链接：链接需要以 http:// 或 https:// 开头，并且是有效的网址。');
  assert.equal(issuePlace({ code: 'authorName', path: 'credits.authors[0].name' }), null);
  assert.equal(issueMessage({ code: 'textTooLong', path: 'events[0].text', detail: 60 }), '第 1 条应援：文字太长了，最多 60 个字。');
  assert.equal(issueMessage({ code: 'songTitle', path: 'song.title' }), '缺少歌名。');
  assert.equal(isWarning({ code: 'readings' }), true);
  assert.equal(isWarning({ code: 'eventTime' }), false);
});
