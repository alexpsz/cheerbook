'use strict';
// The page Liveglow embeds (site/submit/embed.js), run with a stand-in host bridge, challenge and
// network. Synthetic data only; nothing here opens a pull request.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { buildSite, EMBED_CSP } = require('../tools/build-site');

const ROOT = path.join(__dirname, '..');
const settled = () => new Promise(resolve => setImmediate(resolve));
const success = { ok: true, json: async () => ({ url: 'https://github.com/alexpsz/cheerbook/pull/17' }) };
const confirmed = { chart: '{"events":[]}', nickname: ' 合成昵称 ', contact: '', rightsConfirmed: true };

function page({ host = true, configured = true, replies = [], broken = '' } = {}) {
  const messages = [], requests = [], widgets = [], removed = [];
  const standalone = { hidden: true }, challenge = {};
  let answer, refuse;
  const bridge = {
    postMessage(message) {
      messages.push(JSON.parse(JSON.stringify(message)));
      // Only the payload request is answered, and only when the person confirms.
      return message.type === 'payload' ? new Promise((resolve, reject) => { answer = resolve; refuse = reject; }) : Promise.resolve(null);
    },
  };
  const context = {
    AbortSignal, setTimeout, clearTimeout,
    document: { getElementById: id => ({ challenge, standalone })[id], head: { append() {} }, createElement: () => ({ remove() {} }) },
    window: {
      turnstile: {
        render(element, options) { if (broken === 'render') throw new Error('render'); assert.equal(element, challenge); widgets.push(options); return widgets.length - 1; },
        remove(id) { if (broken === 'remove') throw new Error('remove'); removed.push(id); },
      },
      ...(host ? { webkit: { messageHandlers: { cheerbookSubmission: bridge } } } : {}),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/config')) return { ok: configured, json: async () => ({ siteKey: 'test-only' }) };
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'site/submit/embed.js'), 'utf8'), context);
  const states = () => messages.filter(message => message.type === 'state').map(message => message.state);
  return { messages, requests, widgets, removed, standalone, states, confirm: value => answer(value), close: () => refuse(new Error('closed')) };
}

test('opened in a browser, the embedded page does nothing but point to the editor', async () => {
  const p = page({ host: false });
  await settled();
  assert.equal(p.standalone.hidden, false);
  assert.equal(p.requests.length, 0);
  assert.equal(p.widgets.length, 0);
});

test('an unavailable service is reported to the host and asks for nothing', async () => {
  const p = page({ configured: false });
  await settled();
  assert.deepEqual(p.states(), ['loading', 'unavailable']);
  assert.deepEqual(p.requests.map(request => request.url), ['/api/submissions/config']);
  assert.equal(p.messages.some(message => message.type === 'payload'), false);
  assert.equal(p.standalone.hidden, true);
});

test('the chart is sent once, with the token, only after the challenge and the confirmation in the app', async () => {
  const p = page({ replies: [success] });
  await settled();
  assert.deepEqual(p.states(), ['loading', 'challenge']);
  assert.equal(p.widgets[0].action, 'submit_chart');
  assert.equal(p.widgets[0].sitekey, 'test-only');
  assert.equal(p.messages.filter(message => message.type === 'payload').length, 1);
  assert.equal(p.requests.length, 1, 'nothing is posted while waiting');
  p.widgets[0].callback('fixture-token');
  assert.deepEqual(p.states(), ['loading', 'challenge', 'verified']);
  await settled();
  assert.equal(p.requests.length, 1, 'a solved challenge alone posts nothing');
  p.confirm(confirmed);
  await settled();
  assert.deepEqual(p.requests.map(request => request.url), ['/api/submissions/config', '/api/submissions']);
  const { options } = p.requests[1];
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { chart: '{"events":[]}', nickname: '合成昵称', contact: '', token: 'fixture-token', rightsConfirmed: true });
  assert.deepEqual(p.removed, [0], 'the spent challenge is removed');
  assert.deepEqual(p.messages.at(-1), { type: 'result', url: 'https://github.com/alexpsz/cheerbook/pull/17' });
  assert.deepEqual(p.states().at(-1), 'sending');
});

