'use strict';
// Beat grid from decoded audio, so the web cheer editor can snap MIX to bars (4/4). Runs in the
// browser (inside a Web Worker) as well as in Node, so it uses no Node modules and no I/O: the page
// decodes the audio and hands over PCM samples.
//
// Method (Ellis 2007, "Beat tracking by dynamic programming", with a few additions):
// 1. Onset strength: short-time spectra (radix-2 FFT, two real frames per complex transform),
//    grouped into mel-spaced bands from 30 Hz to 5.5 kHz, in dB above each band's quiet level; the
//    envelope is the rise in level from one frame to the next (spectral flux), with the bass, low
//    mid, mid and high regions weighted so hi-hats cannot outweigh kick and snare.
// 2. Tempo: autocorrelation of the envelope (slow swells removed), weighted by a prior that is
//    flat over 80–160 BPM and falls off outside it.
// 3. Octave: beats are tracked at the fastest level of that tempo family within range, and the
//    tempo is halved while every other beat is much weaker than its neighbours (an off-beat).
// 4. Beats: dynamic programming that rewards onsets and penalises gaps unlike the period, run
//    again at the period fitted through the tracked beats; beats with no onset under them (a break)
//    are re-spaced evenly between the supported beats around them.
// 5. Downbeat: of the four beat phases, the one with the strongest low-frequency accent and the
//    biggest change in spectrum from the beat before (chords tend to change on bar lines).
// Memory stays bounded: typed arrays per frame (about 14 KB per second of audio), nothing per sample.

const MIN_SECONDS = 6;            // Shorter audio cannot show a steady tempo.
const ANALYSIS_BOTTOM = 30;       // Hz.
const ANALYSIS_TOP = 5500;        // Hz. Content above is ignored, so every input rate gives the same answer.
const BANDS = 32;
const REGIONS = [200, 800, 2500, Infinity];   // Hz, upper edges of bass, low mid, mid and high.
const REGION_WEIGHTS = [1, 1, 0.6, 0.3];      // Their shares of the onset envelope.
const LOW_TOP = 200;              // Hz: kick drum and bass, for the downbeat accent.
const FLOOR_PERCENTILE = 0.3;     // A band's quiet level: this share of its frames are quieter.
const FLOOR_DB = 80;              // Floors never go further than this below the loudest band.
const PRIOR_LOW = 80, PRIOR_HIGH = 160, PRIOR_WIDTH = 0.5;   // BPM, BPM, octaves.
const EVEN_BEATS = 0.4;           // Alternate beats at least this even: a real beat level, not off-beats…
const EVEN_BEATS_FAST = 0.55;     // …and stricter above PRIOR_HIGH, where half the tempo is more likely.
const TIGHTNESS = 100;            // How strongly the tracker keeps the period (Ellis's alpha).
const MIN_PULSE = 0.1;            // Autocorrelation below this at the best lag: no usable pulse.
const MIN_BEATS = 8;
const WEAK_BEAT = 0.4;            // A beat with less onset than this share of the median beat's is re-spaced.
const DOWNBEAT_MARGIN = 8;        // Standard errors between the best and second phase for full downbeat confidence.
// Seconds added to every beat: spectral flux peaks about 7 ms before the window centre reaches an
// attack (measured on synthetic kicks, snares and clicks at 70–190 BPM).
const LATENCY = 0.007;

/**
 * Mixes channels to one.
 *
 * Input: an array of channels (Float32Array or arrays of numbers, e.g. AudioBuffer.getChannelData).
 * Output: a new Float32Array, the mean of the channels, as long as the shortest channel; an empty
 * array for no channels. Failure: throws TypeError when `channels` is not an array.
 */
function toMono(channels) {
  if (!Array.isArray(channels)) throw new TypeError('toMono expects an array of channels');
  if (!channels.length) return new Float32Array(0);
  let length = Infinity;
  for (const channel of channels) length = Math.min(length, channel.length);
  const out = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) out[i] += channel[i];
  if (channels.length > 1) {
    const scale = 1 / channels.length;
    for (let i = 0; i < length; i++) out[i] *= scale;
  }
  return out;
}

