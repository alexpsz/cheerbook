'use strict';
// The lyric list's rules, with the cases of Liveglow's NowPlayingLyricsTests where they apply.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/lyricsview');

test('the focus moves 0.3 s before a line and says when it moves next', () => {
  const starts = [11, 15];
  assert.equal(V.focusIndex(starts, 10.6), -1);
  assert.equal(V.focusIndex(starts, 10.71), 0);
  assert.ok(Math.abs(V.secondsUntilFocusChange(starts, 6) - 4.7) < 1e-9);
  assert.equal(V.secondsUntilFocusChange(starts, 15), null);
  assert.equal(V.focusIndex(starts, 14.75), 1);
  assert.equal(V.focusIndex(starts, NaN), -1);
});

test('a line sweeps to the next line; the last takes its own length within the song', () => {
  const lines = [{ start: 10 }, { start: 14 }, { start: 30, end: 33 }];
  assert.deepEqual(V.sweep(lines, 0, 60), { start: 9.98, span: 4 });
  assert.deepEqual(V.sweep(lines, 2, 60), { start: 29.98, span: 3 });
  assert.deepEqual(V.sweep([{ start: 58 }], 0, 60), { start: 57.98, span: 2 });
  assert.deepEqual(V.sweep([{ start: 10 }, { start: 10.2 }], 0, 60), { start: 9.98, span: 0.75 });
  assert.equal(V.sweep(lines, 5, 60), null);
  assert.equal(V.sweepProgress({ start: 0, span: 2 }, -1), 0);
  assert.equal(V.sweepProgress({ start: 0, span: 2 }, 1), 0.5);
  assert.equal(V.sweepProgress({ start: 0, span: 2 }, 3), 1);
});

test('word timing fills each word between its start and end; a sweep lights the whole line', () => {
  const widths = [10, 10, 10, 10];
  const words = [{ start: 1, end: 2, from: 0, to: 2 }, { start: 3, end: 5, from: 2, to: 4 }];
  assert.equal(V.litWidth(widths, 0.5, { words }), 0);
  assert.equal(V.litWidth(widths, 1.5, { words }), 10);
  assert.equal(V.litWidth(widths, 2.5, { words }), 20);
  assert.equal(V.litWidth(widths, 4, { words }), 30);
  assert.equal(V.litWidth(widths, 9, { words }), 40);
  assert.equal(V.litWidth(widths, 1, { lineSweep: { start: 0, span: 2 } }), 20);
  assert.equal(V.brightness(0, 30, 15), 1);
  assert.equal(V.brightness(20, 27.5, 15), 0.5);
  assert.equal(V.brightness(30, 20, 15), 0);
});

test('every line is one dim ink; others are slightly smaller unless motion or contrast say no', () => {
  assert.equal(V.dimInk(false), 0.42);
  assert.deepEqual(V.lineStyle(0), { opacity: 0.42, scale: 1 });
  for (const distance of [-7, -1, 1, 40]) assert.deepEqual(V.lineStyle(distance), { opacity: 0.42, scale: 0.98 });
  assert.deepEqual(V.lineStyle(3, { hovered: true }), { opacity: 1, scale: 0.98 });
  assert.deepEqual(V.lineStyle(1, { reduceMotion: true }), { opacity: 0.42, scale: 1 });
  assert.deepEqual(V.lineStyle(1, { increasedContrast: true }), { opacity: 0.65, scale: 1 });
  assert.equal(V.lineStyle(0, { increasedContrast: true }).opacity, 0.65);
  assert.deepEqual(V.lineStyle(2, { browsing: true }), { opacity: 0.42, scale: 1 });
});

test('the list follows as a wave below the focus, at once above it', () => {
  assert.ok(Math.abs(V.staggerDelay(5, 3) - 0.07) < 1e-9);
  assert.equal(V.staggerDelay(2, 3), 0);
  assert.equal(V.staggerDelay(20, 0), 0.25);
  assert.equal(V.staggerDelay(5, 3, true), 0);
  assert.ok(Math.abs(V.staggerDelay(1, -1) - 0.035) < 1e-9);
});

test('the focus line sits at 30% of the list; a manual scroll holds for 4 s', () => {
  assert.equal(V.anchorScroll(500, 400), 380);
  assert.equal(V.anchorScroll(50, 400), 0);
  assert.equal(V.resumesFollowing(10, 13.9), false);
  assert.equal(V.resumesFollowing(10, 14.1), true);
});

test('the spring is critically damped: it rises without overshoot and settles in about 0.6 s', () => {
  const { easing, duration } = V.springEasing();
  assert.match(easing, /^linear\(0, [0-9., ]+, 1\)$/);
  const points = easing.slice(7, -1).split(', ').map(Number);
  for (let i = 1; i < points.length; i++) assert.ok(points[i] >= points[i - 1], 'monotonic');
  assert.ok(points.every(point => point <= 1));
  assert.ok(duration >= 500 && duration <= 900, String(duration));
});
