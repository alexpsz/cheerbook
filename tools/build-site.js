#!/usr/bin/env node
'use strict';
// Builds the CheerBook website: a home page listing every accepted cheer file by artist and song,
// a MIX page (the built-in library and the artist MIX), the web editor and its MIX form, and the
// machine-readable files players and tools fetch (index.json, the cheer and MIX files, the Schema,
// the MIX library, and /mix/artists.json, every artist MIX in one file for the editor). Everything contributors wrote is
// escaped, and the pages carry no inline script or style, so the Content-Security-Policy in
// _headers can forbid both. Cloudflare Pages runs it on every push to main (build command
// `node tools/build-site.js`, output folder `_site`).
//   node tools/build-site.js [output folder, default _site] [--root <repository root>]
const fs = require('node:fs');
const path = require('node:path');
const { checkLibrary, buildIndex, regularFile } = require('../lib/library');
const { POSITION_TITLES: POSITIONS, PROPOSALS_DIR } = require('../lib/mixes');

const REPO = 'https://github.com/alexpsz/cheerbook';
const LIVEGLOW = 'https://github.com/alexpsz/liveglow';
const MARKER = '.cheerbook-site';
const PERMISSIONS = { original: '自己听写', 'open-license': '开放许可', consented: '作者同意转载' };
const MIX_PERMISSIONS = { ...PERMISSIONS, original: '自己创作' };
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

function layout({ title, description, current, body, scripts = [{ src: '/app.js' }], styles = [], wide = false }) {
  const nav = [['/', '浏览应援', 'home'], ['/editor/', '制作应援', 'editor'], ['/mix/', 'MIX', 'mix'], [REPO + '/blob/main/CONTRIBUTING.md', '投稿', ''], [REPO, 'GitHub', '']];
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
${styles.map(sheet => `<link rel="stylesheet" href="${escapeHTML(sheet)}">`).join('\n')}
${scripts.map(script => script.module ? `<script type="module" src="${escapeHTML(script.src)}"></script>` : `<script src="${escapeHTML(script.src)}" defer></script>`).join('\n')}
</head>
<body>
<a class="skip" href="#main">跳到正文</a>
<header class="site"><div class="wrap">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="28" height="28">CheerBook 应援本</a>
<nav class="site" aria-label="主导航">${nav.map(([link, label, key]) => `<a href="${escapeHTML(link)}"${key && key === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
</div></header>
<main id="main"><div class="wrap${wide ? ' wide' : ''}">
${body}
</div></main>
<footer class="site"><div class="wrap">
<p>CheerBook 是社区维护的应援时间轴库，不隶属于任何偶像组合、事务所或音乐平台；文件不含歌词。</p>
<p>代码 GPL-3.0-only；格式说明与内置 MIX 库 CC0；投稿按各文件自己的许可（自己听写的默认 CC BY 4.0）。<a href="/privacy/">隐私说明</a> · <a href="${REPO}/blob/main/docs/takedown.md">下架请求</a> · <a href="${REPO}">源代码</a> · <a href="${LIVEGLOW}">映场 Liveglow</a></p>
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
function homePage(entries, library, mixRecords) {
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
${song.files.map(entry => `<li><span>${userText(entry.authors.join('、'))}</span><span class="meta">${escapeHTML(PERMISSIONS[entry.permission] || entry.permission)} · ${escapeHTML(licenseLabel(entry))} · ${entry.events} 处标记 · 时长 ${clock(entry.song.duration)}${entry.note ? ` · 说明：${userText(entry.note)}` : ''}</span><span class="actions"><a href="/editor/?cheer=${encodeURIComponent(href(entry.path))}">在网页中播放</a><a href="liveglow://cheer/import?path=${encodeURIComponent(entry.path).replace(/'/g, '%27')}">在映场中打开</a><a href="${href(entry.path)}" download>下载</a><a href="${REPO}/blob/main/${entry.path.split('/').map(encodeURIComponent).join('/')}">GitHub</a></span></li>`).join('\n')}
</ul></li>`;
  }).join('\n')}
