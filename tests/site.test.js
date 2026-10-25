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
  assert.ok(fs.existsSync(path.join(out, file)));
});

test('pages load only this site’s own script and style, with no inline code', () => {
  const root = makeRepo({ 'cheers/合成组合/合成曲目/a.cheer.json': chart({ title: '合成曲目', artist: '合成组合', duration: 180 }, '甲') });
  const out = path.join(root, '_site');
  buildSite(root, out);
  for (const page of ['index.html', 'mix/index.html', '404.html']) {
    const html = fs.readFileSync(path.join(out, page), 'utf8');
    const scripts = html.match(/<script[^>]*>/g) || [];
    assert.deepEqual(scripts, ['<script src="/app.js" defer>'], page);
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
  assert.deepEqual(page.match(/<script[^>]*>/g), ['<script type="module" src="/editor/app.js">']);
  assert.match(page, /<link rel="stylesheet" href="\/editor\/editor.css">/);
  assert.doesNotMatch(page, /<style|\sstyle=|\son[a-z]+=/i);
  for (const file of ['app.js', 'dom.js', 'analysis-worker.js', 'editor.css', 'lib.js']) assert.ok(fs.existsSync(path.join(out, 'editor', file)), file);
  assert.ok(!fs.existsSync(path.join(out, 'editor', 'page.html')));
  const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
  assert.match(headers, /\n\/editor\/\*\n {2}! Content-Security-Policy\n {2}Content-Security-Policy: [^\n]*media-src blob:; worker-src 'self'; connect-src 'self' https:\/\/lrclib\.net;/);
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
