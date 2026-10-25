'use strict';
// Beat grid estimation (lib/beat.js) on synthetic drum tracks generated here: clicks, kick and
// hi-hat, kick-snare backbeats and bass-note bar changes, with a start offset, added noise,
// swing, drift and a break. Nothing is read from disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const beat = require('../lib/beat');

const RATE = 11025;

// Deterministic noise (mulberry32).
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kick(out, rate, at, amp) {
  const start = Math.round(at * rate);
  let phase = 0;
  for (let i = 0; i < 0.25 * rate && start + i < out.length; i++) {
    const t = i / rate;
    phase += 2 * Math.PI * (45 + 75 * Math.exp(-t / 0.03)) / rate;
    out[start + i] += amp * Math.sin(phase) * Math.exp(-t / 0.12);
  }
}
function noiseBurst(out, rate, at, amp, decay, next, bright) {
  const start = Math.round(at * rate);
  let previous = 0;
  for (let i = 0; i < 6 * decay * rate && start + i < out.length; i++) {
    const white = next() * 2 - 1;
    out[start + i] += amp * (bright ? white - previous : white) * Math.exp(-i / rate / decay);
    previous = white;
  }
}
function tone(out, rate, at, amp, hz, decay) {
  const start = Math.round(at * rate);
  for (let i = 0; i < 6 * decay * rate && start + i < out.length; i++) out[start + i] += amp * Math.sin(2 * Math.PI * hz * i / rate) * Math.exp(-i / rate / decay);
}

/**
 * A drum track whose first beat (a bar line) is at `offset`. `drift` spreads the tempo linearly
 * from bpm·(1 − drift/2) to bpm·(1 + drift/2); `swing` delays off-beats to two thirds of the beat;
 * `pause` = [from, to] leaves out every hit in that span. Returns the samples, beats and bar lines.
 */
function drums({ bpm, pattern, seconds = 40, offset = 1.37, noise = 0.03, seed = 1, drift = 0, swing = false, pause = null, rate = RATE }) {
  const out = new Float32Array(Math.round(seconds * rate));
  const next = random(seed);
  const beats = [];
  for (let t = offset; t < seconds;) { beats.push(t); t += 60 / (bpm * (1 - drift / 2 + drift * t / seconds)); }
  beats.forEach((t, i) => {
    if (pause && t >= pause[0] && t < pause[1]) return;
    const off = t + ((beats[i + 1] ?? t + 60 / bpm) - t) * (swing ? 2 / 3 : 1 / 2);
    const down = i % 4 === 0;
    if (pattern === 'click') {
      tone(out, rate, t, down ? 0.8 : 0.4, down ? 1600 : 1000, 0.02);
      if (down) tone(out, rate, t, 0.4, 90, 0.05);
    } else if (pattern === 'kickhat') {
      kick(out, rate, t, down ? 0.9 : 0.5);
      noiseBurst(out, rate, off, 0.12, 0.03, next, true);
    } else if (pattern === 'backbeat') {
      if (i % 2 === 0) kick(out, rate, t, down ? 0.9 : 0.5);
      else { noiseBurst(out, rate, t, 0.3, 0.07, next, false); tone(out, rate, t, 0.25, 190, 0.06); }
      noiseBurst(out, rate, t, 0.06, 0.025, next, true);
      noiseBurst(out, rate, off, 0.06, 0.025, next, true);
    } else if (pattern === 'bassline') {
      // Equal kicks on every beat: only the bass note, changing at each bar line, shows the bars.
      kick(out, rate, t, 0.5);
      noiseBurst(out, rate, off, 0.1, 0.03, next, true);
      if (down) {
        const hz = [55, 73.4, 61.7, 82.4][(i / 4) % 4];
        tone(out, rate, t, 0.25, hz, 0.6); tone(out, rate, t, 0.12, hz * 4, 0.6); tone(out, rate, t, 0.08, hz * 5, 0.6);
      }
    }
  });
  for (let i = 0; i < out.length; i++) out[i] += noise * (next() * 2 - 1);
  return { samples: out, beats, bars: beats.filter((_, i) => i % 4 === 0) };
}

const distance = (time, list) => Math.min(...list.map(other => Math.abs(time - other)));
const share = (list, ok) => list.filter(ok).length / list.length;

