'use strict';
// The YouTube source (site/editor/youtube.js) against a made-up IFrame Player API and page: what
// it tells the editor, and that a load nobody wants any more leaves the page alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settled = () => new Promise(resolve => setImmediate(resolve));

function setup({ apiReady = true } = {}) {
  const clock = { now: 0 };
  const timers = new Map();
  let nextTimer = 1;
  const node = tag => ({
    tag, children: [], parent: null, listeners: {},
    append(child) { child.parent = this; this.children.push(child); },
    replaceChildren(...next) { for (const child of this.children) child.parent = null; this.children = []; for (const child of next) this.append(child); },
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } },
    addEventListener(name, fn) { this.listeners[name] = fn; },
  });
  const head = node('head');
  const players = [];
  class Player {
    constructor(mount, options) {
      Object.assign(this, { mount, options, time: 0, state: -1, rate: 1, length: 0, destroyed: false, calls: [] });
      players.push(this);
    }
    getCurrentTime() { return this.time; }
    getPlayerState() { return this.state; }
    getPlaybackRate() { return this.rate; }
    getDuration() { return this.length; }
    playVideo() { this.calls.push('play'); }
    pauseVideo() { this.calls.push('pause'); }
    seekTo(to) { this.calls.push('seek:' + to); this.time = to; }
    setPlaybackRate(rate) { this.rate = rate; }
    destroy() { this.destroyed = true; }
  }
  const YT = { Player, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 } };
  const window = apiReady ? { YT } : {};
  const context = {
    window, document: { createElement: node, head }, location: { origin: 'https://cheerbook.example' },
    performance: { now: () => clock.now * 1000 },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock.now + ms / 1000, every: 0 }); return id; },
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock.now + ms / 1000, every: ms / 1000 }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
  };
  const source = fs.readFileSync(path.join(__dirname, '../site/editor/youtube.js'), 'utf8').replace(/^export /gm, '');
  vm.runInNewContext(source + '\nthis.api = { loadYouTubeAPI, youtubeErrorKind, createYouTubePlayer };', context);
  const advance = seconds => {
    const until = clock.now + seconds;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until + 1e-9).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      clock.now = timer.at;
      if (timer.every) timer.at += timer.every; else timers.delete(id);
      timer.fn();
    }
    clock.now = until;
  };
  return { api: context.api, window, head, players, node, advance, clock, YT, pendingTimers: () => timers.size };
}

test('the error codes become what the visitor is told', () => {
  const { api } = setup();
  assert.equal(api.youtubeErrorKind(101), 'embedDisabled');
  assert.equal(api.youtubeErrorKind(150), 'embedDisabled');
  assert.equal(api.youtubeErrorKind(100), 'gone');
  assert.equal(api.youtubeErrorKind(5), 'failed');
});

test('the script is only added when asked for, and a load that fails can be tried again', async () => {
  const { api, window, head, advance, YT } = setup({ apiReady: false });
  assert.equal(head.children.length, 0);
  const first = api.loadYouTubeAPI({ timeout: 5000 });
  assert.equal(head.children.length, 1);
  assert.equal(head.children[0].src, 'https://www.youtube.com/iframe_api');
  // Asking again while it loads adds nothing.
  api.loadYouTubeAPI({ timeout: 5000 });
  assert.equal(head.children.length, 1);
  advance(5);
  await assert.rejects(first, /timeout/);
  assert.equal(head.children.length, 0);
  const second = api.loadYouTubeAPI({ timeout: 5000 });
  assert.equal(head.children.length, 1);
  head.children[0].listeners.error();
  await assert.rejects(second, /blocked/);
  const third = api.loadYouTubeAPI({ timeout: 5000 });
  window.YT = YT;
  window.onYouTubeIframeAPIReady();
  assert.equal(await third, YT);
});

