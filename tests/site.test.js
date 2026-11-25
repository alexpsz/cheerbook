'use strict';
// The website builder (tools/build-site.js) on throw-away libraries: what it writes, that text
// from contributors is escaped, and that pages hold no inline script the CSP would have to allow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite, escapeHTML, href, clock } = require('../tools/build-site');

const ROOT = path.join(__dirname, '..');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheerbook-site-'));
  for (const dir of ['spec', 'site', 'lib']) fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(root, 'cheers'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(content, null, 2) + '\n');
  }
  return root;
}

function chart(song, author) {
  return {
    format: 'liveglow-cheer', version: 1, song,
    events: [{ start: 1, end: 2, kind: 'note', text: '举灯' }],
    credits: { authors: [{ name: author }], permission: 'original' },
  };
}

test('an empty library builds a home page that invites the first contribution', () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  assert.deepEqual(buildSite(root, out), { entries: 0, mixes: 0 });
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /还没有投稿/);
  assert.doesNotMatch(home, /id="filter"/);
  for (const file of ['mix/index.html', '404.html', '_headers', 'index.json', 'spec/cheer.schema.json', 'spec/mix-library.json', 'style.css', 'app.js', 'favicon.svg']) {
    assert.ok(fs.existsSync(path.join(out, file)), file);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8')).count, 0);
});

test('contributors’ text is escaped and their files are published under their paths', () => {
  const evil = '<script>alert(1)</script>"\'&';
  const file = 'cheers/' + evil.replace(/[<>"/\\:*?|]/g, '_') + '/曲/作者.cheer.json';
  const root = makeRepo({ [file]: chart({ title: '曲', artist: evil, duration: 200 }, '<img src=x onerror=1>') });
  const out = path.join(root, '_site');
  assert.deepEqual(buildSite(root, out), { entries: 1, mixes: 0 });
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(home, /<script>alert|<img src=x/);
  assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;&amp;/);
  assert.match(home, new RegExp(`href="${href(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" download`));
  const nativeLink = new URL(home.match(/href="(liveglow:[^"]+)"/)[1]);
  assert.equal(nativeLink.host, 'cheer');
  assert.equal(nativeLink.pathname, '/import');
  assert.deepEqual([...nativeLink.searchParams], [['path', file]]);
  assert.ok(fs.existsSync(path.join(out, file)));
});

test('the home page escapes the production note on its own cheer entry', () => {
  const song = { title: '合成曲目', artist: '合成组合', duration: 180 };
  const withNote = chart(song, '甲');
  withNote.credits.note = '合成<甲> & 乙';
  const root = makeRepo({
    'cheers/合成组合/合成曲目/a.cheer.json': withNote,
    'cheers/合成组合/合成曲目/b.cheer.json': chart({ ...song, duration: 181 }, '乙'),
  });
  const out = path.join(root, '_site');
  buildSite(root, out);
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /<li><span><bdi>甲<\/bdi><\/span><span class="meta">[^<]*说明：<bdi>合成&lt;甲&gt; &amp; 乙<\/bdi>/);
  assert.equal(home.split('说明：').length - 1, 1);
  assert.ok(!home.includes(withNote.credits.note));
});

test('pages load only this site’s own script and style, with no inline code', () => {
  const root = makeRepo({ 'cheers/合成组合/合成曲目/a.cheer.json': chart({ title: '合成曲目', artist: '合成组合', duration: 180 }, '甲') });
  const out = path.join(root, '_site');
  buildSite(root, out);
  for (const page of ['index.html', 'mix/index.html', '404.html']) {
    const html = fs.readFileSync(path.join(out, page), 'utf8');
    const scripts = html.match(/<script[^>]*>/g) || [];
    assert.equal(scripts.length, 1, page);
    assert.match(scripts[0], /^<script src="\/app\.js\?v=[0-9a-f]{10}" defer>$/, page);
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, page);
    assert.doesNotMatch(html, /(src|href)="\/\/|<link[^>]+href="https?:/, page);
  }
  const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
  assert.match(headers, /script-src 'self'; style-src 'self'/);
  assert.match(headers, /\/index\.json\n {2}Access-Control-Allow-Origin: \*/);
});

