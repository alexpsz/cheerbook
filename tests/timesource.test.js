'use strict';
// The editor's time source (site/editor/timesource.js): the silent clock that stands in for an
// audio file, driven here by a made-up clock and timer so no browser is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settled = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const clock = { now: 0, timers: new Map(), nextId: 1 };
  const audio = {
    paused: true, currentTime: 0, duration: NaN, playbackRate: 1, listeners: {},
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
    fire(name) { for (const fn of this.listeners[name] || []) fn(); },
    // As in a browser, the element reports play and pause later, not during the call.
    play() { this.paused = false; queueMicrotask(() => this.fire('play')); return Promise.resolve(); },
    pause() { if (!this.paused) { this.paused = true; queueMicrotask(() => this.fire('pause')); } },
  };
  const source = fs.readFileSync(path.join(__dirname, '../site/editor/timesource.js'), 'utf8');
  const context = {};
  vm.runInNewContext(source.replace('export function createTransport', 'function createTransport') + '\nthis.createTransport = createTransport;', context);
  const transport = context.createTransport(audio, {
    now: () => clock.now,
    schedule: (fn, ms) => { const id = clock.nextId++; clock.timers.set(id, { fn, at: clock.now + ms / 1000 }); return id; },
    cancel: id => { clock.timers.delete(id); },
  });
  const events = [];
  for (const name of ['play', 'pause', 'ended', 'seeked']) transport.on(name, () => events.push(name));
  /** Moves the made-up clock on, firing the timers that come due. */
  const advance = seconds => {
    clock.now += seconds;
    for (const [id, timer] of [...clock.timers]) if (timer.at <= clock.now + 1e-9) { clock.timers.delete(id); timer.fn(); }
  };
  return { transport, audio, events, advance, clock };
}

test('nothing plays until a source with a length is chosen', async () => {
  const { transport } = setup();
  assert.equal(transport.kind, 'none');
  assert.equal(transport.ready, false);
  await assert.rejects(transport.play());
  transport.useSilent(0);
  assert.equal(transport.kind, 'silent');
  assert.equal(transport.ready, false);
  await assert.rejects(transport.play());
  transport.useSilent(NaN);
  assert.equal(transport.duration(), 0);
});

test('the silent clock runs at the rate, pauses, seeks and stops itself at the end', async () => {
  const { transport, events, advance } = setup();
  transport.useSilent(10);
  assert.equal(transport.ready, true);
  assert.equal(transport.paused, true);
  await transport.play();
  assert.equal(transport.paused, false);
  advance(2);
  assert.equal(transport.position(), 2);
  transport.setRate(0.5);
  advance(2);
  assert.equal(transport.position(), 3);
  transport.pause();
  advance(5);
  assert.equal(transport.position(), 3);
  transport.seek(9);
  assert.equal(transport.position(), 9);
  transport.setRate(1);
  await transport.play();
  advance(0.5);
  assert.equal(transport.position(), 9.5);
  advance(0.5);
  assert.equal(transport.position(), 10);
  assert.equal(transport.paused, true);
  assert.deepEqual(events, ['play', 'pause', 'seeked', 'play', 'pause', 'ended']);
  // Play again from the end starts over, as an audio element does.
  await transport.play();
  assert.equal(transport.position(), 0);
});

test('seeking while it runs keeps it running, within the song', async () => {
  const { transport, advance } = setup();
  transport.useSilent(10);
  await transport.play();
  transport.seek(-3);
  assert.equal(transport.position(), 0);
  advance(1);
  assert.equal(transport.position(), 1);
  transport.seek(99);
  assert.equal(transport.position(), 10);
});

test('a new length keeps the position, and stops a clock that is now past the end', async () => {
  const { transport, events, advance } = setup();
  transport.useSilent(10);
  await transport.play();
  advance(4);
  transport.useSilent(20);
  assert.equal(transport.paused, false);
  advance(1);
  assert.equal(transport.position(), 5);
  transport.useSilent(3);
  assert.equal(transport.position(), 3);
  assert.equal(transport.paused, true);
  assert.deepEqual(events, ['play', 'pause']);
});

