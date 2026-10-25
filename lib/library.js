'use strict';
// The community library's own rules, on top of the format (CONTRIBUTING.md, docs/review.md):
// where a file goes, that it may be shared, which licences it may carry, no exact duplicates, and
// the index the players read. Messages are for contributors, so they are plain Chinese sentences
// with the file named; codes stay stable for tooling.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cheer = require('./cheer');

const LIBRARY_DIR = 'cheers';
// Licences a contribution may carry in credits.license. Without one, an `original` file is
// published under CC BY 4.0 (CONTRIBUTING.md).
const LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0'];
const DEFAULT_LICENSE = 'CC-BY-4.0';
const NAME_LIMIT = 80;
// The index copies these, so they are kept short; the format itself does not limit them.
const ALBUM_LIMIT = 200;
const AUTHOR_LIMIT = 16;
// Characters a folder or file name may not hold on any of macOS, Windows and Linux, and invisible
// format characters (zero-width, bidirectional controls) that make two names look alike.
const FORBIDDEN = /[\u0000-\u001F\u007F/\\:*?"<>|]/gu;
const INVISIBLE = /\p{Cf}/gu;
// Names Windows reserves for devices, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(\..*)?$/iu;

/** User-supplied text inside a message: quoted, with line breaks and control characters escaped. */
const quote = value => JSON.stringify(String(value)).replace(/[\u0085\u2028\u2029]/gu, c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));

/** How macOS and Windows compare names: case-insensitively. */
const nameKey = name => name.normalize('NFC').toUpperCase().toLowerCase();

/** A folder name from a song's artist or title (CONTRIBUTING.md §3). */
function folderName(text) {
  const clean = name => cheer.trimmed(name).replace(/[. ]+$/u, '');
  let name = clean(text.normalize('NFC').replace(INVISIBLE, '').replace(FORBIDDEN, '_'));
  name = clean([...name].slice(0, NAME_LIMIT).join(''));
  if (name === '' || name === '.' || name === '..') return '_';
  return RESERVED.test(name) ? name + '_' : name;
}

/** Where a file with this song belongs, relative to the repository root. */
function expectedFolder(song) {
  return [LIBRARY_DIR, folderName(song.artist), folderName(song.title)].join('/');
}

function problem(code, file, message) {
  return { code, file, message };
}

/** The licence a shared file is published under, or null when it carries the terms its author agreed to. */
function licenseOf(credits) {
  if (credits.license !== undefined) return cheer.trimmed(credits.license);
  return credits.permission === 'original' ? DEFAULT_LICENSE : null;
}

/**
 * Checks one contribution. `file` is its path relative to the repository root, with "/".
 * Returns `{ problems, entry, chart }`; `entry` is its index record when there are no problems.
 */
