// Runs the beat analysis (lib/beat.js) off the main thread, on samples the page decoded from the
// visitor's own file. Nothing leaves the browser.
import lib from '/editor/lib.js';

const RATE = 11025;

self.onmessage = event => {
  const { channels, sampleRate } = event.data || {};
  try {
    const mono = lib.beat.toMono(channels);
    const samples = sampleRate === RATE ? mono : lib.beat.resample(mono, sampleRate, RATE);
    self.postMessage({ ok: true, result: lib.beat.estimateBeats(samples, RATE) });
  } catch (error) {
    self.postMessage({ ok: false, message: String((error && error.message) || error) });
  }
};