test('audio takes over from the silent clock and hands back its position', async () => {
  const { transport, audio, events, advance } = setup();
  transport.useSilent(10);
  await transport.play();
  advance(1);
  audio.duration = 200;
  transport.useAudio();
  assert.equal(transport.kind, 'audio');
  assert.deepEqual(events, ['play', 'pause']);
  assert.equal(transport.duration(), 200);
  // The audio starts where the silent clock was.
  assert.equal(audio.currentTime, 1);
  audio.currentTime = 42;
  await transport.play();
  await settled();
  assert.equal(transport.paused, false);
  assert.equal(transport.position(), 42);
  assert.deepEqual(events, ['play', 'pause', 'play']);
  transport.seek(500);
  assert.equal(audio.currentTime, 200);
  audio.currentTime = 7;
  // Leaving audio that is playing: the pause is announced at once, and only once, although the
  // element's own pause event arrives after it has stopped being the source.
  transport.useSilent(10);
  assert.deepEqual(events, ['play', 'pause', 'play', 'pause']);
  await settled();
  assert.deepEqual(events, ['play', 'pause', 'play', 'pause']);
  assert.equal(audio.paused, true);
  assert.equal(transport.kind, 'silent');
  assert.equal(transport.paused, true);
  assert.equal(transport.position(), 7);
  // The silent clock no longer passes the audio element's events on.
  const seen = events.length;
  audio.fire('seeked');
  assert.equal(events.length, seen);
});

test('a video player is the time, shifted by where the song starts in it', async () => {
  const { transport, events, advance } = setup();
  const video = {
    time: 0, paused: true, length: 300, rate: 1, calls: [],
    position() { return this.time; },
    duration() { return this.length; },
    play() { this.paused = false; this.calls.push('play'); },
    pause() { this.paused = true; this.calls.push('pause'); },
    seek(to) { this.time = to; this.calls.push('seek:' + to); },
    setRate(rate) { this.rate = rate; },
  };
  transport.useSilent(100);
  await transport.play();
  advance(2);
  transport.useVideo(video, 30);
  assert.equal(transport.kind, 'video');
  assert.deepEqual(events, ['play', 'pause']);
  assert.equal(transport.ready, true);
  assert.equal(transport.duration(), 270);
  video.time = 12;
  assert.equal(transport.position(), 0);
  video.time = 42.5;
  assert.equal(transport.position(), 12.5);
  assert.equal(transport.videoPosition(), 42.5);
  transport.seek(10);
  assert.equal(video.time, 40);
  await transport.play();
  assert.equal(transport.paused, false);
  transport.setRate(0.5);
  assert.equal(video.rate, 0.5);
  // The player reports what happened in it; the editor hears it only while the video is the source.
  transport.notify('play');
  transport.notify('seeked');
  assert.deepEqual(events, ['play', 'pause', 'play', 'seeked']);
  transport.setVideoOffset(35);
  assert.equal(transport.videoOffset, 35);
  assert.equal(transport.position(), 5);
  assert.deepEqual(events, ['play', 'pause', 'play', 'seeked', 'seeked']);
  transport.setVideoOffset(-4);
  assert.equal(transport.videoOffset, 0);
  // Leaving the video keeps the song position and stops the player.
  transport.setVideoOffset(35);
  transport.useSilent(100);
  assert.equal(video.paused, true);
  assert.equal(transport.kind, 'silent');
  assert.equal(transport.position(), 5);
  const seen = events.length;
  transport.notify('play');
  assert.equal(events.length, seen);
  // A video shorter than the offset has nothing to play.
  transport.useVideo({ ...video, duration: () => 20, position: () => 0 }, 30);
  assert.equal(transport.ready, false);
  assert.equal(transport.duration(), 0);
});
