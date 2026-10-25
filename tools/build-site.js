#!/usr/bin/env node
'use strict';
// Builds the CheerBook website: a home page listing every accepted cheer file by artist and song,
// a page for the built-in MIX library, and the machine-readable files players and tools fetch
// (index.json, the cheer files, the Schema and the MIX library). Everything contributors wrote is
// escaped, and the pages carry no inline script or style, so the Content-Security-Policy in
// _headers can forbid both. Cloudflare Pages runs it on every push to main (build command
// `node tools/build-site.js`, output folder `_site`).
//   node tools/build-site.js [output folder, default _site] [--root <repository root>]
const fs = require('node:fs');
const path = require('node:path');
const { checkLibrary, buildIndex, regularFile } = require('../lib/library');

const REPO = 'https://github.com/alexpsz/cheerbook';
const LIVEGLOW = 'https://github.com/alexpsz/liveglow';
const MARKER = '.cheerbook-site';
const POSITIONS = { intro: '前奏', afterMix: '接在 MIX 后', interlude: '间奏', chorusLead: '副歌前', outro: '尾奏', verse: '有人唱时' };
const PERMISSIONS = { original: '自己听写', 'open-license': '开放许可', consented: '作者同意转载' };
const LICENSE_NAMES = { 'CC0-1.0': 'CC0', 'CC-BY-4.0': 'CC BY 4.0', 'CC-BY-SA-4.0': 'CC BY-SA 4.0' };