/**
 * Changes the sample rate.
 *
 * Input: mono samples, the rate they are at and the rate wanted (Hz). Downsampling low-passes with
 * a windowed-sinc filter (Blackman window, 6 zero crossings, 256 sub-sample phases); going to
 * 11025 Hz it is flat to 3 kHz, −6 dB at 5 kHz, −22 dB at 6 kHz and below −60 dB from 7 kHz, ample
 * for onset detection (aliasing moves energy in frequency, not in time). Upsampling interpolates
 * linearly. Output: a new Float32Array of round(length × toRate / fromRate) samples.
 * Failure: throws RangeError for rates that are not positive finite numbers.
 */
function resample(samples, fromRate, toRate) {
  if (!(fromRate > 0 && toRate > 0 && Number.isFinite(fromRate) && Number.isFinite(toRate))) throw new RangeError('resample needs positive sample rates');
  const n = samples.length;
  const outLength = Math.round(n * toRate / fromRate);
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  if (ratio === 1) { for (let i = 0; i < outLength; i++) out[i] = samples[i]; return out; }
  if (ratio < 1) {
    for (let m = 0; m < outLength; m++) {
      const x = m * ratio, i = Math.floor(x), f = x - i;
      const a = i < n ? samples[i] : 0, b = i + 1 < n ? samples[i + 1] : a;
      out[m] = a + (b - a) * f;
    }
    return out;
  }
  const PHASES = 256, ZEROS = 6;
  const cutoff = 0.9 * 0.5 / ratio;                 // Cycles per input sample.
  const half = Math.ceil(ZEROS / (2 * cutoff));      // Kernel half-width, input samples.
  const taps = 2 * half;
  const table = new Float32Array((PHASES + 1) * taps);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const t = j - half + 1 - frac;                // Distance from the output position, input samples.
      const x = 2 * cutoff * t;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = Math.abs(t) >= half ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * t / half) + 0.08 * Math.cos(2 * Math.PI * t / half);
      const value = sinc * w;
      table[p * taps + j] = value;
      sum += value;
    }
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;   // Unit gain at DC.
  }
  for (let m = 0; m < outLength; m++) {
    const x = m * ratio, base = Math.floor(x);
    const phase = Math.round((x - base) * PHASES) * taps;
    const first = base - half + 1;
    let acc = 0;
    if (first >= 0 && first + taps <= n) {
      for (let j = 0; j < taps; j++) acc += samples[first + j] * table[phase + j];
    } else {
      for (let j = 0; j < taps; j++) { const i = first + j; if (i >= 0 && i < n) acc += samples[i] * table[phase + j]; }
    }
    out[m] = acc;
  }
  return out;
}