/** The common checks: tempo within 1 %, anchor on a bar line, beats and downbeats on the grid. */
function assertGrid(result, track, bpm, label) {
  assert.ok(result, `${label}: no result`);
  assert.ok(Math.abs(result.bpm / bpm - 1) < 0.01, `${label}: ${result.bpm} BPM`);
  assert.ok(Math.abs(result.beat - 60 / result.bpm) < 1e-3, label);
  assert.ok(distance(result.anchor, track.bars) <= 0.04, `${label}: anchor ${result.anchor} is ${distance(result.anchor, track.bars)} s from a bar line`);
  assert.ok(share(result.beats, time => distance(time, track.beats) <= 0.04) >= 0.95, `${label}: beats off the grid`);
  assert.ok(share(result.downbeats, time => distance(time, track.bars) <= 0.04) >= 0.95, `${label}: downbeats off the bar lines`);
  assert.ok(result.beats.every((time, i) => i === 0 || time > result.beats[i - 1]), `${label}: beats not ascending`);
  assert.ok(result.confidence > 0.5 && result.confidence <= 1, `${label}: confidence ${result.confidence}`);
  assert.ok(result.downbeatConfidence >= 0 && result.downbeatConfidence <= 1, label);
}

test('toMono averages the channels over the shortest length', () => {
  const mono = beat.toMono([Float32Array.of(1, 0.5, 0.25), [0, 0.5]]);
  assert.ok(mono instanceof Float32Array);
  assert.deepEqual(Array.from(mono), [0.5, 0.5]);
  const single = Float32Array.of(0.1, 0.2);
  const copy = beat.toMono([single]);
  assert.notEqual(copy, single);
  assert.deepEqual(copy, Float32Array.of(0.1, 0.2));
  assert.equal(beat.toMono([]).length, 0);
  assert.throws(() => beat.toMono(Float32Array.of(1)), TypeError);
});

test('resample keeps the band and removes what would alias', () => {
  const sine = (hz, rate, seconds) => Float32Array.from({ length: rate * seconds }, (_, i) => Math.sin(2 * Math.PI * hz * i / rate));
  const level = samples => {
    let sum = 0, n = 0;
    for (let i = 2000; i < samples.length - 2000; i++) { sum += samples[i] ** 2; n++; }
    return Math.sqrt(2 * sum / n);
  };
  for (const from of [44100, 48000, 22050]) {
    const down = beat.resample(sine(1000, from, 1), from, RATE);
    assert.equal(down.length, RATE);
    assert.ok(Math.abs(level(down) - 1) < 0.01, `${from}: 1 kHz level ${level(down)}`);
    assert.ok(level(beat.resample(sine(8000, from, 1), from, RATE)) < 0.001, `${from}: 8 kHz leaks through`);
  }
  // The waveform lands where it should: a 100 Hz sine stays in phase.
  const slow = beat.resample(sine(100, 44100, 1), 44100, RATE);
  assert.ok(Math.abs(slow[5000] - Math.sin(2 * Math.PI * 100 * 5000 / RATE)) < 0.01);
  assert.deepEqual(beat.resample(Float32Array.of(1, 2, 3), 8000, 8000), Float32Array.of(1, 2, 3));
  assert.deepEqual(beat.resample(Float32Array.of(0, 1), 1, 2), Float32Array.of(0, 0.5, 1, 1));
  assert.throws(() => beat.resample(Float32Array.of(0), 0, RATE), RangeError);
  assert.throws(() => beat.resample(Float32Array.of(0), 44100, NaN), RangeError);
});

for (const pattern of ['click', 'kickhat']) {
  for (const [bpm, offset] of [[92, 1.37], [120, 0.81], [150, 2.05], [174, 1.13]]) {
    test(`${pattern} track at ${bpm} BPM: tempo, beats and bar lines`, () => {
      const track = drums({ bpm, pattern, offset, seed: bpm });
      assertGrid(beat.estimateBeats(track.samples, RATE), track, bpm, `${pattern} ${bpm}`);
    });
  }
}

test('kick-snare backbeats keep their tempo octave, fast and slow', () => {
  for (const bpm of [92, 128, 174, 186]) {
    const track = drums({ bpm, pattern: 'backbeat', seed: bpm });
    assertGrid(beat.estimateBeats(track.samples, RATE), track, bpm, `backbeat ${bpm}`);
  }
});

test('bar lines found from bass-note changes alone', () => {
  for (const bpm of [118, 164]) {
    const track = drums({ bpm, pattern: 'bassline', offset: 0.6, seed: bpm });
    assertGrid(beat.estimateBeats(track.samples, RATE), track, bpm, `bassline ${bpm}`);
  }
});