</ul></div>`).join('\n')}`;
  const body = `<div class="hero">
<h1>偶像歌曲的应援本，大家一起写。</h1>
<p>什么时候喊 MIX、喊 call，哪位成员在唱，什么时候举灯——CheerBook 把这些按秒记在 <code>.cheer.json</code> 文件里。社区通过 Pull Request 收录，大家都可以按各文件的许可下载使用。文件只有时间轴，不含歌词。</p>
<ul class="stats" aria-label="收录情况">
<li><strong>${entries.length}</strong><span>份应援</span></li>
<li><strong>${songCount}</strong><span>首歌</span></li>
<li><strong>${library.entries.length}</strong><span>条通用 MIX</span></li>
<li><strong>${mixRecords.length}</strong><span>条艺人专属 MIX</span></li>
</ul>
<p class="cta"><a class="button" href="/editor/">在网页上制作应援</a><span class="meta">选一首本地歌曲边听边点，没有音频也能按歌词做；音频不会上传。</span></p>
</div>
<section aria-labelledby="browse"><h2 id="browse">浏览应援</h2>
${browse}
</section>
<section aria-labelledby="use"><h2 id="use">怎样使用</h2>
<div class="grid">
<div class="card"><h3>在网页上</h3><ol class="steps"><li>打开<a href="/editor/">制作应援</a>，选择本地音频；没有音频就填上时长或在线查歌词。</li><li>加载歌词，按住成员按钮或数字键边听边点，或从通用 MIX 一点插入。</li><li>保存到本机，或直接投稿到 CheerBook。</li></ol></div>
<div class="card"><h3>在映场中</h3><ol class="steps"><li>点应援文件旁的“在映场中打开”，在支持社区应援的版本中预览并确认导入。</li><li>使用较早版本时，可以下载文件，在<a href="${LIVEGLOW}">映场</a>“正在播放”侧栏的“应援”标签点“导入…”。</li><li>播放到匹配的录音时，MIX 与 call 会跟着歌词出现。</li></ol></div>
<div class="card"><h3>投稿</h3><p>只收自己听写打轴、或有开放许可 / 原作者同意的时间轴，不能有歌词原文。在<a href="/editor/">制作页</a>选择免账号投稿，送出后可凭链接查看进度。也可以按<a href="${REPO}/blob/main/CONTRIBUTING.md">投稿指南</a>自行在 GitHub 提交。</p></div>
<div class="card"><h3>MIX</h3><p><a href="/mix/">MIX 页</a>收录通用 MIX 与各位艺人的专属 MIX。你可以<a href="/editor/mix/?type=proposal">提议通用 MIX</a>，审核后并入内置库；也可以<a href="/editor/mix/?type=artist">投稿艺人专属 MIX</a>，制作这位艺人的歌时就能一点插入。</p></div>
<div class="card"><h3>给开发者</h3><p>格式说明见 <a href="${REPO}/blob/main/spec/README.md">spec/README.md</a>；机器可读的 <a href="/index.json">index.json</a>、<a href="/spec/cheer.schema.json">JSON Schema</a>、<a href="/spec/mix-library.json">MIX 库</a>与<a href="/mix/artists.json">艺人专属 MIX</a>都可以直接获取。</p></div>
</div>
</section>`;
  return layout({ title: 'CheerBook 应援本 · 偶像歌曲应援时间轴', description: '偶像歌曲应援 / MIX 时间轴的社区库：支持免账号投稿、按许可下载，文件不含歌词。', current: 'home', body });
}

