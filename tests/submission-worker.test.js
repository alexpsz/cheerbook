'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, generateKeyPairSync, verify } = require('node:crypto');

const worker = import('../worker/index.js');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = privateKey.export({ type: 'pkcs1', format: 'pem' });
const env = () => ({
  TURNSTILE_SITE_KEY: 'synthetic-site', TURNSTILE_SECRET: 'synthetic-secret', GITHUB_APP_ID: '12',
  GITHUB_INSTALLATION_ID: '34', GITHUB_PRIVATE_KEY: key, SUBMISSION_RATE_LIMITER: {
    limit: async input => ({ success: input.key === '192.0.2.1' }),
  },
});
const origin = 'https://cheerbook.kozueginko.com';
const recording = { title: '合成星', artist: '合成团', duration: 66 };
function chart(text) {
  return {
    format: 'liveglow-cheer', version: 1, song: recording,
    events: text ? [{ kind: 'call', start: 9, end: 10, text }] : [],
    credits: { authors: [{ name: '时间轴作者' }], permission: 'original', sources: [{ kind: 'self' }] },
  };
}
function input(text) {
  return { chart: JSON.stringify(chart(text)), token: 'synthetic', nickname: '投稿昵称',
    contact: 'https://example.com/profile', rightsConfirmed: true };
}
function request(payload, headers = {}) {
  return new Request(origin + '/api/submissions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': '192.0.2.1', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

const resp = (data = {}, status = 200) => Response.json(data, { status });
const sha = n => String(n).repeat(40);
function upstream(options = {}) {
  const state = { calls: [], pr: null, ref: false, content: null, base: sha(1), errors: [] };
  async function fetcher(address, init = {}) {
    const url = new URL(address), api = url.pathname;
    state.calls.push(url.hostname + api);
    try {
      assert.equal(init.redirect, 'manual', 'workerd requires manual redirect handling');
      if (url.hostname === 'challenges.cloudflare.com') {
        assert.equal(api, '/turnstile/v0/siteverify');
        assert.equal(init.body.get('secret'), 'synthetic-secret');
        assert.equal(init.body.get('remoteip'), '192.0.2.1');
        return resp(options.challenge || { success: true, hostname: 'cheerbook.kozueginko.com', action: 'submit_chart' });
      }
      if (url.hostname === 'lrclib.net') {
        assert.deepEqual([...url.searchParams.keys()], ['track_name', 'artist_name', 'duration']);
        return options.lyrics ? resp(options.lyrics) : resp({}, 404);
      }
      assert.equal(url.origin, 'https://api.github.com');
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      if (api === '/app/installations/34/access_tokens') {
        const [header, payload, signature] = init.headers.Authorization.slice(7).split('.');
        assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url')));
        assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '12');
        assert.deepEqual(body, { repositories: ['cheerbook'], permissions: { contents: 'write', pull_requests: 'write' } });
        return resp({ token: 'temporary' }, 201);
      }
      assert.equal(init.headers.Authorization, 'Bearer temporary');
      assert.ok(api.startsWith('/repos/alexpsz/cheerbook/'));
      const route = api.slice('/repos/alexpsz/cheerbook'.length);
      if (route === '/pulls' && !body) return resp(state.pr ? [state.pr] : []);
      if (route === '/branches/main') return resp({ commit: { sha: state.base, commit: { tree: { sha: sha(2) } } } });
      if (route.startsWith('/contents/')) {
        assert.equal(url.searchParams.get('ref'), state.base);
        return options.original ? resp({ type: 'file', encoding: 'base64', content: Buffer.from(options.original).toString('base64') }) : resp({}, 404);
      }
      if (route === '/git/trees') {
        assert.equal(body.tree.length, 1);
        assert.match(body.tree[0].path, /^cheers\//);
        assert.equal(body.tree[0].mode, '100644');
        state.content = JSON.parse(body.tree[0].content);
        return resp({ sha: sha(3) }, 201);
      }
      if (route === '/git/commits' && body) return resp({ sha: sha(4) }, 201);
      if (route === '/git/refs') {
        assert.match(body.ref, /^refs\/heads\/submission\/[a-f0-9]{64}$/);
        if (state.ref) return resp({}, 422);
        state.ref = true;
        return resp({}, 201);
      }
      if (route.startsWith('/git/ref/heads/submission/')) return resp({ object: { sha: sha(4) } });
      if (route === '/git/commits/' + sha(4)) return resp({ tree: { sha: sha(3) }, parents: [{ sha: sha(1) }] });
      if (route.startsWith('/compare/')) return resp({ merge_base_commit: { sha: sha(1) } });
      if (route === '/git/commits/' + sha(1)) return resp({ tree: { sha: sha(2) } });
      if (route === '/pulls' && body) {
        if (options.interrupt && !state.interrupted) {
          state.interrupted = true; return resp({}, 502);
        }
        assert.equal(body.base, 'main');
        assert.match(body.head, /^submission\/[a-f0-9]{64}$/);
        state.pr = { ...body, head: { ref: body.head, repo: { full_name: 'alexpsz/cheerbook' } },
          base: { ref: body.base }, number: 42 };
        return resp(state.pr, 201);
      }
      assert.fail('unexpected upstream call: ' + api);
    } catch (error) {
      state.errors.push(error);
      throw error;
    }
  }
  return { state, fetcher };
}

test('public config exposes only site key, missing setup fails closed, origin and rate are enforced', async () => {
  const { handle } = await worker;
  const config = new Request(origin + '/api/submissions/config');
  assert.deepEqual(await (await handle(config, env())).json(), { siteKey: 'synthetic-site' });
  assert.equal((await handle(config, {})).status, 503);
  assert.equal((await handle(request(input(), { origin: 'https://example.com' }), env())).status, 403);
  assert.equal((await handle(request(input(), { 'CF-Connecting-IP': '192.0.2.2' }), env())).status, 429);
  const huge = request('x'.repeat(2 * 512 * 1024 + 12 * 1024 + 1));
  assert.equal((await handle(huge, env())).status, 413);
});

test('valid accountless submission uses scoped, signed App token and receives an idempotent PR', async () => {
  const { handle } = await worker;
  const u = upstream();
  const data = input();
  for (let i = 0; i < 2; i++) {
    const r = await handle(request(data), env(), u.fetcher);
    assert.deepEqual(u.state.errors, []);
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { url: 'https://github.com/alexpsz/cheerbook/pull/42' });
  }
  assert.equal(u.state.calls.filter(c => c.endsWith('/git/refs')).length, 1);
  assert.equal(u.state.pr.draft, false);
  assert.match(u.state.pr.body, /https:\/\/example.com\/profile/);
  assert.deepEqual(u.state.content.credits.authors, [{ name: '时间轴作者' }]);
  assert.deepEqual(u.state.content.submittedBy, { name: '投稿昵称', url: data.contact });
  assert.ok(!u.state.calls.some(c => c.startsWith('lrclib.net')));
});

test('human verification checks token presence, successful result, hostname and action before GitHub', async () => {
  const { handle } = await worker;
  for (const challenge of [
    { success: false }, { success: true, action: 'submit_chart', hostname: 'example.com' },
    { success: true, action: 'other', hostname: 'cheerbook.kozueginko.com' },
  ]) {
    const u = upstream({ challenge });
    assert.equal((await handle(request(input()), env(), u.fetcher)).status, 403);
    assert.equal(u.state.calls.length, 1);
  }
  assert.equal((await handle(request({ ...input(), token: '' }), env())).status, 403);
});

test('invalid file, hidden lyric field, unrecognized fields, oversize, unsafe path and metadata stop before GitHub', async () => {
  const { handle } = await worker;
  const c = chart(), valid = input();
  const cases = [
    [{ chart: JSON.stringify({ ...c, version: '1' }) }, 422],
    [{ chart: valid.chart.replace('"version":1', '"version":1,"version":1') }, 422],
    [{ chart: JSON.stringify({ ...c, other: { lines: ['synthetic'] } }) }, 422],
    [{ chart: JSON.stringify({ ...c, fileFromEditor: 'private' }) }, 422],
    [{ chart: ' '.repeat(512 * 1024 + 1) }, 413],
    [{ rightsConfirmed: false }, 422], [{ nickname: 'a'.repeat(65) }, 422],
    [{ contact: 'https://example.com/' + 'a'.repeat(301) }, 422], [{ contact: 'test@example.com' }, 422],
    [{ target: { path: 'cheers/../x/y.cheer.json', sha256: '0'.repeat(64) } }, 422],
  ];
  for (const [fields, status] of cases) {
    const u = upstream();
    const r = await handle(request({ ...valid, ...fields }), env(), u.fetcher);
    assert.equal(r.status, status, JSON.stringify(await r.json()));
    assert.ok(!u.state.calls.some(call => call.startsWith('api.github.com')));
  }
});

test('a known lyric match blocks; unmatched recording is draft; verified nonmatch is ready', async () => {
  const { handle } = await worker;
  const rec = { trackName: recording.title, artistName: recording.artist, duration: 66, plainLyrics: '合成原文四个字' };
  for (const [lyrics, text, status, draft] of [
    [rec, '原文四个字', 422, null],
    [null, '合成口号', 201, true],
    [{ ...rec, duration: 99 }, '合成口号', 201, true],
    [rec, '合成口号', 201, false],
  ]) {
    const u = upstream({ lyrics });
    const r = await handle(request(input(text)), env(), u.fetcher);
    assert.deepEqual(u.state.errors, []);
    assert.equal(r.status, status);
    if (draft === null) assert.ok(!u.state.calls.some(c => c.startsWith('api.github.com')));
    else assert.equal(u.state.pr.draft, draft);
  }
});

test('explicit revisions require original digest and keep prior authors, no accidental overwrite or recreation', async () => {
  const { handle } = await worker;
  const original = JSON.stringify({ ...chart(), submittedBy: { name: '第一次投稿者' } });
  const sha256 = createHash('sha256').update(original).digest('hex');
  const target = { path: 'cheers/合成团/合成星/原文件.cheer.json', sha256 };
  for (const [base, override, status] of [
    [original, { chart: original, target, contact: '@Synthetic' }, 201],
    [original, {}, 409], [null, { target }, 409],
    [original, { target: { ...target, sha256: '0'.repeat(64) } }, 409],
  ]) {
    const u = upstream({ original: base });
    const r = await handle(request({ ...input(), ...override }), env(), u.fetcher);
    assert.deepEqual(u.state.errors, []);
    assert.equal(r.status, status, JSON.stringify(await r.json()));
    if (status !== 201) assert.ok(!u.state.ref);
    else {
      assert.equal(u.state.content.submittedBy.url, 'https://x.com/Synthetic');
      assert.equal(u.state.content.credits.authors[0].name, '时间轴作者');
    }
  }
});

test('ref survives interrupted PR creation and advances on main without duplicate PR', async () => {
  const { handle } = await worker;
  const u = upstream({ interrupt: true });
  const data = input();
  assert.equal((await handle(request(data), env(), u.fetcher)).status, 502);
  u.state.base = sha(5);
  const r = await handle(request(data), env(), u.fetcher);
  assert.deepEqual(u.state.errors, []);
  assert.equal(r.status, 201);
  assert.equal(u.state.pr.number, 42);
});

test('actual Worker schema engine agrees with all published fixture expectations', async () => {
  const { validateSchema } = await import('../worker/chart.js');
  const root = path.join(__dirname, '../spec/samples');
  const suite = JSON.parse(fs.readFileSync(path.join(root, 'expected.json')));
  for (const { file, schema } of suite.samples) {
    if (schema === null) continue;
    const content = fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
    assert.equal(validateSchema(JSON.parse(content)), schema, file);
  }
});