test('the MIX page lists every built-in entry with its sources', () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  buildSite(root, out);
  const library = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'mix-library.json'), 'utf8'));
  const page = fs.readFileSync(path.join(out, 'mix/index.html'), 'utf8');
  for (const entry of library.entries) assert.match(page, new RegExp(`id="mix-${entry.id}"`));
  assert.equal((page.match(/<article /g) || []).length, library.entries.length);
});

test('it never replaces a folder it did not create', () => {
  const root = makeRepo({});
  const out = path.join(root, 'precious');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'keep.txt'), 'mine');
  assert.throws(() => buildSite(root, out), /不会覆盖/);
  assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'mine');
  const site = path.join(root, '_site');
  buildSite(root, site);
  buildSite(root, site);
  assert.ok(fs.existsSync(path.join(site, 'index.html')));
});

test('escaping covers the five HTML-significant characters', () => {
  assert.equal(escapeHTML(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(href('cheers/甲 乙/曲#1/a.cheer.json'), '/cheers/%E7%94%B2%20%E4%B9%99/%E6%9B%B2%231/a.cheer.json');
});

test('song lengths read as m:ss', () => {
  assert.equal(clock(241), '4:01');
  assert.equal(clock(59.6), '1:00');
  assert.equal(clock(180), '3:00');
});

test('one artist and one song per folder, whatever the case or spacing the files use', () => {
  const root = makeRepo({
    'cheers/BiSH/合成曲目/a.cheer.json': chart({ title: '合成曲目', artist: 'BiSH', duration: 180 }, '甲'),
    'cheers/BiSH/合成曲目/b.cheer.json': chart({ title: '合成曲目 ', artist: 'BISH', duration: 181 }, '乙'),
  });
  const out = path.join(root, '_site');
  buildSite(root, out);
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.equal((home.match(/data-artist/g) || []).length, 1);
  assert.equal((home.match(/class="song card"/g) || []).length, 1);
  assert.match(home, /<h3><bdi>BiSH<\/bdi><\/h3>/);
});

test('bidirectional controls are removed from contributors’ text and each piece is isolated', () => {
  const override = String.fromCodePoint(0x202E);
  const root = makeRepo({ 'cheers/合成组合/合成曲目/a.cheer.json': chart({ title: '合成曲目', artist: '合成组合', duration: 180 }, 'abc' + override + 'def') });
  const out = path.join(root, '_site');
  buildSite(root, out);
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(!home.includes(override));
  assert.match(home, /<bdi>abcdef<\/bdi>/);
});

test('the search box is hidden until the script shows it, and the 404 page marks no link as current', () => {
  const root = makeRepo({ 'cheers/合成组合/合成曲目/a.cheer.json': chart({ title: '合成曲目', artist: '合成组合', duration: 180 }, '甲') });
  const out = path.join(root, '_site');
  buildSite(root, out);
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /<div class="filter" hidden>/);
  assert.doesNotMatch(fs.readFileSync(path.join(out, '404.html'), 'utf8'), /aria-current/);
  assert.match(fs.readFileSync(path.join(out, 'mix/index.html'), 'utf8'), /<a href="\/mix\/" aria-current="page">/);
});

test('a symbolic link anywhere among the copied files stops the build', () => {
  const root = makeRepo({});
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, '{"secret": true}');
  fs.rmSync(path.join(root, 'spec', 'cheer.schema.json'));
  fs.symlinkSync(outside, path.join(root, 'spec', 'cheer.schema.json'));
  assert.throws(() => buildSite(root, path.join(root, '_site')), /spec\/cheer\.schema\.json 不是普通文件/);
  const second = makeRepo({});
  fs.renameSync(path.join(second, 'site'), path.join(second, 'real-site'));
  fs.symlinkSync(path.join(second, 'real-site'), path.join(second, 'site'));
  assert.throws(() => buildSite(second, path.join(second, '_site')), /site 不是普通文件夹/);
});

test('a library with problems lists them in the build error', () => {
  const root = makeRepo({ 'cheers/loose.cheer.json': chart({ title: '合成曲目', artist: '合成组合', duration: 180 }, '甲') });
  assert.throws(() => buildSite(root, path.join(root, '_site')), /网站没有生成：\ncheers\/loose\.cheer\.json：/);
});