function artistMixSection(mixRecords) {
  if (!mixRecords.length) {
    return `<div class="card empty"><p>还没有艺人专属 MIX。某个组合自己的口号、某首歌固定的 call，可以作为专属 MIX 投稿：制作这位艺人的歌时，编辑器会把它放在 MIX 库最前面，推荐也会用到。</p><p><a class="button" href="/editor/mix/?type=artist">投稿艺人专属 MIX</a></p></div>`;
  }
  // Grouped by folder, which already folds case and spacing, as on the home page.
  const artists = new Map();
  for (const record of [...mixRecords].sort((a, b) => byCodePoint(a.path, b.path))) {
    const folder = record.path.split('/')[2].toLowerCase();
    const artist = artists.get(folder) || { name: record.artist, items: [] };
    artist.items.push(record);
    artists.set(folder, artist);
  }
  return `<div class="filter" hidden><label for="filter">搜索</label><input id="filter" type="search" placeholder="艺人、歌名、名称或作者" autocomplete="off" data-unit="条 MIX"><span id="filter-status" role="status" aria-live="polite"></span></div>
${[...artists.values()].map(artist => `<div class="artist" data-artist><h3>${userText(artist.name)}</h3><ul class="songs">
${artist.items.map(record => {
    const search = plainUserText([record.artist, record.name, record.text, ...(record.songs || []), ...record.authors].join(' '));
    const file = record.path.split('/').map(encodeURIComponent).join('/');
    return `<li class="song card" data-search="${escapeHTML(search)}"><header class="mix-head"><h4>${userText(record.name)}</h4><span class="badge">${record.kind === 'call' ? 'CALL' : 'MIX'}</span></header>
<p class="chant">${userText(record.text)}</p>
<p class="meta">${record.songs ? `只用于：${record.songs.map(userText).join('、')}` : '用于这位艺人的所有歌'} · ${userText(record.authors.join('、'))} · ${escapeHTML(MIX_PERMISSIONS[record.permission] || record.permission)} · ${escapeHTML(licenseLabel(record))}</p>
<p class="actions"><a href="/editor/mix/?mix=${encodeURIComponent(href(record.path))}">在网页中编辑</a><a href="${href(record.path)}" download>下载</a><a href="${REPO}/blob/main/${file}">GitHub</a></p></li>`;
  }).join('\n')}
</ul></div>`).join('\n')}`;
}

function mixPage(library, mixRecords) {
  const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  // Entry ids get a prefix so they can never clash with the page's own ids.
  const items = library.entries.map(entry => `<article class="card" id="mix-${escapeHTML(entry.id)}">
<header><h3 lang="ja">${escapeHTML(entry.name)}</h3><span class="badge">${entry.kind === 'call' ? 'CALL' : 'MIX'}</span></header>
<p class="chant" lang="ja">${escapeHTML(entry.text)}</p>
<p class="romaji" lang="ja-Latn">${escapeHTML(entry.romaji)}</p>
<dl class="facts">
<dt>长度</dt><dd>约 ${entry.bars[0] === entry.bars[1] ? entry.bars[0] : `${entry.bars[0]}–${entry.bars[1]}`} 小节</dd>
${entry.positions.length ? `<dt>常见位置</dt><dd>${entry.positions.map(position => escapeHTML(POSITIONS[position] || position)).join('、')}</dd>` : ''}
${entry.note ? `<dt>说明</dt><dd>${escapeHTML(entry.note)}</dd>` : ''}
${entry.readingNote ? `<dt>读音</dt><dd>${escapeHTML(entry.readingNote)}</dd>` : ''}
<dt>核对来源</dt><dd>${entry.sources.map(code => `<a href="${escapeHTML(library.sources[code])}">${escapeHTML(host(library.sources[code]))}</a>`).join('、')}（${escapeHTML(entry.retrieved || library.retrieved)} 读取）</dd>
</dl>
</article>`).join('\n');
  const body = `<div class="hero">
<h1>MIX</h1>
<p>通用 MIX 是偶像现场通用的 MIX 与 call，按“${escapeHTML(library.credit)}”署名，以 CC0 公开，只收在多个相互独立的公开来源中核对为通用的口号；映场内置同一份库。艺人专属 MIX 是某个组合或某首歌自己的口号，由社区投稿、按各自的许可公开。<code>{name}</code> 处填入成员名字。</p>
<p class="cta"><a class="button" href="/editor/mix/?type=proposal">提议通用 MIX</a><a class="button" href="/editor/mix/?type=artist">投稿艺人专属 MIX</a><span class="meta">填写口号与读音后在 GitHub 投稿。通用 MIX 一律人工审核；新增艺人专属 MIX 通过检查后自动收录。</span></p>
<p class="meta">跳到：<a href="#builtin">通用 MIX（${library.entries.length}）</a> · <a href="#artists">艺人专属 MIX（${mixRecords.length}）</a></p>
</div>
<section aria-labelledby="builtin"><h2 id="builtin">通用 MIX</h2>
<p class="meta">机器可读版本：<a href="/spec/mix-library.json">mix-library.json</a>。</p>
<div class="mix">
${items}
</div>
</section>
<section aria-labelledby="artists"><h2 id="artists">艺人专属 MIX</h2>
<p class="meta">制作这位艺人的歌时，网页编辑器会提供并推荐这些 MIX。机器可读版本：<a href="/mix/artists.json">artists.json</a>。</p>
${artistMixSection(mixRecords)}
</section>`;
  return layout({ title: 'MIX · CheerBook 应援本', description: '偶像现场通用的 MIX 与 call（CC0），以及社区投稿的艺人专属 MIX：日文原文、罗马音、常见位置与来源。', current: 'mix', body });
}