/** An in-place radix-2 complex FFT of size `size` (a power of two). */
function makeFFT(size) {
  const levels = Math.round(Math.log2(size));
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / size); sin[i] = -Math.sin(2 * Math.PI * i / size); }
  return (re, im) => {
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1, step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const a = start + k, b = a + half;
          const wr = cos[w], wi = sin[w];
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

const mel = hz => 2595 * Math.log10(1 + hz / 700);

/**
 * Per frame: band levels in dB (frames × BANDS), the onset envelope (mean positive rise in level)
 * and low-band power. Frames are centred on multiples of `hop`. Null for silence.
 */
function onsetFeatures(samples, sampleRate) {
  const length = samples.length;
  let peak = 0;
  for (let i = 0; i < length; i++) { const v = samples[i] < 0 ? -samples[i] : samples[i]; if (v > peak) peak = v; }
  if (!(peak > 1e-4)) return null;

  const size = 2 ** Math.round(Math.log2(0.046 * sampleRate));
  const hop = size / 4, half = size / 2;
  const frames = Math.floor(length / hop) + 1;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  const binHz = sampleRate / size;
  const firstBin = Math.max(1, Math.ceil(ANALYSIS_BOTTOM / binHz));
  const lastBin = Math.min(half, Math.floor(Math.min(sampleRate / 2, ANALYSIS_TOP) / binHz));
  const lowLast = Math.min(lastBin, Math.floor(LOW_TOP / binHz));
  const bandOf = new Int32Array(half + 1).fill(-1);
  const melLow = mel(firstBin * binHz), melHigh = mel(lastBin * binHz) + 1e-9;
  const used = new Uint8Array(BANDS);
  for (let k = firstBin; k <= lastBin; k++) {
    const band = Math.min(BANDS - 1, Math.floor((mel(k * binHz) - melLow) / (melHigh - melLow) * BANDS));
    bandOf[k] = band;
    used[band] = 1;
  }
  // Each region (bass, low mid, mid, high) gets a fixed share of the envelope however many bands it
  // spans, so broadband hi-hat noise cannot outweigh the kick and snare that carry the beat.
  const region = band => {
    const hz = 700 * (10 ** ((melLow + (band + 0.5) / BANDS * (melHigh - melLow)) / 2595) - 1);
    return REGIONS.findIndex(top => hz < top);
  };
  const perRegion = REGION_WEIGHTS.map(() => 0);
  for (let b = 0; b < BANDS; b++) if (used[b]) perRegion[region(b)]++;
  const weight = new Float64Array(BANDS);
  let totalWeight = 0;
  REGION_WEIGHTS.forEach((share, i) => { if (perRegion[i]) totalWeight += share; });
  for (let b = 0; b < BANDS; b++) if (used[b]) weight[b] = REGION_WEIGHTS[region(b)] / perRegion[region(b)] / totalWeight;

  const fft = makeFFT(size);
  const re = new Float64Array(size), im = new Float64Array(size);
  const level = new Float32Array(frames * BANDS);
  const low = new Float32Array(frames);
  for (let t = 0; t < frames; t += 2) {
    const a = t * hop - half, b = a + hop, second = t + 1 < frames;
    if (a >= 0 && b + size <= length) {
      for (let n = 0; n < size; n++) { re[n] = samples[a + n] * window[n]; im[n] = samples[b + n] * window[n]; }
    } else {
      for (let n = 0; n < size; n++) {
        const i = a + n, j = b + n;
        re[n] = i >= 0 && i < length ? samples[i] * window[n] : 0;
        im[n] = second && j >= 0 && j < length ? samples[j] * window[n] : 0;
      }
    }
    fft(re, im);
    // Two real frames in one transform: X1[k] = (Z[k] + conj Z[N−k]) / 2, X2[k] = (Z[k] − conj Z[N−k]) / 2i.
    const rowA = t * BANDS, rowB = rowA + BANDS;
    for (let k = firstBin; k <= lastBin; k++) {
      const j = (size - k) & (size - 1);
      const ar = re[k] + re[j], ai = im[k] - im[j];
      const br = im[k] + im[j], bi = re[j] - re[k];
      const powerA = 0.25 * (ar * ar + ai * ai), powerB = 0.25 * (br * br + bi * bi);
      const band = bandOf[k];
      level[rowA + band] += powerA;
      if (second) level[rowB + band] += powerB;
      if (k <= lowLast) { low[t] += powerA; if (second) low[t + 1] += powerB; }
    }
  }
  // Levels in dB above a floor per band: the band's quiet level over the whole track (a low
  // percentile), but never under FLOOR_DB below the loudest band. Steady noise then barely moves
  // the levels, while attacks rise well above it.
  let loudest = 0;
  for (let i = 0; i < level.length; i++) if (level[i] > loudest) loudest = level[i];
  const silence = loudest * 10 ** (-FLOOR_DB / 10) + 1e-30;
  const stride = Math.max(1, Math.floor(frames / 4096));
  const sample = new Float32Array(Math.ceil(frames / stride));
  const floors = new Float64Array(BANDS);
  for (let band = 0; band < BANDS; band++) {
    let count = 0;
    for (let t = 0; t < frames; t += stride) sample[count++] = level[t * BANDS + band];
    const sorted = sample.subarray(0, count).sort();
    floors[band] = Math.max(silence, sorted[Math.floor(count * FLOOR_PERCENTILE)]);
  }
  for (let t = 0; t < frames; t++) for (let band = 0; band < BANDS; band++) {
    const i = t * BANDS + band;
    level[i] = 10 * Math.log10(level[i] + floors[band]);
  }
  const envelope = new Float32Array(frames);
  for (let t = 1; t < frames; t++) {
    let rise = 0;
    for (let band = 0, now = t * BANDS, before = now - BANDS; band < BANDS; band++) {
      const d = level[now + band] - level[before + band];
      if (d > 0) rise += d * weight[band];
    }
    envelope[t] = rise;
  }
  return { envelope, level, low, frames, fps: sampleRate / hop };
}

/** The envelope minus its running mean over about ±1 s, so slow swells do not look periodic. */
function detrend(envelope, radius) {
  const n = envelope.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + envelope[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius), hi = Math.min(n, i + radius + 1);
    out[i] = envelope[i] - (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/** Normalised autocorrelation for lags 0…maxLag (each lag divided by its overlap). */
function autocorrelation(x, maxLag) {
  const n = x.length;
  const r = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < n; lag++) {
    let sum = 0;
    for (let t = 0, end = n - lag; t < end; t++) sum += x[t] * x[t + lag];
    r[lag] = sum / (n - lag);
  }
  const zero = r[0] || 1;
  for (let lag = 0; lag <= maxLag; lag++) r[lag] /= zero;
  return r;
}

/** Linear interpolation of r at a fractional lag. */
function at(r, lag) {
  const i = Math.floor(lag);
  if (i < 0) return r[0];
  if (i + 1 >= r.length) return r[r.length - 1];
  return r[i] + (r[i + 1] - r[i]) * (lag - i);
}

function tempoPrior(bpm) {
  if (bpm >= PRIOR_LOW && bpm <= PRIOR_HIGH) return 1;
  const octaves = bpm < PRIOR_LOW ? Math.log2(PRIOR_LOW / bpm) : Math.log2(bpm / PRIOR_HIGH);
  return Math.exp(-0.5 * (octaves / PRIOR_WIDTH) ** 2);
}

/** The best period in frames by prior-weighted autocorrelation, or null. */
function bestLag(r, fps, minBpm, maxBpm) {
  const lo = Math.max(2, Math.ceil(60 * fps / maxBpm)), hi = Math.min(r.length - 2, Math.floor(60 * fps / minBpm));
  let best = -1, bestScore = 0;
  for (let lag = lo; lag <= hi; lag++) {
    if (!(r[lag] > 0 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1])) continue;
    const score = r[lag] * tempoPrior(60 * fps / lag);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0) return null;
  const a = r[best - 1], b = r[best], c = r[best + 1];
  const curve = a - 2 * b + c;
  const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / curve)) : 0;
  return best + shift;
}

