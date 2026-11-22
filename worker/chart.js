import { Validator } from '@cfworker/json-schema';
import schema from '../spec/cheer.schema.json' with { type: 'json' };
import cheer from '../lib/cheer.js';
import paths from '../lib/paths.js';
import library from '../lib/library.js';
import lyrics from '../lib/lyrics.js';
import messages from '../lib/messages.js';
import { boundedText, reject } from './common.js';

// Draft 2020-12 treats date format as an annotation; the community parser separately
// enforces real calendar dates. This interpreter asserts formats by default.
const validationSchema = structuredClone(schema);
delete validationSchema.$defs.source.properties.retrieved.format;
const validator = new Validator(validationSchema, '2020-12');
const encoder = new TextEncoder();
export const validateSchema = chart => validator.validate(chart).valid;

function publicSubmitter(nickname, contact = '') {
  if (typeof nickname !== 'string' || !nickname.trim() || [...nickname].length > 64 ||
      /[\p{C}\p{Zl}\p{Zp}]/u.test(nickname)) reject(422, '请填写单行公开昵称，最多 64 个字。');
  if (typeof contact !== 'string' || contact.length > 300 || /[\p{C}\s]/u.test(contact)) {
    reject(422, '联系方式请填公开 HTTPS 主页或 X 的 @用户名。');
  }
  const name = nickname.trim();
  if (!contact) return { name };
  if (/^@[A-Za-z0-9_]{1,15}$/.test(contact)) return { name, url: 'https://x.com/' + contact.slice(1) };
  let url;
  try { url = new URL(contact); } catch { /* handled below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) {
    reject(422, '联系方式请填公开 HTTPS 主页或 X 的 @用户名。');
  }
  return { name, url: url.href };
}

// The reader tolerates extension fields; a public upload should never publish an unexpected
// property from a local editor. Take the allowlist from the authoritative schema itself.
function knownFields(value, rule) {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(rule.anyOf)) return rule.anyOf.some(option => knownFields(value, option));
  if (rule.$ref) rule = schema.$defs[rule.$ref.split('/').pop()];
  if (Array.isArray(value)) return rule.items && value.every(child => knownFields(child, rule.items));
  return Object.entries(value).every(([key, child]) =>
    rule.properties && Object.hasOwn(rule.properties, key) && knownFields(child, rule.properties[key]));
}

export function submission(input) {
  if (typeof input.chart !== 'string') reject(400, '缺少应援文件。');
  const bytes = encoder.encode(input.chart);
  if (bytes.length > cheer.MAX_BYTES) reject(413, '应援文件不能超过 512 KiB。');
  if (input.rightsConfirmed !== true) reject(422, '请先确认投稿授权、公开署名与文件不含歌词。');
  const submittedBy = publicSubmitter(input.nickname, input.contact);
  // Parse the raw bytes before JSON.parse or adding metadata: duplicate keys and reserved lyric
  // fields must be diagnosed against the original document.
  const parsed = cheer.parse(bytes);
  if (!parsed.valid) reject(422, messages.issueMessage(parsed.errors[0]));
  const chart = JSON.parse(input.chart);
  if (!validateSchema(chart)) reject(422, '应援文件不符合公开 JSON Schema，请用制作页检查后重试。');
  if (!knownFields(chart, schema)) reject(422, '文件含当前投稿格式以外的字段，请从编辑器导出分享文件后重试。');
  const target = input.target;
  if (target != null && (!target || typeof target.path !== 'string' || typeof target.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(target.sha256))) {
    reject(422, '修改已有文件时须提供社区文件路径和原始 SHA-256。');
  }
  const folder = paths.expectedFolder(parsed.chart.song);
  const path = target?.path ?? (folder + '/' + paths.folderName(submittedBy.name) + '.cheer.json');
  // checkFile checks filename, song folder, entire format, permission, licence and warnings.
  // Exact segments exclude dot paths while accepting case differences allowed by the community.
  const parts = path.split('/');
  const unsafe = parts.length !== 4 || parts[0] !== 'cheers' || parts.some(part =>
    !part || part === '.' || part === '..' || /[\\\p{C}]/u.test(part));
  if (unsafe) reject(422, '只能投稿到这首歌的 cheers 路径。');
  const original = library.checkFile(path, bytes);
  if (original.problems.length) reject(422, original.problems[0].message);
  chart.submittedBy = submittedBy;
  const content = JSON.stringify(chart, null, 2) + '\n';
  const enriched = encoder.encode(content);
  if (enriched.length > cheer.MAX_BYTES) reject(413, '附上公开署名后的应援文件超过 512 KiB，请缩小文件。');
  if (!validateSchema(chart)) reject(422, '公开署名不符合应援文件格式。');
  const validated = library.checkFile(path, enriched);
  if (validated.problems.length) reject(422, validated.problems[0].message);
  return { path, content, chart: parsed.chart, submittedBy, expected: target?.sha256 ?? null };
}

export async function compareLyrics(chart, fetcher) {
  if (!lyrics.lyricIssues(chart, []).length) return 'clear';
  const { title, artist, duration } = chart.song;
  const url = lyrics.lrclibGetURL({ title, artist, duration });
  let lines = [];
  if (url) {
    try {
      const res = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(5500) });
      if (res.ok) {
        const data = JSON.parse(await boundedText(res, 128 * 1024));
        const record = lyrics.pickLRCLIB([data], chart.song);
        if (record) {
          const { plain, synced, instrumental } = lyrics.fromLRCLIB(record);
          if (plain) lines.push(...lyrics.parsePlain(plain).lines);
          if (synced) lines.push(...lyrics.parseLRC(synced).lines);
          if (!lines.length && instrumental) return 'clear';
        }
      }
    } catch { /* An unavailable reference goes to a maintainer as a draft PR. */ }
  }
  const issues = lyrics.lyricIssues(chart, lines);
  if (issues.some(issue => issue.code === 'lyricOverlap')) reject(422, '应援文字与该录音的参考歌词重合，请移除歌词原文后再投稿。');
  return issues.length ? 'unchecked' : 'clear';
}
