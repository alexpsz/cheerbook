'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVideoLink, videoWatchURL, bilibiliEmbedURL, YOUTUBE_FRAME_ORIGINS, BILIBILI_FRAME_ORIGINS,
} = require('../lib/video');

const id = 'AbCd_9-xIjK';
const bvid = 'BVaB0123XyZ9';
const youtube = { ok: true, platform: 'youtube', id, start: null };
const bilibili = { ok: true, platform: 'bilibili', bvid, aid: null, page: 1, start: null };
const unsupported = { ok: false, reason: 'unsupported' };

test('YouTube forms and hosts keep only the video ID and start time', () => {
  for (const [input, start] of [
    ['  HTTPS://WWW.YOUTUBE.COM:443/watch?list=example&v=' + id + '&t=83s&start=7  ', 83],
    ['youtu.be/' + id + '?t=2m3s#ignored', 123],
    ['http://youtube.com:80/shorts/' + id, null],
    ['m.youtube.com/live/' + id + '?start=1h2m3s', 3723],
    ['www.youtube-nocookie.com/embed/' + id + '?t=1m', 60],
    ['music.youtube.com/v/' + id + '?start=83', 83],
  ]) assert.deepEqual(parseVideoLink(input), { ...youtube, start }, input);
});

test('Bilibili preserves BV case, normalizes av digits, and reads page and time', () => {
  assert.deepEqual(parseVideoLink('www.BILIBILI.com/video/' + bvid + '/?p=002&t=83.5&from=example'),
    { ...bilibili, page: 2, start: 83 });
  assert.deepEqual(parseVideoLink('https://m.bilibili.com/video/aV00042?p=1000&t=1h2m3s'),
    { ...bilibili, bvid: null, aid: '42', page: 1000, start: 3723 });
  assert.deepEqual(parseVideoLink('http://bilibili.com/video/AV123456789012345/'),
    { ...bilibili, bvid: null, aid: '123456789012345' });
  for (const p of ['', '0', '-1', '1001', '1e2', '2.5', '7x']) {
    assert.deepEqual(parseVideoLink('bilibili.com/video/' + bvid + '?p=' + p), bilibili);
  }
});

test('times use whole seconds in range, with t taking precedence when present', () => {
  const yt = 'youtube.com/watch?v=' + id;
  const bili = 'bilibili.com/video/' + bvid;
  for (const [value, expected] of [['0', 0], ['0003s', 3], ['24h', 86400], ['86400', 86400],
    ['86401', null], ['24h1s', null], ['9'.repeat(60), null], ['', null], ['-1', null],
    ['1e2', null], ['1s2m', null], ['1m2', null], ['%0A1', null], ['10s%0A', null]]) {
    assert.equal(parseVideoLink(yt + '&t=' + value + '&start=7').start, expected, value);
    assert.equal(parseVideoLink(bili + '?t=' + value).start, expected, value);
  }
  assert.equal(parseVideoLink(yt + '&t=83.5').start, null);
  assert.equal(parseVideoLink(bili + '?t=0.99').start, 0);
  assert.equal(parseVideoLink(bili + '?start=7').start, null);
});

test('shorteners are recognized by exact hostname, after scheme and port checks', () => {
  for (const host of ['b23.tv', 'bili2233.cn', 'youtube.app.goo.gl', 'goo.gl', 't.co', 'bit.ly', 'tinyurl.com']) {
    for (const prefix of ['', 'www.']) {
      assert.deepEqual(parseVideoLink(prefix + host + '/abc'), { ok: false, reason: 'shortLink' });
    }
  }
  for (const input of ['ftp://b23.tv/abc', 'https://b23.tv:80/abc', 'https://user:pass@b23.tv/abc', 'b23.tv.example/abc']) {
    assert.deepEqual(parseVideoLink(input), unsupported);
  }
});

test('rejects unsupported protocols, authorities, paths, IDs and non-string inputs', () => {
  for (const input of [
    null, undefined, 1, {}, [], Symbol(), '', '  ', 'not a URL',
    'javascript://youtube.com', 'data:text/plain,youtu.be/' + id, 'ftp://youtu.be/' + id,
    'https://user:pass@youtu.be/' + id, 'https://name@youtu.be/' + id, 'https://youtu.be:80/' + id,
    'youtube.com.evil.example/watch?v=' + id, 'evilyoutube.com/watch?v=' + id,
    'bilibili.com.evil.example/video/' + bvid, 'notyoutu.be/' + id,
    'youtu.be/' + id + 'Z', 'youtu.be/' + id.slice(1), 'youtube.com/shorts/' + id.slice(1) + '!',
    'youtube.com/watch?v=' + id + '%0A', 'youtube.com/watch', 'youtube.com/' + id,
    'youtu.be/live/' + id, 'youtube.com/shorts/' + id + '/extra',
    'bilibili.com/video/' + bvid + 'Z', 'bilibili.com/video/' + bvid.slice(0, -1),
    'bilibili.com/video/' + bvid.slice(0, -1) + '_', 'bilibili.com/video/' + bvid.toLowerCase(),
    'bilibili.com/video/av000', 'bilibili.com/video/av', 'bilibili.com/video/av1234567890123456',
    'bilibili.com/video/av12x', 'bilibili.com/video/' + bvid + '//', 'bilibili.com/video/' + bvid + '/../x',
    'bilibili.com/video/x/%2e%2e/' + bvid, 'bilibili.com/video/' + bvid + '%2F',
    'youtu.be/x/../' + id, 'youtu.be/' + id.slice(0, 4) + '\n' + id.slice(4),
  ]) assert.deepEqual(parseVideoLink(input), unsupported, String(input));
});