/** The envelope scaled to unit deviation and smoothed with a Gaussian of period/32 frames (Ellis). */
function localScore(envelope, period) {
  const n = envelope.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += envelope[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (envelope[i] - mean) ** 2;
  const scale = 1 / (Math.sqrt(variance / Math.max(1, n - 1)) || 1);
  const sigma = Math.max(0.5, period / 32), reach = Math.ceil(3 * sigma);
  const kernel = new Float64Array(2 * reach + 1);
  for (let k = -reach; k <= reach; k++) kernel[k + reach] = Math.exp(-0.5 * (k / sigma) ** 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -reach; k <= reach; k++) { const j = i + k; if (j >= 0 && j < n) sum += envelope[j] * kernel[k + reach]; }
    out[i] = sum * scale;
  }
  return out;
}

/** Ellis's dynamic programme: beat frames best explaining the score at about `period` frames apart. */
function trackBeats(score, period) {
  const n = score.length;
  const lo = Math.max(1, Math.round(period / 2)), hi = Math.max(lo + 1, Math.round(period * 2));
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = TIGHTNESS * Math.log(d / period) ** 2;
  const total = new Float64Array(n), back = new Int32Array(n).fill(-1);
  let strongest = 0;
  for (let i = 0; i < n; i++) if (score[i] > strongest) strongest = score[i];
  const threshold = 0.01 * strongest;
  let started = false;
  for (let t = 0; t < n; t++) {
    let best = -Infinity, from = -1;
    for (let d = lo, end = Math.min(hi, t); d <= end; d++) {
      const value = total[t - d] - penalty[d];
      if (value > best) { best = value; from = t - d; }
    }
    if (from < 0) { total[t] = score[t]; continue; }
    total[t] = score[t] + best;
    if (started || score[t] >= threshold) { back[t] = from; started = true; }
  }
  // The last beat: the last local maximum of the running total that is not weak.
  const peaks = [];
  for (let t = 1; t < n - 1; t++) if (total[t] > total[t - 1] && total[t] >= total[t + 1]) peaks.push(t);
  if (!peaks.length) return [];
  const sorted = peaks.map(t => total[t]).sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1];
  let last = peaks[peaks.length - 1];
  for (let i = peaks.length - 1; i >= 0; i--) if (total[peaks[i]] >= 0.5 * median) { last = peaks[i]; break; }
  const beats = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  // Trim weak beats at both ends (silence or noise before and after the music): weaker than a
  // third of the median beat. The median, unlike a mean, is not raised by accented downbeats.
  const strengths = beats.map(t => score[t]);
  const cut = strengths.slice().sort((x, y) => x - y)[strengths.length >> 1] / 3;
  let first = 0, end = beats.length;
  while (first < end && strengths[first] < cut) first++;
  while (end > first && strengths[end - 1] < cut) end--;
  return beats.slice(first, end);
}

