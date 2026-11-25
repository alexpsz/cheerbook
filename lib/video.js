'use strict';
// Shared by the browser editor and its tests. Only validated fields reach the output URLs.
const YOUTUBE_FRAME_ORIGINS = Object.freeze(['https://www.youtube.com', 'https://www.youtube-nocookie.com']);
const BILIBILI_FRAME_ORIGINS = Object.freeze(['https://player.bilibili.com', 'https://www.bilibili.com']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com', 'youtu.be']);
const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);
const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn', 'youtube.app.goo.gl', 'goo.gl', 't.co', 'bit.ly', 'tinyurl.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const BVID = /^BV[0-9A-Za-z]{10}$/;
const AID = /^[1-9][0-9]{0,14}$/;

const validStart = value => Number.isInteger(value) && value >= 0 && value <= 86400;
const validPage = value => Number.isInteger(value) && value >= 1 && value <= 1000;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const unsupported = () => ({ ok: false, reason: 'unsupported' });

function parseStart(text, allowFraction) {
  if (!text) return null;
  let seconds;
  if (/^\d+$/.test(text)) {
    seconds = Number(text);
  } else if (allowFraction && /^\d+\.\d+$/.test(text)) {
    seconds = Number(text.slice(0, text.indexOf('.')));
  } else {
    const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
    if (!units) return null;
    seconds = Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0);
  }
  return validStart(seconds) ? seconds : null;
}

function parseVideoLink(text) {
  if (typeof text !== 'string') return unsupported();
  const input = text.trim();
  // Read the literal path before URL can remove dot segments or reinterpret a backslash.
  const parts = /^(?:https?:\/\/)?[a-z0-9.-]+(?::\d+)?(\/[^?#]*)?(?=[?#]|$)/i.exec(input);
  if (!parts || /[\t\r\n]/.test(input)) return unsupported();
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
  } catch {
    return unsupported();
  }
  if (url.port) return unsupported(); // URL omits the default port for its scheme.
  const host = url.hostname;
  if (SHORT_HOSTS.has(host.replace(/^www\./, ''))) return { ok: false, reason: 'shortLink' };
  const path = parts[1] || '';
  const params = url.searchParams;
  if (YOUTUBE_HOSTS.has(host)) {
    let id;
    if (host === 'youtu.be') id = path.slice(1);
    else if (path === '/watch') id = params.get('v');
    else id = /^\/(?:shorts|live|embed|v)\/([^/]+)$/.exec(path)?.[1];
    if (!matches(id, YOUTUBE_ID)) return unsupported();
    return { ok: true, platform: 'youtube', id, start: parseStart(params.get('t') ?? params.get('start'), false) };
  }
  if (!BILIBILI_HOSTS.has(host)) return unsupported();
  const code = /^\/video\/([^/]+)\/?$/.exec(path)?.[1];
  if (!code) return unsupported();
  const bvid = BVID.test(code) ? code : null;
  const aid = /^av(\d{1,15})$/i.exec(code)?.[1].replace(/^0+/, '') || null;
  if (!bvid && !aid) return unsupported();
  const p = params.get('p');
  const page = matches(p, /^\d+$/) ? Number(p) : 1;
  return { ok: true, platform: 'bilibili', bvid, aid, page: validPage(page) ? page : 1, start: parseStart(params.get('t'), true) };
}

// Snapshot each caller-controlled field once, so the builders use exactly the values checked.
function checkedLink(link) {
  try {
    if (!link || typeof link !== 'object' || Array.isArray(link) || link.ok !== true) return null;
    const { platform, start } = link;
    if (start !== null && !validStart(start)) return null;
    if (platform === 'youtube') {
      const { id } = link;
      return matches(id, YOUTUBE_ID) ? { platform, id, start } : null;
    }
    if (platform !== 'bilibili') return null;
    const { bvid, aid, page } = link;
    if (!validPage(page)) return null;
    const hasBvid = aid === null && matches(bvid, BVID);
    const hasAid = bvid === null && matches(aid, AID);
    if (!hasBvid && !hasAid) return null;
    return { platform, bvid, aid, page, start };
  } catch {
    return null;
  }
}

function videoWatchURL(link) {
  const video = checkedLink(link);
  if (!video) return null;
  if (video.platform === 'youtube') {
    const params = new URLSearchParams({ v: video.id });
    if (video.start !== null) params.set('t', video.start + 's');
    return 'https://www.youtube.com/watch?' + params;
  }
  const url = new URL('https://www.bilibili.com/video/' + (video.bvid ?? 'av' + video.aid) + '/');
  if (video.page > 1) url.searchParams.set('p', video.page);
  if (video.start !== null) url.searchParams.set('t', video.start);
  return url.href;
}

function bilibiliEmbedURL(link, options = {}) {
  const video = checkedLink(link);
  if (video?.platform !== 'bilibili') return null;
  let start = video.start;
  try {
    const override = options?.start;
    if (validStart(override)) start = override;
  } catch {
    // An unreadable override also falls back to the link's start.
  }
  const params = new URLSearchParams(video.bvid ? { bvid: video.bvid } : { aid: video.aid });
  params.set('p', video.page);
  params.set('autoplay', '0');
  params.set('danmaku', '0');
  if (start > 0) params.set('t', start);
  return 'https://player.bilibili.com/player.html?' + params;
}

module.exports = { parseVideoLink, videoWatchURL, bilibiliEmbedURL, YOUTUBE_FRAME_ORIGINS, BILIBILI_FRAME_ORIGINS };