test('the editor page loads only its own module script and stylesheet, under its own CSP', () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  buildSite(root, out);
  const page = fs.readFileSync(path.join(out, 'editor', 'index.html'), 'utf8');
  const scripts = page.match(/<script[^>]*>/g);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^<script type="module" src="\/editor\/app\.js\?v=[0-9a-f]{10}">$/);
  assert.match(page, /<link rel="stylesheet" href="\/editor\/editor\.css\?v=[0-9a-f]{10}">/);
  assert.doesNotMatch(page, /<style|\sstyle=|\son[a-z]+=/i);
  for (const file of ['app.js', 'dom.js', 'submission.js', 'analysis-worker.js', 'editor.css', 'lib.js']) assert.ok(fs.existsSync(path.join(out, 'editor', file)), file);
  assert.ok(!fs.existsSync(path.join(out, 'editor', 'page.html')));
  const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
  assert.match(headers, /\n\/editor\/\n {2}! Content-Security-Policy\n {2}Content-Security-Policy: [^\n]*media-src blob:; worker-src 'self'; connect-src 'self' https:\/\/lrclib\.net;/);
});

test('the browser bundle holds every pure lib module and none that touch the file system', async () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  buildSite(root, out);
  const bundle = fs.readFileSync(path.join(out, 'editor', 'lib.js'), 'utf8');
  assert.doesNotMatch(bundle, /require\(['"]node:|require\(['"]fs['"]\)/);
  const names = fs.readdirSync(path.join(ROOT, 'lib')).filter(file => file.endsWith('.js') && file !== 'library.js').map(file => file.slice(0, -3));
  for (const name of names) assert.match(bundle, new RegExp(`^${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: function \\(module, exports, require\\) \\{$`, 'm'), name);
  const lib = (await import('data:text/javascript;base64,' + Buffer.from(bundle).toString('base64'))).default;
  assert.equal(typeof lib.cheer.parse, 'function');
  assert.equal(lib.paths.folderName('A/B'), 'A_B');
  assert.match(lib.messages.issueMessage({ code: 'songTitle', path: 'song.title' }), /缺少歌名/);
});

test('a lib module that requires something outside the bundle stops the build', () => {
  const root = makeRepo({});
  fs.writeFileSync(path.join(root, 'lib', 'leaky.js'), "'use strict';\nmodule.exports = require('node:fs');\n");
  assert.throws(() => buildSite(root, path.join(root, '_site')), /lib\/leaky\.js 引用了包外的模块/);
});

test('only the chart editor may load a video player, from exactly the hosts the link reader names', () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  buildSite(root, out);
  const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
  const policy = route => {
    const found = new RegExp(`\\n${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(?: {2}[^\\n]*\\n)*? {2}Content-Security-Policy: ([^\\n]*)\\n`).exec('\n' + headers);
    assert.ok(found, route);
    return Object.fromEntries(found[1].split(';').map(part => part.trim().split(' ')).map(([name, ...values]) => [name, values]));
  };
  const video = require('../lib/video.js');
  for (const route of ['/editor/', '/editor/index.html']) {
    const csp = policy(route);
    assert.deepEqual(csp['script-src'], ["'self'", 'https://challenges.cloudflare.com', 'https://www.youtube.com'], route);
    assert.deepEqual(csp['frame-src'], ['https://challenges.cloudflare.com', 'https://www.youtube.com', 'https://player.bilibili.com', 'https://www.bilibili.com'], route);
    // Every video host allowed is one lib/video.js builds addresses for, and nothing else is.
    const allowed = new Set([...video.YOUTUBE_FRAME_ORIGINS, ...video.BILIBILI_FRAME_ORIGINS]);
    for (const origin of csp['frame-src'].slice(1)) assert.ok(allowed.has(origin), origin);
    assert.deepEqual(csp['default-src'], ["'none'"]);
    assert.deepEqual(csp['connect-src'], ["'self'", 'https://lrclib.net']);
    assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  }
  // Every other page keeps its policy: no video host anywhere else.
  const rest = headers.split('\n').filter(line => line.includes('Content-Security-Policy:') && /youtube|bilibili/.test(line));
  assert.equal(rest.length, 2);
  assert.doesNotMatch(policy('/*')['script-src'].join(' '), /https:/);
  assert.equal(policy('/*')['frame-src'], undefined);
});