function notFoundPage() {
  const body = `<div class="hero"><h1>没有这个页面</h1><p>链接可能已经失效，或者文件已被下架。<a href="/">回到首页</a></p></div>`;
  return layout({ title: '没有这个页面 · CheerBook 应援本', description: '没有这个页面。', current: '', body });
}

// What the site keeps, and which other services it reaches and when (C-016). Loading a YouTube video
// uses YouTube API Services, whose terms ask for this page: that the site says so, links YouTube's
// terms and Google's privacy policy, and tells what it does with user information (nothing).
function privacyPage() {
  const body = `<div class="hero"><h1>隐私说明</h1><p>CheerBook 不设访问统计，不放广告，没有账号系统。下面写明网站保存什么，以及什么时候会连接别的服务。</p></div>
<section aria-labelledby="privacy-local"><h2 id="privacy-local">留在你浏览器里的</h2>
<ul>
<li>你选择的音频只在浏览器里播放和分析节拍，不会上传。</li>
<li>你加载的歌词只用来对时间和显示，不会上传，也不会写进应援文件。</li>
<li>草稿、显示设置，以及你贴过的视频链接和对时位置，保存在这个浏览器的本地存储里。想清掉，在浏览器里清除本站的数据即可。</li>
</ul></section>
<section aria-labelledby="privacy-third"><h2 id="privacy-third">会连接的其他服务</h2>
<p>和访问任何网站一样，被连接的一方能看到你的网络地址。下面每一项都只在你做了对应的操作之后才会连接。</p>
<ul>
<li><strong>LRCLIB</strong>（lrclib.net，公开的歌词库）：点“在线查找”时，发送歌名、艺人，以及已知的歌曲时长。免账号投稿时，服务端也会用歌曲信息向它查询，核对文件里没有歌词原文。</li>
<li><strong>Cloudflare Turnstile</strong>：打开“免账号投稿”时加载，用来确认不是自动程序；投稿接口按来源网络地址限流。</li>
<li><strong>YouTube</strong>：在制作页贴了 YouTube 链接并点“加载视频”之后，才会加载 YouTube 的播放器。这一功能通过 YouTube API 服务（YouTube IFrame Player API）实现：使用它即表示你同意受 <a href="https://www.youtube.com/t/terms">YouTube 服务条款</a>约束；YouTube 如何处理你的信息，见 <a href="http://www.google.com/policies/privacy">Google 隐私权政策</a>。CheerBook 只从播放器读取播放位置、时长和播放状态，用来让应援跟着视频走；不读取、不收集、不保存你的 YouTube 账号信息或观看记录，也不会把你的应援内容发给 YouTube。YouTube 的播放器可能在你的设备上存取 Cookie 或类似技术。</li>
<li><strong>哔哩哔哩</strong>：在制作页贴了 Bilibili 链接并点“加载视频”之后，才会加载哔哩哔哩的外链播放器。CheerBook 读不到它的任何播放信息，也不向它发送应援内容。</li>
</ul>
<p>网站由 Cloudflare 托管，托管方会像任何网站的服务器一样处理访问请求。</p></section>
<section aria-labelledby="privacy-public"><h2 id="privacy-public">投稿后公开的</h2>
<p>投稿的应援文件、你填的昵称和自愿填写的公开联系方式，会出现在公开的文件和 GitHub 投稿记录里，可长期查看。需要撤下时见<a href="${REPO}/blob/main/docs/takedown.md">下架请求</a>。</p></section>
<section aria-labelledby="privacy-contact"><h2 id="privacy-contact">有问题</h2>
<p>可以在 <a href="${REPO}/issues">GitHub</a> 上提出。</p></section>`;
  return layout({ title: '隐私说明 · CheerBook 应援本', description: 'CheerBook 保存什么，什么时候会连接 LRCLIB、Cloudflare Turnstile、YouTube 与哔哩哔哩。', current: '', body, scripts: [] });
}