test('each change in the player is told once, whichever of the poll and the state event sees it first', async () => {
  const { api, players, node, advance, YT } = setup();
  const container = node('div');
  const told = [];
  const pending = api.createYouTubePlayer(container, 'AbCdEfGhIjK', { start: 30, notify: name => told.push(name) });
  await settled();
  const player = players[0];
  assert.equal(player.options.videoId, 'AbCdEfGhIjK');
  assert.equal(player.options.playerVars.start, 30);
  assert.equal(player.options.playerVars.origin, 'https://cheerbook.example');
  // Ready before its length is known: the length is told when it arrives.
  player.time = 30;
  player.options.events.onReady();
  const source = await pending;
  assert.equal(source.duration(), 0);
  assert.deepEqual(told, []);
  player.length = 300;
  advance(0.25);
  assert.deepEqual(told, ['durationchange']);
  assert.equal(source.duration(), 300);
  // The poll sees it playing before YouTube's event arrives: 'play' is told then, and not again.
  player.state = YT.PlayerState.PLAYING;
  advance(0.25);
  assert.deepEqual(told, ['durationchange', 'play']);
  player.options.events.onStateChange({ data: YT.PlayerState.PLAYING });
  assert.deepEqual(told, ['durationchange', 'play']);
  assert.equal(source.paused, false);
  // Between samples the position is carried forward on the page's clock.
  player.time = 30.25;
  advance(0.25);
  advance(0.1);
  assert.ok(Math.abs(source.position() - 30.35) < 1e-9);
  // The visitor drags YouTube's own bar, and changes the rate in its menu.
  player.time = 120;
  advance(0.15);
  assert.deepEqual(told.slice(2), ['seeked']);
  player.rate = 1.5;
  player.options.events.onPlaybackRateChange();
  assert.equal(source.rate, 1.5);
  assert.deepEqual(told.slice(3), ['ratechange']);
  // The event comes first this time; the poll adds nothing.
  player.state = YT.PlayerState.PAUSED;
  player.options.events.onStateChange({ data: YT.PlayerState.PAUSED });
  advance(0.5);
  assert.deepEqual(told.slice(4), ['pause']);
  player.state = YT.PlayerState.PLAYING;
  player.options.events.onStateChange({ data: YT.PlayerState.PLAYING });
  player.state = YT.PlayerState.ENDED;
  player.options.events.onStateChange({ data: YT.PlayerState.ENDED });
  assert.deepEqual(told.slice(5), ['play', 'pause', 'ended']);
  source.seek(40);
  assert.deepEqual(player.calls, ['seek:40']);
  assert.equal(source.position(), 40);
});

test('a load that is no longer wanted leaves the page as it is', async () => {
  // Replaced while the API was loading: nothing of it reaches the container.
  const early = setup({ apiReady: false });
  const container = early.node('div');
  let wanted = true;
  const pending = early.api.createYouTubePlayer(container, 'AbCdEfGhIjK', { current: () => wanted });
  const other = early.node('iframe');
  container.replaceChildren(other);
  wanted = false;
  early.window.YT = early.YT;
  early.window.onYouTubeIframeAPIReady();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(container.children, [other]);
  assert.equal(early.players.length, 0);

  // Replaced after its player was put in, before it was ready: only its own holder goes.
  const late = setup();
  const box = late.node('div');
  let current = true;
  const loading = late.api.createYouTubePlayer(box, 'AbCdEfGhIjK', { current: () => current });
  await settled();
  const mine = box.children[0];
  const newer = late.node('iframe');
  box.replaceChildren(newer);
  current = false;
  late.players[0].options.events.onReady();
  await assert.rejects(loading, /cancelled/);
  assert.equal(late.players[0].destroyed, true);
  assert.deepEqual(box.children, [newer]);
  assert.equal(mine.parent, null);
  assert.equal(late.pendingTimers(), 0);
});

test('a player that never answers, or fails first, is given up on and cleaned away', async () => {
  const silent = setup();
  const box = silent.node('div');
  const pending = silent.api.createYouTubePlayer(box, 'AbCdEfGhIjK', { timeout: 8000 });
  await settled();
  assert.equal(box.children.length, 1);
  silent.advance(8);
  await assert.rejects(pending, /timeout/);
  assert.equal(silent.players[0].destroyed, true);
  assert.equal(box.children.length, 0);
  assert.equal(silent.pendingTimers(), 0);

  const refused = setup();
  const frame = refused.node('div');
  const errors = [];
  const loading = refused.api.createYouTubePlayer(frame, 'AbCdEfGhIjK', { onError: kind => errors.push(kind) });
  await settled();
  refused.players[0].options.events.onError({ data: 150 });
  await assert.rejects(loading, /embedDisabled/);
  assert.equal(frame.children.length, 0);
  assert.deepEqual(errors, []);

  // After it is ready an error goes to the editor instead, and the player stays for it to remove.
  const ready = setup();
  const told = [];
  const started = ready.api.createYouTubePlayer(ready.node('div'), 'AbCdEfGhIjK', { onError: kind => told.push(kind) });
  await settled();
  ready.players[0].options.events.onReady();
  const source = await started;
  ready.players[0].options.events.onError({ data: 100 });
  assert.deepEqual(told, ['gone']);
  source.destroy();
  source.destroy();
  assert.equal(ready.pendingTimers(), 0);
});