test('no page carries a video player, or anything of another site, before the visitor asks', () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  buildSite(root, out);
  const page = fs.readFileSync(path.join(out, 'editor', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /<iframe|<script[^>]+src="https?:|rel="preconnect"|rel="dns-prefetch"|rel="preload"/i);
  assert.doesNotMatch(page, /youtube\.com\/(?:embed|iframe_api)|player\.bilibili\.com/);
  // The only address of YouTube's script is in the module that loads it on request.
  const loader = fs.readFileSync(path.join(out, 'editor', 'youtube.js'), 'utf8');
  assert.match(loader, /const API_SRC = 'https:\/\/www\.youtube\.com\/iframe_api';/);
  for (const file of ['app.js', 'timesource.js', 'dom.js', 'submission.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(out, 'editor', file), 'utf8'), /https:\/\/(?:www\.)?youtube\.com\/(?:embed|iframe_api)|https:\/\/player\.bilibili\.com/, file);
  }
});

test('the privacy page says which services are reached and links the terms YouTube asks for', () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  buildSite(root, out);
  const page = fs.readFileSync(path.join(out, 'privacy', 'index.html'), 'utf8');
  assert.match(page, /YouTube API 服务/);
  assert.match(page, /href="https:\/\/www\.youtube\.com\/t\/terms"/);
  assert.match(page, /href="http:\/\/www\.google\.com\/policies\/privacy"/);
  for (const name of ['LRCLIB', 'Cloudflare Turnstile', '哔哩哔哩']) assert.ok(page.includes(name), name);
  assert.doesNotMatch(page, /<script/);
  // Reachable from every page, and from where the video is loaded.
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /<a href="\/privacy\/">隐私说明<\/a>/);
  const editor = fs.readFileSync(path.join(out, 'editor', 'index.html'), 'utf8');
  assert.match(editor, /id="video-consent-youtube"[^>]*>[^]*?href="https:\/\/www\.youtube\.com\/t\/terms"[^]*?href="http:\/\/www\.google\.com\/policies\/privacy"[^]*?href="\/privacy\/"/);
});

test('every page and script asks for the scripts and styles of its own build, by one version', () => {
  const root = makeRepo({});
  const out = path.join(root, '_site');
  buildSite(root, out);
  const texts = ['index.html', 'mix/index.html', '404.html', 'privacy/index.html', 'editor/index.html', 'editor/mix/index.html', 'submit/index.html',
    ...fs.readdirSync(path.join(out, 'editor')).filter(file => file.endsWith('.js')).map(file => 'editor/' + file), 'submit/embed.js']
    .map(file => [file, fs.readFileSync(path.join(out, file), 'utf8')]);
  const versions = new Set();
  let named = 0;
  for (const [file, text] of texts) {
    // Any quoted address of one of this site's scripts or styles, with or without a version.
    for (const [, address, version] of text.matchAll(/["'](\/(?:(?:editor|submit)\/[A-Za-z0-9._-]+|style|app)\.(?:js|css))(\?v=[0-9a-f]{10})?["']/g)) {
      assert.ok(version, `${file} names ${address} without a version`);
      versions.add(version);
      named++;
      assert.ok(fs.existsSync(path.join(out, address)), address);
    }
  }
  assert.ok(named >= 12, String(named));
  assert.equal(versions.size, 1);
  // The scripts import each other and start the analysis worker by versioned addresses too.
  const app = fs.readFileSync(path.join(out, 'editor', 'app.js'), 'utf8');
  const [version] = versions;
  for (const name of ['lib', 'dom', 'submission', 'timesource', 'youtube']) assert.ok(app.includes(`from '/editor/${name}.js${version}'`), name);
  assert.ok(app.includes(`new Worker('/editor/analysis-worker.js${version}'`));
  // A change to any of them is a new version; the same sources always give the same one.
  const again = path.join(root, '_again');
  buildSite(root, again);
  assert.ok(fs.readFileSync(path.join(again, 'editor', 'index.html'), 'utf8').includes(version));
  fs.appendFileSync(path.join(root, 'site', 'editor', 'dom.js'), '\n// changed\n');
  const changed = path.join(root, '_changed');
  buildSite(root, changed);
  assert.ok(!fs.readFileSync(path.join(changed, 'editor', 'index.html'), 'utf8').includes(version));
});