function checkFile(file, bytes) {
  const problems = [];
  const add = (code, message) => problems.push(problem(code, file, message));
  const parts = file.split('/');
  if (file !== file.normalize('NFC')) add('pathNotNFC', '文件路径须为 Unicode NFC 形式（在 macOS 上新建的文件夹名偶尔会是分解形式，请重新输入文件夹名）。');
  if (parts.length !== 4 || parts[0] !== LIBRARY_DIR || !parts[3].endsWith('.cheer.json')) {
    add('path', '应援文件须放在 cheers/<艺人>/<歌名>/<文件名>.cheer.json。');
  } else {
    const base = parts[3].slice(0, -'.cheer.json'.length);
    if (base === '' || [...base].length > NAME_LIMIT || base !== cheer.trimmed(base) || /[\u0000-\u001F\u007F/\\:*?"<>|\p{Cf}]/u.test(base) ||
      /[. ]$/u.test(base) || RESERVED.test(base)) {
      add('fileName', `文件名须为 1–${NAME_LIMIT} 个字，不含 / \\ : * ? " < > | 与控制字符或不可见字符，不以空格或句点结尾，也不能是 CON、NUL 等 Windows 保留名。`);
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) add('bom', '文件开头不能有 BOM（以 UTF-8 无 BOM 保存）。');

  const result = cheer.parse(bytes);
  if (!result.valid) {
    for (const found of result.errors) {
      const detail = found.detail === undefined ? '' : `（${quote(found.detail)}）`;
      add('format:' + found.code, `格式检查未通过：${found.code}${detail}，位置 ${found.path ? quote(found.path) : '整个文件'}。规则见 spec/README.md §7。`);
    }
    return { problems };
  }
  for (const found of result.warnings) {
    add('warning:' + found.code, `格式警告 ${found.code}，位置 ${quote(found.path)}。社区库只收没有警告的文件，请修正后再提交。`);
  }
  const { chart } = result;
  const { credits } = chart;
  if (result.sharing !== 'shareable') {
    add('notShareable', `授权状态为 ${quote(credits.permission)}${credits.permission === 'original' ? '，但来源里有他人的材料' : ''}，这样的文件只能在本机使用，社区库不收。自己听写打轴的文件请用 original 且来源只写 self；转载须有开放许可（open-license）或原作者同意（consented）。`);
  }
  const license = licenseOf(credits);
  if (credits.license !== undefined && !LICENSES.includes(license)) {
    add('license', `许可 ${quote(credits.license)} 不在社区库接受的范围内（${LICENSES.join('、')}）。不写 license 时，自己听写的文件按 ${DEFAULT_LICENSE} 发布。`);
  }
  if (chart.song.album !== undefined && cheer.length(chart.song.album) > ALBUM_LIMIT) add('album', `专辑名最多 ${ALBUM_LIMIT} 个字。`);
  if (credits.authors.length > AUTHOR_LIMIT) add('authors', `作者最多 ${AUTHOR_LIMIT} 位。`);
  if (parts.length === 4 && parts[0] === LIBRARY_DIR) {
    const folder = expectedFolder(chart.song);
    // A folder that differs only in case is the same folder on macOS and Windows.
    if (nameKey(parts.slice(0, 3).join('/')) !== nameKey(folder)) add('folder', `按文件里的歌名与艺人，应放在 ${quote(folder + '/')} 下。`);
  }
  if (problems.length) return { problems };
  return {
    problems,
    entry: {
      path: file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      song: pick(chart.song, ['title', 'artist', 'duration', 'album', 'isrc', 'appleMusicID']),
      authors: credits.authors.map(author => author.name),
      permission: credits.permission,
      license,
      members: chart.members.length,
      events: chart.events.length,
    },
    chart,
  };
}

function pick(object, keys) {
  const out = {};
  for (const key of keys) if (object[key] !== undefined) out[key] = object[key];
  return out;
}

// The timeline of a chart — song, offset, members and events — without formatting, key order,
// event order or credits, so a copy that only changes the author or the tool is still a duplicate.
function fingerprint(chart) {
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  };
  const { song, offset, members, events } = chart;
  return crypto.createHash('sha256').update(JSON.stringify(stable({ song, offset, members, events }))).digest('hex');
}

/**
 * Everything under cheers/, relative to `root`, with "/" separators, sorted: `files` are regular
 * files; `others` are symbolic links and anything else that is not a file or a folder, which are
 * never followed (a link could point outside the repository).
 */
function libraryEntries(root) {
  const files = [], others = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) others.push(child);
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
      else others.push(child);
    }
  };
  const top = fs.lstatSync(path.join(root, LIBRARY_DIR), { throwIfNoEntry: false });
  if (top && top.isSymbolicLink()) others.push(LIBRARY_DIR);
  else if (top && top.isDirectory()) walk(LIBRARY_DIR);
  return { files: files.sort(), others: others.sort() };
}

/**
 * Throws unless every part of `relative` under `root` is a real folder or file: a symbolic link
 * anywhere on the way could make a build read, and publish, a file outside the repository.
 */
function regularFile(root, relative) {
  const parts = relative.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const part = parts.slice(0, depth).join('/');
    const stat = fs.lstatSync(path.join(root, part), { throwIfNoEntry: false });
    const ok = stat && (depth === parts.length ? stat.isFile() : stat.isDirectory());
    if (!ok) throw Object.assign(new Error(`${part} 不是普通${depth === parts.length ? '文件' : '文件夹'}（不能是符号链接）。`), { code: 'notRegularFile' });
  }
}

/** Two spellings of one name that differ only in case collide on macOS and Windows: the first in path order wins. */
function caseCollisions(files) {
  const problems = [], spellings = new Map();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 2; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      const first = spellings.get(nameKey(prefix));
      if (first === undefined) spellings.set(nameKey(prefix), prefix);
      else if (first !== prefix) {
        problems.push(problem('caseCollision', file, `${quote(prefix)} 与已有的 ${quote(first)} 只差大小写，在 macOS 与 Windows 上是同一个名字；请放进已有的文件夹或换一个文件名。`));
        break;
      }
    }
  }
  return problems;
}

/**
 * Checks the whole library under `root`. Returns `{ problems, notices, entries }`: problems fail
 * the check; notices are for the reviewer (the same song by the same author already exists).
 */
function checkLibrary(root) {
  const problems = [], notices = [], entries = [], seen = new Map(), charts = [];
  const { files, others } = libraryEntries(root);
  for (const file of others) problems.push(problem('notRegularFile', file, 'cheers/ 下不能有符号链接或其他特殊文件。'));
  problems.push(...caseCollisions(files));
  for (const file of files) {
    if (file === LIBRARY_DIR + '/README.md') continue;
    if (!file.endsWith('.cheer.json')) {
      problems.push(problem('notCheer', file, 'cheers/ 下只放 .cheer.json 应援文件（不收音频、歌词或其他文件）。'));
      continue;
    }
    const checked = checkFile(file, fs.readFileSync(path.join(root, file)));
    problems.push(...checked.problems);
    if (!checked.entry) continue;
    const print = fingerprint(checked.chart);
    if (seen.has(print)) {
      problems.push(problem('duplicate', file, `与 ${quote(seen.get(print))} 的时间轴相同（可能只差署名或工具）。社区库不重复收录；如果是替换旧文件，请同时删除旧文件。`));
      continue;
    }
    seen.set(print, file);
    for (const other of charts) {
      const sameAuthor = other.entry.authors.some(name => checked.entry.authors.includes(name));
      if (sameAuthor && cheer.matchSong(other.chart.song, checked.chart.song)) {
        notices.push(problem('sameSongSameAuthor', file, `同一作者已有这首歌的版本：${quote(other.entry.path)}。如是更新，请考虑替换旧文件。`));
      }
    }
    charts.push({ entry: checked.entry, chart: checked.chart });
    entries.push(checked.entry);
  }
  problems.push(...checkMixLibrary(root));
  return { problems, notices, entries };
}