test('nothing is posted without rights confirmed, a nickname, a chart, or a live token', async () => {
  for (const payload of [{ ...confirmed, rightsConfirmed: false }, { ...confirmed, rightsConfirmed: 'true' }, { ...confirmed, nickname: '  ' },
    { ...confirmed, chart: '' }, { ...confirmed, chart: {} }, { ...confirmed, contact: 3 }, null, 'text']) {
    const p = page({ replies: [success] });
    await settled();
    p.widgets[0].callback('fixture-token');
    p.confirm(payload);
    await settled();
    assert.equal(p.requests.length, 1, JSON.stringify(payload));
    assert.equal(p.messages.at(-1).type, 'failure');
  }
  // The challenge expired while the person was filling in the form.
  const expired = page({ replies: [success] });
  await settled();
  expired.widgets[0].callback('fixture-token');
  expired.widgets[0]['expired-callback']();
  assert.equal(expired.states().at(-1), 'unavailable');
  expired.confirm(confirmed);
  await settled();
  assert.equal(expired.requests.length, 1);
  assert.match(expired.messages.at(-1).message, /验证已过期/);
  // Closing the panel refuses the request: nothing is posted and nothing more is said.
  const closed = page({ replies: [success] });
  await settled();
  closed.widgets[0].callback('fixture-token');
  const before = closed.messages.length;
  closed.close();
  await settled();
  assert.equal(closed.requests.length, 1);
  assert.equal(closed.messages.length, before);
});

test('a refusal shows the service\'s reason; an unknown outcome and a foreign link are failures', async () => {
  const cases = [
    [{ ok: false, json: async () => ({ error: '同名文件已经存在。' }) }, /同名文件已经存在/],
    [{ ok: false, json: async () => ({}) }, /投稿失败/],
    [{ ok: false, json: async () => ({ error: ' \n' }) }, /投稿失败/],
    [{ ok: true, json: async () => ({ url: 'https://github.com/someone/else/pull/1' }) }, /未收到可核对/],
    [{ ok: true, json: async () => ({ url: 'https://github.com/alexpsz/cheerbook/pull/1/files' }) }, /未收到可核对/],
    [new TypeError('network'), /暂时无法确认/],
    [{ ok: true, json: async () => { throw new SyntaxError('not json'); } }, /暂时无法确认/],
  ];
  for (const [reply, expected] of cases) {
    const p = page({ replies: [reply] });
    await settled();
    p.widgets[0].callback('fixture-token');
    p.confirm(confirmed);
    await settled();
    const last = p.messages.at(-1);
    assert.equal(last.type, 'failure');
    assert.match(last.message, expected);
    assert.equal(p.requests.length, 2, 'one attempt per challenge');
  }
});

test('every way out is reported: a check that cannot be shown, and one that cannot be removed', async () => {
  const hidden = page({ broken: 'render', replies: [success] });
  await settled();
  assert.deepEqual(hidden.states(), ['loading', 'challenge', 'unavailable']);
  assert.equal(hidden.messages.some(message => message.type === 'payload'), false, 'no chart is asked for without a check');
  assert.equal(hidden.requests.length, 1);
  // The spent check staying on the page must not stop the request or its report.
  const kept = page({ broken: 'remove', replies: [success] });
  await settled();
  kept.widgets[0].callback('fixture-token');
  kept.confirm(confirmed);
  await settled();
  assert.equal(kept.requests.length, 2);
  assert.deepEqual(kept.messages.at(-1), { type: 'result', url: 'https://github.com/alexpsz/cheerbook/pull/17' });
});

test('the site serves the embedded page bare, with its own policy and no inline code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheerbook-embed-'));
  for (const folder of ['lib', 'site', 'spec']) fs.cpSync(path.join(ROOT, folder), path.join(root, folder), { recursive: true });
  const out = path.join(root, '_site');
  buildSite(root, out);
  const html = fs.readFileSync(path.join(out, 'submit', 'index.html'), 'utf8');
  const scripts = html.match(/<script[^>]*>/g);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^<script src="\/submit\/embed\.js\?v=[0-9a-f]{10}" defer>$/);
  const links = html.match(/<link[^>]*>/g);
  assert.equal(links.length, 1);
  assert.match(links[0], /^<link rel="stylesheet" href="\/submit\/embed\.css\?v=[0-9a-f]{10}">$/);
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|<nav|<header|<footer/i);
  assert.match(html, /<meta name="robots" content="noindex">/);
  for (const file of ['embed.js', 'embed.css']) assert.ok(fs.existsSync(path.join(out, 'submit', file)), file);
  const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
  for (const route of ['/submit/', '/submit/index.html']) {
    assert.ok(headers.includes(`\n${route}\n  ! Content-Security-Policy\n  Content-Security-Policy: ${EMBED_CSP}\n`), route);
  }
  // Only the challenge may load from elsewhere, and the page talks only to this site.
  assert.match(EMBED_CSP, /^default-src 'none'; script-src 'self' https:\/\/challenges\.cloudflare\.com; frame-src https:\/\/challenges\.cloudflare\.com; style-src 'self'; connect-src 'self';/);
  assert.match(EMBED_CSP, /frame-ancestors 'none'$/);
  assert.doesNotMatch(EMBED_CSP, /unsafe|lrclib|\*/);
});
