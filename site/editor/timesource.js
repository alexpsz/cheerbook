// Where the editor's time comes from. With an audio file chosen it is that file; without one it is
// a silent clock that runs on the page's own monotonic time, so a cheer can be watched, and made
// from memory and lyric times, with no audio at all (CheerBook C-016). Both look the same to the
// editor: a position in seconds, a length, playing or not, play / pause / seek / rate.
//
// `audio` is an HTMLAudioElement (or anything with its members used here). `now` returns seconds on
// a monotonic clock; `schedule` / `cancel` are setTimeout / clearTimeout. They are parameters so the
// clock can be tested without a browser.
export function createTransport(audio, { now = () => performance.now() / 1000, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = {}) {
  const listeners = { play: [], pause: [], ended: [], seeked: [] };
  const emit = name => { for (const listener of listeners[name]) listener(); };
  let kind = 'none';
  const silent = { duration: 0, base: 0, startedAt: null, rate: 1, timer: null };

  const silentPosition = () => (silent.startedAt === null ? silent.base
    : Math.min(silent.duration, silent.base + (now() - silent.startedAt) * silent.rate));
  const disarm = () => { if (silent.timer !== null) { cancel(silent.timer); silent.timer = null; } };
  // The clock stops itself at the end of the song, as an audio element does.
  const arm = () => {
    disarm();
    if (silent.startedAt === null) return;
    const left = (silent.duration - silentPosition()) / silent.rate;
    silent.timer = schedule(() => {
      silent.timer = null;
      silent.base = silent.duration;
      silent.startedAt = null;
      emit('pause');
      emit('ended');
    }, Math.max(0, left * 1000));
  };
  const hold = () => {
    if (silent.startedAt === null) return;
    silent.base = silentPosition();
    silent.startedAt = null;
    disarm();
  };

  for (const name of Object.keys(listeners)) audio.addEventListener(name, () => { if (kind === 'audio') emit(name); });

  return {
    /** 'none' until a source is chosen, then 'audio' or 'silent'. */
    get kind() { return kind; },
    get ready() { return kind === 'audio' || (kind === 'silent' && silent.duration > 0); },
    get paused() { return kind === 'audio' ? audio.paused : silent.startedAt === null; },
    position() { return kind === 'audio' ? audio.currentTime || 0 : kind === 'silent' ? silentPosition() : 0; },
    /** The source's own length in seconds, or 0 when it has none yet. */
    duration() {
      if (kind === 'audio') return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      return kind === 'silent' ? silent.duration : 0;
    },
    on(name, listener) { listeners[name].push(listener); },

    /** The audio element is loaded: it is the time from here on. The silent clock stops. */
    useAudio() {
      const wasPlaying = kind === 'silent' && silent.startedAt !== null;
      hold();
      kind = 'audio';
      if (wasPlaying) emit('pause');
    },
    /**
     * The silent clock is the time, `duration` seconds long (a length that is not a positive
     * number leaves it with nothing to play). The position is kept, within the new length; an
     * audio file that was playing is paused.
     */
    useSilent(duration) {
      const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
      const from = kind === 'audio' ? audio.currentTime || 0 : silentPosition();
      if (kind === 'audio' && !audio.paused) audio.pause();
      const wasPlaying = kind === 'silent' && silent.startedAt !== null;
      kind = 'silent';
      silent.duration = length;
      silent.base = Math.min(Math.max(0, from), length);
      silent.startedAt = wasPlaying && silent.base < length ? now() : null;
      arm();
      if (wasPlaying && silent.startedAt === null) emit('pause');
    },

    /** Resolves once playing; rejects as the audio element does when the browser refuses. */
    play() {
      if (kind === 'audio') return Promise.resolve(audio.play());
      if (kind !== 'silent' || !(silent.duration > 0)) return Promise.reject(new Error('nothing to play'));
      if (silent.startedAt !== null) return Promise.resolve();
      if (silent.base >= silent.duration) silent.base = 0;
      silent.startedAt = now();
      arm();
      emit('play');
      return Promise.resolve();
    },
    pause() {
      if (kind === 'audio') { audio.pause(); return; }
      if (silent.startedAt === null) return;
      hold();
      emit('pause');
    },
    seek(to) {
      if (kind === 'audio') { audio.currentTime = Math.min(Math.max(0, to), this.duration()); return; }
      if (kind !== 'silent') return;
      const playing = silent.startedAt !== null;
      silent.base = Math.min(Math.max(0, Number.isFinite(to) ? to : 0), silent.duration);
      silent.startedAt = playing ? now() : null;
      arm();
      emit('seeked');
    },
    /** The playback rate, for both sources (a rate that is not a positive number reads as 1). */
    setRate(rate) {
      const value = Number.isFinite(rate) && rate > 0 ? rate : 1;
      audio.playbackRate = value;
      if (silent.startedAt !== null) { silent.base = silentPosition(); silent.startedAt = now(); }
      silent.rate = value;
      arm();
    },
  };
}