/** The index the players and the web read: one record per file, in path order. */
function buildIndex(entries) {
  return {
    format: 'cheerbook-index',
    version: 1,
    description: 'Every cheer file in this repository (cheers/), generated by tools/build-index.js. Paths are relative to the repository root.',
    count: entries.length,
    cheers: entries,
  };
}

// spec/README.md §13: the MIX library loads only when every header rule holds; here every entry
// must hold too, since a skipped entry would quietly vanish from the players.
function checkMixLibrary(root) {
  const file = 'spec/mix-library.json';
  const problems = [];
  const add = message => problems.push(problem('mixLibrary', file, message));
  let library;
  try {
    regularFile(root, file);
    library = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    add(error.code === 'notRegularFile' ? error.message : '不是有效的 JSON。');
    return problems;
  }
  if (library.format !== 'liveglow-cheer-mix-library' || library.version !== 1) add('format / version 不对。');
  if (library.license !== 'CC0-1.0') add('license 须为 CC0-1.0。');
  if (typeof library.credit !== 'string' || cheer.isBlank(library.credit)) add('缺少 credit。');
  if (typeof library.retrieved !== 'string' || !cheer.isDay(library.retrieved)) add('retrieved 不是真实日期。');
  const sources = library.sources && typeof library.sources === 'object' && !Array.isArray(library.sources) ? library.sources : {};
  if (!Object.keys(sources).length || !Object.values(sources).every(url => typeof url === 'string' && cheer.isWebURL(url))) add('sources 须至少一项，且都是 http(s) 链接。');
  if (!Array.isArray(library.entries)) { add('缺少 entries。'); return problems; }
  const ids = new Set();
  const positions = new Set(['intro', 'afterMix', 'interlude', 'chorusLead', 'outro', 'verse']);
  const nonBlank = value => typeof value === 'string' && !cheer.isBlank(value);
  library.entries.forEach((entry, i) => {
    const label = `条目 ${typeof entry?.id === 'string' ? entry.id : '#' + i}`;
    const fail = rule => add(`${label}：${rule}。`);
    if (!entry || typeof entry !== 'object') return fail('不是对象');
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,53}$/.test(entry.id)) fail('id 格式不对');
    else if (ids.has(entry.id)) fail('id 重复');
    else ids.add(entry.id);
    if (!nonBlank(entry.name)) fail('name 为空');
    if (entry.kind !== 'mix' && entry.kind !== 'call') fail('kind 须为 mix 或 call');
    const textOK = nonBlank(entry.text) && cheer.parseSlots(entry.text) !== null && cheer.length(entry.text) <= (cheer.TEXT_LIMIT[entry.kind] ?? 0);
    if (!textOK) fail('text 为空、名字空位不对或超长');
    if (!nonBlank(entry.romaji)) fail('romaji 为空');
    const bars = entry.bars;
    if (!Array.isArray(bars) || bars.length !== 2 || !bars.every(Number.isInteger) || bars[0] < 1 || bars[0] > bars[1]) fail('bars 须为 [最少, 最多] 且 1 ≤ 最少 ≤ 最多');
    if (!Array.isArray(entry.positions) || !entry.positions.every(position => positions.has(position))) fail('positions 含未知位置');
    if (!Array.isArray(entry.sources) || entry.sources.length < 2 || new Set(entry.sources).size !== entry.sources.length ||
      !entry.sources.every(code => Object.hasOwn(sources, code))) fail('sources 须至少两个、不重复且都在文件头中');
    if (entry.note !== undefined && typeof entry.note !== 'string') fail('note 须为字符串');
    if (entry.readingNote !== undefined && typeof entry.readingNote !== 'string') fail('readingNote 须为字符串');
    const readings = entry.readings;
    const lists = readings && Array.isArray(readings.kana) && Array.isArray(readings.romaji) &&
      [...readings.kana, ...readings.romaji].every(item => typeof item === 'string');
    if (!lists || !textOK || !cheer.readingsFit(readings, { kind: entry.kind, text: entry.text })) fail('readings 须有 kana 与 romaji，且与 text 的词数对得上');
  });
  return problems;
}

module.exports = { LIBRARY_DIR, LICENSES, DEFAULT_LICENSE, folderName, expectedFolder, nameKey, quote, regularFile, caseCollisions, checkFile, checkLibrary, buildIndex, checkMixLibrary, fingerprint };