/** The strongest envelope frame within `reach` of a tracked beat frame. */
function peakNear(envelope, t, reach) {
  let best = t;
  for (let j = Math.max(1, t - reach); j <= Math.min(envelope.length - 2, t + reach); j++) if (envelope[j] > envelope[best]) best = j;
  return best;
}

/** Fractional frame of a beat: the parabola through the envelope peak near the tracked frame. */
function refine(envelope, t, reach) {
  const best = peakNear(envelope, t, reach);
  if (best <= 0 || best >= envelope.length - 1) return best;
  const a = envelope[best - 1], b = envelope[best], c = envelope[best + 1];
  const curve = a - 2 * b + c;
  return curve < 0 ? best + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / curve)) : best;
}

/** Which beats have a clear onset under them: at least WEAK_BEAT of the median beat's. */
function supported(positions, envelope, reach) {
  const support = positions.map(p => envelope[peakNear(envelope, Math.round(p), reach)]);
  const cut = WEAK_BEAT * support.slice().sort((x, y) => x - y)[support.length >> 1];
  return support.map(value => value >= cut);
}

/**
 * Least-squares line through the supported beats, in frames: { origin, period }. Each beat's
 * index counts whole periods from the supported beat before it, so a beat the tracker added or
 * lost in a break does not bend the line. Refitted once without outliers.
 */