test('swing, slight drift, heavy noise and a break', () => {
  const swung = drums({ bpm: 132, pattern: 'kickhat', swing: true, seed: 3 });
  assertGrid(beat.estimateBeats(swung.samples, RATE), swung, 132, 'swing 132');
  // 118.2 → 121.8 BPM over a minute: the beats follow, the fitted tempo is the mean.
  const drifting = drums({ bpm: 120, pattern: 'kickhat', drift: 0.03, seconds: 60, seed: 4 });
  assertGrid(beat.estimateBeats(drifting.samples, RATE), drifting, 120, 'drift 120');
  const noisy = drums({ bpm: 140, pattern: 'backbeat', noise: 0.2, seed: 5 });
  assertGrid(beat.estimateBeats(noisy.samples, RATE), noisy, 140, 'noisy 140');
  // Eight bars without drums: beats continue evenly through them, bar lines stay in place.
  const pause = [25, 25 + 32 * 60 / 92];
  const broken = drums({ bpm: 92, pattern: 'kickhat', seconds: 60, pause, seed: 6 });
  const result = beat.estimateBeats(broken.samples, RATE);
  assertGrid(result, broken, 92, 'break 92');
  assert.equal(result.beats.filter(time => time > pause[0] - 0.1 && time < pause[1] - 0.1).length, 32);
});

test('other sample rates give the same grid, directly or resampled', () => {
  const track = drums({ bpm: 150, pattern: 'backbeat', rate: 44100, seed: 7 });
  const direct = beat.estimateBeats(track.samples, 44100);
  const resampled = beat.estimateBeats(beat.resample(track.samples, 44100, RATE), RATE);
  assertGrid(direct, track, 150, '44.1 kHz');
  assertGrid(resampled, track, 150, '44.1 kHz resampled');
  assert.ok(Math.abs(direct.anchor - resampled.anchor) <= 0.01);
});

test('the tempo range chooses the octave', () => {
  const slow = drums({ bpm: 92, pattern: 'kickhat', seed: 8 });
  const doubled = beat.estimateBeats(slow.samples, RATE, { minBpm: 100, maxBpm: 200 });
  assert.ok(Math.abs(doubled.bpm / 184 - 1) < 0.01, `${doubled.bpm}`);
  // Kicks on every beat, the first of each bar louder: the half-tempo beats fall on beats 1 and 3.
  const fast = drums({ bpm: 174, pattern: 'kickhat', seed: 9 });
  const halved = beat.estimateBeats(fast.samples, RATE, { minBpm: 60, maxBpm: 120 });
  assert.ok(Math.abs(halved.bpm / 87 - 1) < 0.01, `${halved.bpm}`);
  assert.ok(distance(halved.anchor, fast.bars) <= 0.04);
  // A backbeat forced to half tempo keeps the tempo; which pair of beats it lands on is open.
  const backbeat = drums({ bpm: 174, pattern: 'backbeat', seed: 9 });
  const half = beat.estimateBeats(backbeat.samples, RATE, { minBpm: 60, maxBpm: 120 });
  assert.ok(Math.abs(half.bpm / 87 - 1) < 0.01, `${half.bpm}`);
  assert.ok(share(half.beats, time => distance(time, backbeat.beats) <= 0.04) >= 0.95);
});

test('no pulse gives null: silence, noise, a steady tone, too short', () => {
  assert.equal(beat.estimateBeats(new Float32Array(30 * RATE), RATE), null);
  for (const seed of [1, 2, 3]) {
    const next = random(seed);
    const noise = Float32Array.from({ length: 30 * RATE }, () => 0.3 * (next() * 2 - 1));
    assert.equal(beat.estimateBeats(noise, RATE), null, `white noise ${seed}`);
  }
  const hum = Float32Array.from({ length: 30 * RATE }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / RATE));
  assert.equal(beat.estimateBeats(hum, RATE), null);
  const short = drums({ bpm: 120, pattern: 'kickhat', seconds: 5 });
  assert.equal(beat.estimateBeats(short.samples, RATE), null);
});

test('estimateBeats refuses bad arguments', () => {
  const samples = new Float32Array(10 * RATE);
  assert.throws(() => beat.estimateBeats(null, RATE), TypeError);
  assert.throws(() => beat.estimateBeats(samples, 2000), RangeError);
  assert.throws(() => beat.estimateBeats(samples, RATE, { minBpm: 150, maxBpm: 100 }), RangeError);
  assert.throws(() => beat.estimateBeats(samples, RATE, { minBpm: 0 }), RangeError);
  assert.throws(() => beat.estimateBeats(samples, RATE, { maxBpm: 1e6 }), RangeError);
  assert.throws(() => beat.estimateBeats(samples, RATE, { minBpm: NaN }), RangeError);
  assert.equal(beat.estimateBeats(samples, RATE, null), null);
});

test('a 240 s track at 11025 Hz is analysed in well under 3 s', (t) => {
  const track = drums({ bpm: 168, pattern: 'backbeat', seconds: 240, seed: 10 });
  const started = performance.now();
  const result = beat.estimateBeats(track.samples, RATE);
  const elapsed = performance.now() - started;
  t.diagnostic(`240 s analysed in ${elapsed.toFixed(0)} ms`);
  assertGrid(result, track, 168, '240 s');
  assert.ok(elapsed < 3000, `${elapsed} ms`);
});