const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Text contributors wrote: bidirectional controls removed (they could make one name look like
// another), escaped, and isolated with <bdi> so it cannot reorder the text around it.
const BIDI_CONTROLS = /[\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const userText = value => `<bdi>${escapeHTML(String(value).replace(BIDI_CONTROLS, ''))}</bdi>`;
const plainUserText = value => String(value).replace(BIDI_CONTROLS, '');
/** A site path with every segment percent-encoded, for href attributes. */
const href = file => '/' + file.split('/').map(encodeURIComponent).join('/');
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Seconds as m:ss, the way players show a song's length. */
const clock = seconds => { const total = Math.round(seconds); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };

function layout({ title, description, current, body }) {
  const nav = [['/', '浏览应援', 'home'], ['/mix', '通用 MIX', 'mix'], [REPO + '/blob/main/CONTRIBUTING.md', '投稿', ''], [REPO, 'GitHub', '']];
  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHTML(title)}</title>
<meta name="description" content="${escapeHTML(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">跳到正文</a>
<header class="site"><div class="wrap">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="28" height="28">CheerBook 应援本</a>
<nav class="site" aria-label="主导航">${nav.map(([link, label, key]) => `<a href="${escapeHTML(link)}"${key && key === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
</div></header>
<main id="main"><div class="wrap">
${body}
</div></main>
<footer class="site"><div class="wrap">
<p>CheerBook 是社区维护的应援时间轴库，不隶属于任何偶像组合、事务所或音乐平台；文件不含歌词。</p>
<p>代码 GPL-3.0-only；格式说明与内置 MIX 库 CC0；投稿按各文件自己的许可（自己听写的默认 CC BY 4.0）。<a href="${REPO}/blob/main/docs/takedown.md">下架请求</a> · <a href="${REPO}">源代码</a> · <a href="${LIVEGLOW}">映场 Liveglow</a></p>
</div></footer>
</body>
</html>
`;
}

function licenseLabel(entry) {
  if (entry.license) return LICENSE_NAMES[entry.license] || entry.license;
  return '按原作者同意的条件（见投稿说明）';
}

// Groups follow the folders, which already fold case and spacing (lib/library.js), so "BiSH"
// and "BISH" are one artist; each group shows the spelling of its first file in path order.
function homePage(entries, library) {
  const artists = new Map();
  for (const entry of [...entries].sort((a, b) => byCodePoint(a.path, b.path))) {
    const [, artistFolder, titleFolder] = entry.path.split('/');
    const artist = artists.get(artistFolder.toLowerCase()) || { name: entry.song.artist, songs: new Map() };
    const song = artist.songs.get(titleFolder.toLowerCase()) || { title: entry.song.title, files: [] };
    song.files.push(entry);
    artist.songs.set(titleFolder.toLowerCase(), song);
    artists.set(artistFolder.toLowerCase(), artist);
  }
  const songCount = [...artists.values()].reduce((sum, artist) => sum + artist.songs.size, 0);
  const browse = entries.length === 0
    ? `<div class="card empty"><p>还没有投稿。第一份应援可以由你来做。</p><p><a href="${REPO}/blob/main/CONTRIBUTING.md">阅读投稿指南</a></p></div>`
    : `<div class="filter" hidden><label for="filter">搜索</label><input id="filter" type="search" placeholder="艺人、歌名或作者" autocomplete="off"><span id="filter-status" role="status" aria-live="polite"></span></div>
${[...artists.values()].map(artist => `<div class="artist" data-artist><h3>${userText(artist.name)}</h3><ul class="songs">
${[...artist.songs.values()].map(song => {
    const search = plainUserText([artist.name, song.title, ...song.files.flatMap(entry => entry.authors)].join(' '));
    return `<li class="song card" data-search="${escapeHTML(search)}"><h4>${userText(song.title)}</h4><ul class="files">
${song.files.map(entry => `<li><span>${userText(entry.authors.join('、'))}</span><span class="meta">${escapeHTML(PERMISSIONS[entry.permission] || entry.permission)} · ${escapeHTML(licenseLabel(entry))} · ${entry.events} 处标记 · 时长 ${clock(entry.song.duration)}</span><span class="actions"><a href="${href(entry.path)}" download>下载</a><a href="${REPO}/blob/main/${entry.path.split('/').map(encodeURIComponent).join('/')}">GitHub</a></span></li>`).join('\n')}
</ul></li>`;
  }).join('\n')}
</ul></div>`).join('\n')}`;
  const body = `<div class="hero">
<h1>偶像歌曲的应援本，大家一起写。</h1>
<p>什么时候喊 MIX、喊 call，哪位成员在唱，什么时候举灯——CheerBook 把这些按秒记在 <code>.cheer.json</code> 文件里。社区投稿、维护者审核，大家都可以按各文件的许可下载使用。文件只有时间轴，不含歌词。</p>
<ul class="stats" aria-label="收录情况">
<li><strong>${entries.length}</strong><span>份应援</span></li>
<li><strong>${songCount}</strong><span>首歌</span></li>
<li><strong>${library.entries.length}</strong><span>条通用 MIX</span></li>
</ul>
</div>
<section aria-labelledby="browse"><h2 id="browse">浏览应援</h2>
${browse}
</section>
<section aria-labelledby="use"><h2 id="use">怎样使用</h2>
<div class="grid">
<div class="card"><h3>在映场中</h3><ol class="steps"><li>下载这首歌的 <code>.cheer.json</code>。</li><li>在<a href="${LIVEGLOW}">映场</a>“正在播放”侧栏的“应援”标签点“导入…”。</li><li>播放到匹配的录音时，MIX 与 call 会跟着歌词出现。</li></ol></div>
<div class="card"><h3>投稿</h3><p>只收自己听写打轴、或有开放许可 / 原作者同意的时间轴，不能有歌词原文。按<a href="${REPO}/blob/main/CONTRIBUTING.md">投稿指南</a>在 GitHub 上发起 Pull Request，检查会自动运行。</p></div>
<div class="card"><h3>给开发者</h3><p>格式说明见 <a href="${REPO}/blob/main/spec/README.md">spec/README.md</a>；机器可读的 <a href="/index.json">index.json</a>、<a href="/spec/cheer.schema.json">JSON Schema</a> 与 <a href="/spec/mix-library.json">MIX 库</a>都可以直接获取。</p></div>
</div>
</section>`;
  return layout({ title: 'CheerBook 应援本 · 偶像歌曲应援时间轴', description: '偶像歌曲应援 / MIX 时间轴的社区库：社区投稿、维护者审核、自由下载，文件不含歌词。', current: 'home', body });
}

function mixPage(library) {
  const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  // Entry ids get a prefix so they can never clash with the page's own ids.
  const items = library.entries.map(entry => `<article class="card" id="mix-${escapeHTML(entry.id)}">
<header><h2 lang="ja">${escapeHTML(entry.name)}</h2><span class="badge">${entry.kind === 'call' ? 'CALL' : 'MIX'}</span></header>
<p class="chant" lang="ja">${escapeHTML(entry.text)}</p>
<p class="romaji" lang="ja-Latn">${escapeHTML(entry.romaji)}</p>
<dl class="facts">
<dt>长度</dt><dd>约 ${entry.bars[0] === entry.bars[1] ? entry.bars[0] : `${entry.bars[0]}–${entry.bars[1]}`} 小节</dd>
${entry.positions.length ? `<dt>常见位置</dt><dd>${entry.positions.map(position => escapeHTML(POSITIONS[position] || position)).join('、')}</dd>` : ''}
${entry.note ? `<dt>说明</dt><dd>${escapeHTML(entry.note)}</dd>` : ''}
${entry.readingNote ? `<dt>读音</dt><dd>${escapeHTML(entry.readingNote)}</dd>` : ''}
<dt>核对来源</dt><dd>${entry.sources.map(code => `<a href="${escapeHTML(library.sources[code])}">${escapeHTML(host(library.sources[code]))}</a>`).join('、')}</dd>
</dl>
</article>`).join('\n');
  const body = `<div class="hero">
<h1>通用 MIX</h1>
<p>偶像现场通用的 MIX 与 call，按“${escapeHTML(library.credit)}”署名，以 CC0 公开。只收在多个相互独立的公开来源中核对为通用的口号（${escapeHTML(library.retrieved)} 核对），不收某个组合专属的口号。<code>{name}</code> 处填入成员名字。</p>
<p>映场内置同一份库；机器可读版本见 <a href="/spec/mix-library.json">mix-library.json</a>。</p>
</div>
<section class="mix" aria-label="MIX 列表">
${items}
</section>`;
  return layout({ title: '通用 MIX · CheerBook 应援本', description: '偶像现场通用的 MIX 与 call：日文原文、罗马音、常见位置与核对来源，CC0。', current: 'mix', body });
}

function notFoundPage() {
  const body = `<div class="hero"><h1>没有这个页面</h1><p>链接可能已经失效，或者文件已被下架。<a href="/">回到首页</a></p></div>`;
  return layout({ title: '没有这个页面 · CheerBook 应援本', description: '没有这个页面。', current: '', body });
}

// Cloudflare Pages reads this file for response headers. Pages may only use this site's own
// files; the data files may be fetched from anywhere, so other players and tools can read them.
const HEADERS = `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/index.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300

/cheers/*
  Access-Control-Allow-Origin: *

/spec/*
  Access-Control-Allow-Origin: *
`;

/** Writes the site into `output`, which must be missing, empty or an earlier build of this tool. */
function buildSite(root, output) {
  if (fs.existsSync(output)) {
    const existing = fs.readdirSync(output);
    if (existing.length && !existing.includes(MARKER)) throw new Error(`${output} 不是空文件夹，也不是之前生成的网站，不会覆盖。`);
    fs.rmSync(output, { recursive: true, force: true });
  }
  const { problems, entries } = checkLibrary(root);
  if (problems.length) {
    // The messages are already quoted safely (lib/library.js), so the build log can show them.
    const list = problems.map(found => `${found.file}：${found.message}`.replace(/[\x00-\x1F]/g, ' ')).join('\n');
    throw new Error(`有 ${problems.length} 个问题，网站没有生成：\n${list}`);
  }
  // Every file the site copies must be a real file inside the repository, never a symbolic link.
  const read = relative => { regularFile(root, relative); return fs.readFileSync(path.join(root, relative)); };
  const library = JSON.parse(read('spec/mix-library.json').toString('utf8'));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
    fs.writeFileSync(path.join(output, file), content);
  };
  write(MARKER, 'Generated by tools/build-site.js; the whole folder is replaced on every build.\n');
  write('index.html', homePage(entries, library));
  write('mix.html', mixPage(library));
  write('404.html', notFoundPage());
  write('_headers', HEADERS);
  write('index.json', JSON.stringify(buildIndex(entries), null, 2) + '\n');
  for (const entry of entries) write(entry.path, read(entry.path));
  for (const file of ['cheer.schema.json', 'mix-library.json']) write('spec/' + file, read('spec/' + file));
  for (const file of ['style.css', 'app.js', 'favicon.svg']) write(file, read('site/' + file));
  return { entries: entries.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = path.resolve(rootFlag >= 0 ? args[rootFlag + 1] : path.join(__dirname, '..'));
  const positional = args.filter((arg, i) => arg !== '--root' && args[i - 1] !== '--root');
  const output = path.resolve(positional[0] || path.join(root, '_site'));
  try {
    const { entries } = buildSite(root, output);
    console.log(`网站已生成：${output}（${entries} 份应援）。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildSite, escapeHTML, href, clock };