function fitGrid(positions, strong, period) {
  const xs = [], ys = [];
  let index = 0, last = -1;
  positions.forEach((position, i) => {
    if (!strong[i]) return;
    if (last >= 0) index += Math.max(1, Math.round((position - positions[last]) / period));
    xs.push(index); ys.push(position); last = i;
  });
  const fit = keep => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    xs.forEach((x, j) => { if (!keep(j)) return; const y = ys[j]; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { origin: (sy - slope * sx) / n, period: slope };
  };
  if (xs.length < 2) return { origin: positions[0], period };
  const first = fit(() => true);
  const second = fit(j => Math.abs(ys[j] - (first.origin + first.period * xs[j])) <= 0.25 * first.period);
  if (Number.isFinite(second.period) && second.period > 0) return second;
  return Number.isFinite(first.period) && first.period > 0 ? first : { origin: positions[0], period };
}

/**
 * Beats with little onset under them (a break, a held chord) wander towards noise. With a steady
 * tempo they belong evenly between the supported beats on either side, so each gap between
 * supported beats is filled with as many evenly spaced beats as it holds whole periods. Weak beats
 * before the first and after the last supported beat are dropped: the beats cover the span where
 * the pulse is evident, and the grid extends beyond it.
 */
function regularize(positions, strong, period) {
  const out = [], kept = [];
  const add = (position, isStrong) => { out.push(position); kept.push(isStrong); };
  let previous = -1;
  positions.forEach((position, i) => {
    if (!strong[i]) return;
    if (previous >= 0) {
      const span = position - positions[previous];
      const count = Math.max(1, Math.round(span / period));
      for (let k = 1; k < count; k++) add(positions[previous] + span * k / count, false);
    }
    add(position, true);
    previous = i;
  });
  return { positions: out, strong: kept };
}

/**
 * How even neighbouring beats are: the weaker of each adjacent pair summed over the stronger,
 * 1 when every beat is alike, near 0 when strong and weak beats alternate (beats and off-beats).
 * Pairs rather than even against odd beats, so a tracker that slips by one in a break still
 * shows the alternation.
 */
function alternation(envelope, beats) {
  let weaker = 0, stronger = 0, before = -1;
  for (const t of beats) {
    let peak = 0;
    for (let j = Math.max(0, t - 2); j <= Math.min(envelope.length - 1, t + 2); j++) if (envelope[j] > peak) peak = envelope[j];
    if (before >= 0) { weaker += Math.min(before, peak); stronger += Math.max(before, peak); }
    before = peak;
  }
  return stronger > 0 ? weaker / stronger : 1;
}

/**
 * Which of the four beat phases is the bar line, and by how much it wins: { phase, margin }. Two
 * cues per beat: the low-band (kick, bass) peak at the beat, and how much the mean spectrum over
 * the beat differs from the beat before (chords tend to change on bar lines). Only beats with a
 * clear onset count.
 */
function downbeatPhase(features, beats, strong) {
  const { low, level, frames } = features;
  const count = beats.length;
  let lowMean = 0;
  for (let t = 0; t < frames; t++) lowMean += low[t];
  lowMean = lowMean / frames || 1;
  const accent = new Float64Array(count), novelty = new Float64Array(count);
  const previous = new Float64Array(BANDS), current = new Float64Array(BANDS);
  for (let i = 0; i < count; i++) {
    const t = beats[i];
    let peak = 0;
    for (let j = Math.max(0, t - 1); j <= Math.min(frames - 1, t + 3); j++) if (low[j] > peak) peak = low[j];
    accent[i] = Math.log(1 + peak / lowMean);
    const end = Math.max(t + 1, Math.min(frames, i + 1 < count ? beats[i + 1] : t + (t - (i ? beats[i - 1] : t - 1))));
    current.fill(0);
    for (let f = t; f < end; f++) for (let b = 0; b < BANDS; b++) current[b] += level[f * BANDS + b];
    let distance = 0;
    for (let b = 0; b < BANDS; b++) { current[b] /= end - t; if (i) distance += (current[b] - previous[b]) ** 2; }
    novelty[i] = Math.sqrt(distance / BANDS);
    previous.set(current);
  }
  novelty[0] = novelty[1] ?? 0;
  const typical = Array.from(novelty).sort((x, y) => x - y)[count >> 1] || 1;
  for (let i = 0; i < count; i++) novelty[i] = Math.log(1 + novelty[i] / typical);
  // Each cue minus its mean over the surrounding four beats (one of each phase), so louder and
  // quieter sections and breaks cancel out; then a t statistic per phase (how far the phase's mean
  // lies from zero in standard errors), so a cue counts by how reliably it separates the phases.
  const standardized = values => {
    const local = i => {
      if (i < 2 || i + 2 >= count) return null;
      return values[i] - (0.5 * values[i - 2] + values[i - 1] + values[i] + values[i + 1] + 0.5 * values[i + 2]) / 4;
    };
    const sums = [0, 0, 0, 0], squares = [0, 0, 0, 0], counts = [0, 0, 0, 0];
    for (let i = 0; i < count; i++) {
      const x = strong[i] ? local(i) : null;
      if (x === null) continue;
      sums[i % 4] += x; squares[i % 4] += x * x; counts[i % 4]++;
    }
    let n = 0, total = 0;
    for (let p = 0; p < 4; p++) { n += counts[p]; total += squares[p] - (counts[p] ? sums[p] ** 2 / counts[p] : 0); }
    const deviation = Math.sqrt(total / Math.max(1, n - 4));
    return sums.map((sum, p) => (deviation > 0 && counts[p] ? (sum / counts[p]) / (deviation / Math.sqrt(counts[p])) : 0));
  };
  const a = standardized(accent), d = standardized(novelty);
  const scores = a.map((value, p) => value + d[p]);
  const order = [0, 1, 2, 3].sort((x, y) => scores[y] - scores[x]);
  return { phase: order[0], margin: scores[order[0]] - scores[order[1]] };
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const round = (x, places) => Math.round(x * 10 ** places) / 10 ** places;

/**
 * Estimates a steady 4/4 beat grid.
 *
 * Input: mono PCM samples (Float32Array or an array of numbers; about 11025 Hz is plenty, any rate
 * from 4000 Hz works and gives the same answer), their sample rate, and optionally the tempo range
 * `{ minBpm = 60, maxBpm = 200 }`. The range should span at least an octave: the tempo's octave is
 * chosen inside it (narrow it to force 87 rather than 174, say).
 * Output: null when the audio has no usable pulse (silence, noise, a steady tone, under 6 s, or
 * too few beats); otherwise `{ bpm, beat, anchor, confidence, beats, downbeats, downbeatConfidence }`:
 * - `bpm` and `beat` (seconds per beat) from a line fitted through the well-supported beats;
 * - `beats`: beat times in seconds, ascending; they follow small tempo drift, and through a break
 *   they are spaced evenly between the beats around it;
 * - `downbeats`: every fourth beat, at the phase judged to be the bar line;
 * - `anchor`: the first downbeat; for a steady tempo bar lines are anchor + k × 4 × beat (k may be
 *   negative for a pickup or intro before it);
 * - `confidence` (0–1): how clear and regular the pulse is; `downbeatConfidence` (0–1): how clearly
 *   one phase stands out as the bar line (low means the bar line may be a beat or two off).
 * Failure: throws TypeError for samples that are not array-like and RangeError for a sample rate
 * under 4000 Hz or a tempo range outside 20 ≤ minBpm < maxBpm ≤ 400. Times are rounded to 1 ms.
 */
function estimateBeats(samples, sampleRate, options) {
  const { minBpm = 60, maxBpm = 200 } = options || {};
  if (!samples || typeof samples.length !== 'number') throw new TypeError('estimateBeats expects an array of samples');
  if (!(Number.isFinite(sampleRate) && sampleRate >= 4000)) throw new RangeError('estimateBeats needs a sample rate of at least 4000 Hz');
  if (!(minBpm >= 20 && maxBpm <= 400 && maxBpm > minBpm)) throw new RangeError('estimateBeats needs 20 <= minBpm < maxBpm <= 400');
  if (samples.length < MIN_SECONDS * sampleRate) return null;
  const features = onsetFeatures(samples, sampleRate);
  if (!features) return null;
  const { envelope, fps } = features;
  const bpmOf = lag => 60 * fps / lag;

  const r = autocorrelation(detrend(envelope, Math.round(fps)), Math.ceil(60 * fps / minBpm) + 2);
  const lag = bestLag(r, fps, minBpm, maxBpm);
  if (lag === null || at(r, lag) < MIN_PULSE) return null;

  // Track at the fastest level of this tempo family within range, then halve while alternate beats are off-beats.
  let period = lag;
  while (bpmOf(period / 2) <= maxBpm) period /= 2;
  let score = localScore(envelope, period);
  let frames = trackBeats(score, period);
  while (bpmOf(period * 2) >= minBpm && frames.length >= 2 * MIN_BEATS) {
    const evenness = alternation(envelope, frames);
    if (evenness >= (bpmOf(period) > PRIOR_HIGH ? EVEN_BEATS_FAST : EVEN_BEATS)) break;
    period *= 2;
    score = localScore(envelope, period);
    frames = trackBeats(score, period);
  }
  if (frames.length < MIN_BEATS) return null;
  // Track once more at the fitted period, which is far more precise than the autocorrelation lag.
  let reach = Math.max(1, Math.round(period / 16));
  let positions = frames.map(t => refine(envelope, t, reach));
  let strong = supported(positions, envelope, reach);
  const fitted = fitGrid(positions, strong, period);
  if (fitted.period > 0.8 * period && fitted.period < 1.25 * period) {
    period = fitted.period;
    reach = Math.max(1, Math.round(period / 16));
    frames = trackBeats(localScore(envelope, period), period);
    if (frames.length < MIN_BEATS) return null;
    positions = frames.map(t => refine(envelope, t, reach));
    strong = supported(positions, envelope, reach);
  }
  const grid = fitGrid(positions, strong, period);
  ({ positions, strong } = regularize(positions, strong, grid.period));
  if (positions.length < MIN_BEATS) return null;
  const beatSeconds = grid.period / fps;
  const times = positions.map(p => p / fps + LATENCY);

  const { phase, margin } = downbeatPhase(features, positions.map(Math.round), strong);
  const downbeats = times.filter((_, i) => i % 4 === phase);
  let regular = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - times[i - 1] - beatSeconds) <= 0.1 * beatSeconds) regular++;
  const pulse = at(r, Math.min(grid.period, r.length - 2));
  const confidence = clamp01(pulse / 0.5) * (regular / Math.max(1, times.length - 1));

  return {
    bpm: round(60 / beatSeconds, 2),
    beat: round(beatSeconds, 5),
    anchor: round(downbeats[0], 3),
    confidence: round(confidence, 3),
    beats: times.map(t => round(t, 3)),
    downbeats: downbeats.map(t => round(t, 3)),
    downbeatConfidence: round(clamp01(margin / DOWNBEAT_MARGIN), 3),
  };
}

module.exports = { toMono, resample, estimateBeats };