function editorPage(markup) {
  return layout({
    title: '制作应援 · CheerBook 应援本', current: 'editor', body: markup, wide: true,
    description: '在浏览器里边听本地歌曲边打应援：歌词卷轴、应援棒打点、通用 MIX、节拍分析与智能推荐，即时检查格式；音频不会上传。',
    scripts: [{ src: '/editor/app.js', module: true }], styles: ['/editor/editor.css'],
  });
}

// The MIX form lives under /editor/ for the editor's policy: it reads this site's MIX library and
// the artist MIX being edited.
function mixFormPage(markup) {
  return layout({
    title: '制作 MIX · CheerBook 应援本', current: 'mix', body: markup,
    description: '提议一条通用 MIX，或投稿某位艺人的专属 MIX：填写口号、读音与小节数，即时检查，一键打开 GitHub 投稿。',
    scripts: [{ src: '/editor/mix.js', module: true }], styles: ['/editor/editor.css', '/editor/mix.css'],
  });
}

// The browser bundle of the pure modules in lib/ (no file system), so the web editor runs the
// same reader, rules and analysis as the command-line checks. Each file becomes a function in
// one ES module; `require('./x')` between them resolves inside the bundle and nowhere else.
const BROWSER_EXCLUDED = new Set(['library.js']);
function bundleLib(read, files) {
  const names = files.filter(file => file.endsWith('.js') && !BROWSER_EXCLUDED.has(file)).sort().map(file => file.slice(0, -3));
  const parts = names.map(name => {
    const source = read('lib/' + name + '.js').toString('utf8');
    if (/require\(\s*['"](?!\.\/)/.test(source)) throw new Error(`lib/${name}.js 引用了包外的模块，不能放进浏览器包。`);
    return `${JSON.stringify(name)}: function (module, exports, require) {\n${source}\n}`;
  });
  return `// Generated by tools/build-site.js from lib/ (GPL-3.0-only); do not edit.
const factories = {
${parts.join(',\n')}
};
const cache = {};
function load(name) {
  if (cache[name]) return cache[name].exports;
  const module = { exports: {} };
  cache[name] = module;
  factories[name](module, module.exports, request => {
    const target = String(request).replace(/^\\.\\//, '').replace(/\\.js$/, '');
    if (!Object.hasOwn(factories, target)) throw new Error('Not in the browser bundle: ' + request);
    return load(target);
  });
  return module.exports;
}
const lib = {};
for (const name of Object.keys(factories)) lib[name] = load(name);
export default lib;
`;
}

// The page Liveglow embeds to submit without leaving the app: only the challenge and this site's
// own script, no site chrome. Never indexed; opened in a browser it only points to the editor.
function submitPage() {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>投稿验证 · CheerBook 应援本</title>
<link rel="stylesheet" href="/submit/embed.css">
<script src="/submit/embed.js" defer></script>
</head>
<body>
<div id="challenge"></div>
<p id="standalone" hidden>这个页面供映场（Liveglow）里的投稿面板使用。在浏览器里请到<a href="/editor/">制作页</a>投稿。</p>
</body>
</html>
`;
}

// Cloudflare Pages reads this file for response headers. Pages may only use this site's own
// files; the data files may be fetched from anywhere, so other players and tools can read them.
// The editor also plays the chosen audio file (blob: URLs), analyses it in a worker of this site,
// reads this site's own data, and, only when the visitor asks, looks lyrics up on lrclib.net.
const EDITOR_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src blob:; worker-src 'self'; connect-src 'self' https://lrclib.net; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Only the chart editor embeds the opt-in Turnstile script and frame. Its API stays same-origin.
// It is also the only page that can show a video the visitor pasted a link to (C-016): YouTube's
// IFrame Player API script and player, and Bilibili's player frame (two hosts: phones are sent to
// the second). Nothing from them is in the page until the visitor chooses to load a video.
const VIDEO_SCRIPTS = ['https://www.youtube.com'];
const VIDEO_FRAMES = ['https://www.youtube.com', 'https://player.bilibili.com', 'https://www.bilibili.com'];
const SUBMISSION_CSP = EDITOR_CSP.replace("script-src 'self';", `script-src 'self' https://challenges.cloudflare.com ${VIDEO_SCRIPTS.join(' ')}; frame-src https://challenges.cloudflare.com ${VIDEO_FRAMES.join(' ')};`);
// The embedded submission page runs the challenge and posts to this site, and nothing else.
const EMBED_CSP = "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/index.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300

/mix/artists.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300

/mix/artists/*
  Access-Control-Allow-Origin: *

/cheers/*
  Access-Control-Allow-Origin: *

/spec/*
  Access-Control-Allow-Origin: *

/editor/mix/
  ! Content-Security-Policy
  Content-Security-Policy: ${EDITOR_CSP}

/editor/mix/index.html
  ! Content-Security-Policy
  Content-Security-Policy: ${EDITOR_CSP}

/editor/
  ! Content-Security-Policy
  Content-Security-Policy: ${SUBMISSION_CSP}

/editor/index.html
  ! Content-Security-Policy
  Content-Security-Policy: ${SUBMISSION_CSP}

/submit/
  ! Content-Security-Policy
  Content-Security-Policy: ${EMBED_CSP}

/submit/index.html
  ! Content-Security-Policy
  Content-Security-Policy: ${EMBED_CSP}
`;

/** Writes the site into `output`, which must be missing, empty or an earlier build of this tool. */
function buildSite(root, output) {
  if (fs.existsSync(output)) {
    const existing = fs.readdirSync(output);
    if (existing.length && !existing.includes(MARKER)) throw new Error(`${output} 不是空文件夹，也不是之前生成的网站，不会覆盖。`);
    fs.rmSync(output, { recursive: true, force: true });
  }
  const checked = checkLibrary(root);
  const { entries, mixes: mixRecords } = checked;
  // Proposals are not published, so one that cannot be accepted does not stop the site.
  const problems = checked.problems.filter(found => !found.file.startsWith(PROPOSALS_DIR + '/'));
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
  write('index.html', homePage(entries, library, mixRecords));
  write('mix/index.html', mixPage(library, mixRecords));
  write('404.html', notFoundPage());
  write('privacy/index.html', privacyPage());
  write('editor/index.html', editorPage(read('site/editor/page.html').toString('utf8')));
  if (fs.existsSync(path.join(root, 'site', 'editor', 'mix.html'))) write('editor/mix/index.html', mixFormPage(read('site/editor/mix.html').toString('utf8')));
  write('editor/lib.js', bundleLib(read, fs.readdirSync(path.join(root, 'lib'))));
  const pages = new Set(['page.html', 'mix.html']);
  for (const entry of fs.readdirSync(path.join(root, 'site', 'editor'), { withFileTypes: true })) {
    if (!pages.has(entry.name)) write('editor/' + entry.name, read('site/editor/' + entry.name));
  }
  write('submit/index.html', submitPage());
  for (const file of ['embed.js', 'embed.css']) write('submit/' + file, read('site/submit/' + file));
  write('_headers', HEADERS);
  write('index.json', JSON.stringify(buildIndex(entries, mixRecords), null, 2) + '\n');
  for (const entry of entries) write(entry.path, read(entry.path));
  const artistMixes = mixRecords.map(record => {
    const bytes = read(record.path);
    write(record.path, bytes);
    return { path: record.path, ...JSON.parse(bytes.toString('utf8')) };
  });
  write('mix/artists.json', JSON.stringify({
    format: 'cheerbook-artist-mixes', version: 1,
    description: 'Every artist MIX in CheerBook (mix/artists/), each file\'s content plus its path, for the web editor. Generated by tools/build-site.js.',
    mixes: artistMixes,
  }, null, 2) + '\n');
  for (const file of ['cheer.schema.json', 'mix-library.json']) write('spec/' + file, read('spec/' + file));
  for (const file of ['style.css', 'app.js', 'favicon.svg']) write(file, read('site/' + file));
  return { entries: entries.length, mixes: mixRecords.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = path.resolve(rootFlag >= 0 ? args[rootFlag + 1] : path.join(__dirname, '..'));
  const positional = args.filter((arg, i) => arg !== '--root' && args[i - 1] !== '--root');
  const output = path.resolve(positional[0] || path.join(root, '_site'));
  try {
    const { entries, mixes } = buildSite(root, output);
    console.log(`网站已生成：${output}（${entries} 份应援，${mixes} 条艺人专属 MIX）。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildSite, bundleLib, escapeHTML, href, clock, EDITOR_CSP, EMBED_CSP };