test('builders emit exact canonical URLs on the three allowed hosts', () => {
  const hosts = new Set(['www.youtube.com', 'www.bilibili.com', 'player.bilibili.com']);
  const watch = 'https://www.bilibili.com/video/';
  const player = 'https://player.bilibili.com/player.html?';
  for (const [input, expectedWatch, expectedEmbed] of [
    ['youtu.be/' + id + '?from=example', 'https://www.youtube.com/watch?v=' + id, null],
    ['youtube.com/watch?v=' + id + '&t=0', 'https://www.youtube.com/watch?v=' + id + '&t=0s', null],
    ['youtu.be/' + id + '?t=1m', 'https://www.youtube.com/watch?v=' + id + '&t=60s', null],
    ['bilibili.com/video/' + bvid, watch + bvid + '/', player + 'bvid=' + bvid + '&p=1&autoplay=0&danmaku=0'],
    ['bilibili.com/video/av0042?t=0', watch + 'av42/?t=0', player + 'aid=42&p=1&autoplay=0&danmaku=0'],
    ['bilibili.com/video/av0042?p=3&t=83.5&autoplay=1', watch + 'av42/?p=3&t=83', player + 'aid=42&p=3&autoplay=0&danmaku=0&t=83'],
    ['bilibili.com/video/' + bvid + '?p=2', watch + bvid + '/?p=2', player + 'bvid=' + bvid + '&p=2&autoplay=0&danmaku=0'],
  ]) {
    const link = parseVideoLink(input);
    const urls = [videoWatchURL(link), bilibiliEmbedURL(link)];
    assert.deepEqual(urls, [expectedWatch, expectedEmbed]);
    for (const address of urls) if (address !== null) assert.ok(hosts.has(new URL(address).host));
  }
});

test('embed start overrides include positive seconds, omit zero and ignore invalid overrides', () => {
  const link = { ...bilibili, start: 4 };
  const base = 'https://player.bilibili.com/player.html?bvid=' + bvid + '&p=1&autoplay=0&danmaku=0';
  assert.equal(bilibiliEmbedURL(link, { start: 0 }), base);
  assert.equal(bilibiliEmbedURL(link, { start: 86400 }), base + '&t=86400');
  for (const start of [-1, 86401, 2.5, '2', NaN, null]) {
    assert.equal(bilibiliEmbedURL(link, { start }), base + '&t=4');
  }
});

test('builders reject malformed parsed fields, even with a valid override', () => {
  for (const link of [
    null, undefined, true, 'youtube', {}, unsupported, { ...youtube, ok: 1 },
    { ...youtube, id: '"><script>' }, { ...youtube, id: [id] }, { ...youtube, start: -1 },
    { ...bilibili, page: '1&x=1' }, { ...bilibili, page: 1001 }, { ...bilibili, start: '1' },
    { ...bilibili, start: 86401 }, { ...bilibili, start: undefined }, { ...bilibili, aid: '42' },
    { ...bilibili, bvid: null }, { ...bilibili, bvid: bvid + '/' }, { ...bilibili, bvid: null, aid: 42 },
    { ...bilibili, bvid: null, aid: '0042' }, { ...bilibili, bvid: null, aid: '0' },
    { ...bilibili, platform: 'example' }, { get ok() { throw new Error(); } },
  ]) {
    assert.equal(videoWatchURL(link), null);
    assert.equal(bilibiliEmbedURL(link, { start: 1 }), null);
  }
});

test('frame origins are exact and frozen', () => {
  assert.deepEqual(YOUTUBE_FRAME_ORIGINS, ['https://www.youtube.com', 'https://www.youtube-nocookie.com']);
  assert.deepEqual(BILIBILI_FRAME_ORIGINS, ['https://player.bilibili.com', 'https://www.bilibili.com']);
  assert.ok(Object.isFrozen(YOUTUBE_FRAME_ORIGINS));
  assert.ok(Object.isFrozen(BILIBILI_FRAME_ORIGINS));
});
