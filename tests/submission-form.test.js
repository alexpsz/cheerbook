'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function form({ configured = true, replies = [] } = {}) {
  const elements = new Map(), requests = [], widgets = [], removed = [];
  function $(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: true, checked: false, disabled: false, textContent: '',
      items: [], prepend(value) { this.items.unshift(value); },
      focus() {}, setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
      addEventListener(type, listener) { this[type] = listener; },
    });
    return elements.get(id);
  }
  const context = {
    document: { createElement: () => ({ replaceChildren(...items) { this.items = items; } }) },
    window: { turnstile: {
      render(_element, options) { widgets.push(options); return widgets.length - 1; },
      remove(id) { removed.push(id); },
    } }, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/config')) return { ok: configured, json: async () => ({ siteKey: 'test-only' }) };
      return replies.shift();
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../site/editor/submission.js'), 'utf8');
  vm.runInNewContext(source.replace('export function setupSubmission', 'function setupSubmission'), context);
  const target = { path: 'cheers/组合/合成曲/署名.cheer.json', sha256: 'a'.repeat(64) };
  const prepared = { chart: '{"events":[]}', target };
  return { $, requests, widgets, removed, prepared, ...context.setupSubmission($, () => prepared) };
}

const settled = () => new Promise(resolve => setImmediate(resolve));
const success = { ok: true, json: async () => ({ url: 'https://github.com/alexpsz/cheerbook/pull/17' }) };

test('accountless submission is opt-in; unavailable service keeps a retry and creates no PR', async () => {
  const f = form({ configured: false });
  assert.equal(f.requests.length, 0);
  f.open('合成昵称');
  await settled();
  assert.equal(f.widgets.length, 0);
  assert.equal(f.$('submission-retry').hidden, false);
  assert.equal(f.$('submission-send').disabled, true);
  await f.$('submission-send').click();
  assert.deepEqual(f.requests.map(r => r.url), ['/api/submissions/config']);
});

test('sends only the prepared chart, revision and confirmed public form fields once', async () => {
  const f = form({ replies: [success] });
  f.open('合成昵称');
  await settled();
  assert.equal(f.widgets[0].action, 'submit_chart');
  f.widgets[0].callback('fixture-token');
  assert.equal(f.$('submission-send').disabled, true);
  f.$('submission-rights').checked = true;
  f.$('submission-contact').value = 'https://example.com/test';
  f.$('submission-rights').input();
  const first = f.$('submission-send').click();
  await f.$('submission-send').click();
  await first;
  const payload = JSON.parse(f.requests[1].options.body);
  assert.deepEqual(payload, { ...f.prepared, nickname: '合成昵称', contact: 'https://example.com/test', token: 'fixture-token', rightsConfirmed: true });
  assert.equal(f.$('submission-receipt').href, 'https://github.com/alexpsz/cheerbook/pull/17');
  assert.equal(f.$('submission-send').disabled, true);
  assert.equal(f.requests.length, 2);
});

test('expired, stale and refused challenges require a fresh widget; links must identify a CheerBook PR', async () => {
  const f = form({ replies: [
    { ok: false, json: async () => ({ error: '投稿过于频繁' }) },
    { ok: true, json: async () => ({ url: 'https://example.com/pull/17' }) },
  ] });
  f.open('昵称');
  await settled();
  f.$('submission-rights').checked = true;
  f.widgets[0].callback('token');
  f.widgets[0]['expired-callback']();
  assert.equal(f.$('submission-send').disabled, true);
  await f.$('submission-retry').click();
  f.widgets[0].callback('stale');
  assert.equal(f.$('submission-send').disabled, true);
  f.widgets[1].callback('fresh');
  await f.$('submission-send').click();
  assert.match(f.$('submission-status').textContent, /过于频繁/);
  await f.$('submission-retry').click();
  f.widgets[2].callback('retry');
  await f.$('submission-send').click();
  assert.equal(f.$('submission-receipt').hidden, true);
  assert.match(f.$('submission-status').textContent, /链接/);
  f.close();
  assert.equal(f.$('submission-rights').checked, false);
});


test('a late receipt stays with its original song after closing and reopening the dialog', async () => {
  let resolveFirst;
  const firstResponse = new Promise(resolve => { resolveFirst = resolve; });
  const f = form({ replies: [firstResponse, { ok: true, json: async () => ({ url: 'https://github.com/alexpsz/cheerbook/pull/18' }) }] });
  f.prepared.chart = JSON.stringify({ song: { title: '第一首', artist: '甲' } });
  f.open('昵称');
  await settled();
  f.$('submission-rights').checked = true;
  f.widgets[0].callback('first');
  const pending = f.$('submission-send').click();
  f.close();
  f.prepared.chart = JSON.stringify({ song: { title: '第二首', artist: '乙' } });
  f.open('第二位');
  await settled();
  f.$('submission-rights').checked = true;
  f.widgets[1].callback('second');
  resolveFirst(success);
  await pending;
  assert.equal(f.$('submission-receipt').hidden, true);
  assert.equal(f.$('submission-send').disabled, false);
  assert.equal(f.$('submission-history').items[0].items[0], '甲 · 第一首 · ');
  assert.equal(f.$('submission-history').items[0].items[1].href, 'https://github.com/alexpsz/cheerbook/pull/17');
  await f.$('submission-send').click();
  assert.equal(f.$('submission-receipt').href, 'https://github.com/alexpsz/cheerbook/pull/18');
  f.close();
  f.open('新的昵称');
  await settled();
  assert.equal(f.$('submission-receipt').hidden, true);
  assert.equal(f.$('submission-receipt').href, undefined);
  assert.equal(f.$('submission-history').items.length, 2);
});
