// Where the editor's time comes from. With an audio file chosen it is that file; without one it is
// a silent clock that runs on the page's own monotonic time, so a cheer can be watched, and made
// from memory and lyric times, with no audio at all (CheerBook C-016). Both look the same to the
// editor: a position in seconds, a length, playing or not, play / pause / seek / rate.
// A third source is an embedded video player that reports its own position (site/editor/youtube.js):
// the song then starts `offset` seconds into the video, and the editor's time is the song's.
//
// `audio` is an HTMLAudioElement (or anything with its members used here). `now` returns seconds on
// a monotonic clock; `schedule` / `cancel` are setTimeout / clearTimeout. They are parameters so the
// clock can be tested without a browser.
export function createTransport(audio, { now = () => performance.now() / 1000, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = {}) {
  // 'durationchange' and 'ratechange' come from a video player, whose length and rate the visitor can change in it.
  const listeners = { play: [], pause: [], ended: [], seeked: [], durationchange: [], ratechange: [] };
  const emit = name => { for (const listener of listeners[name]) listener(); };
  let kind = 'none';
  let video = null, videoOffset = 0;
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
    get ready() { return kind === 'audio' || (kind === 'silent' && silent.duration > 0) || (kind === 'video' && video.duration() > videoOffset); },
    get paused() { return kind === 'audio' ? audio.paused : kind === 'video' ? video.paused : silent.startedAt === null; },
    position() {
      if (kind === 'video') return Math.max(0, video.position() - videoOffset);
      return kind === 'audio' ? audio.currentTime || 0 : kind === 'silent' ? silentPosition() : 0;
    },
    /** The source's own length in seconds, or 0 when it has none yet. */
    duration() {
      if (kind === 'audio') return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      if (kind === 'video') return Math.max(0, video.duration() - videoOffset);
      return kind === 'silent' ? silent.duration : 0;
    },
    on(name, listener) { listeners[name].push(listener); },

    /** The audio element is loaded: it is the time from here on. The silent clock stops. */
    useAudio() {
      const wasPlaying = (kind === 'silent' && silent.startedAt !== null) || (kind === 'video' && !video.paused);
      const from = kind === 'silent' ? silentPosition() : kind === 'video' ? this.position() : null;
      if (kind === 'video' && !video.paused) video.pause();
      hold();
      video = null;
      kind = 'audio';
      // The audio picks up where the silent clock was, when that is inside the file.
      if (from !== null && from > 0 && Number.isFinite(audio.duration) && from < audio.duration) audio.currentTime = from;
      if (wasPlaying) emit('pause');
    },
    /**
     * The silent clock is the time, `duration` seconds long (a length that is not a positive
     * number leaves it with nothing to play). The position is kept, within the new length; an
     * audio file that was playing is paused.
     */
    useSilent(duration) {
      const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
      const from = kind === 'audio' ? audio.currentTime || 0 : kind === 'video' ? this.position() : silentPosition();
      // The audio element (or the video player) reports its pause later, when it is no longer the
      // source and is not listened to; so the pause is announced here.
      const audioWasPlaying = (kind === 'audio' && !audio.paused) || (kind === 'video' && !video.paused);
      if (kind === 'audio' && !audio.paused) audio.pause();
      if (kind === 'video' && !video.paused) video.pause();
      video = null;
      const wasPlaying = kind === 'silent' && silent.startedAt !== null;
      kind = 'silent';
      silent.duration = length;
      silent.base = Math.min(Math.max(0, from), length);
      silent.startedAt = wasPlaying && silent.base < length ? now() : null;
      arm();
      if (audioWasPlaying || (wasPlaying && silent.startedAt === null)) emit('pause');
    },

    /**
     * A video player is the time from here on. `player` has `position()`, `duration()`, `paused`,
     * `play()`, `pause()`, `seek(seconds)`, `setRate(rate)` in the video's own time, and calls
     * `notify` when it starts, stops, ends or jumps. `offset` is where the song starts in the video.
     */
    useVideo(player, offset = 0) {
      const wasPlaying = (kind === 'silent' && silent.startedAt !== null) || (kind === 'audio' && !audio.paused);
      if (kind === 'audio' && !audio.paused) audio.pause();
      hold();
      kind = 'video';
      video = player;
      videoOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
      if (wasPlaying) emit('pause');
    },
    /** Where the song starts in the video, in seconds; the position the editor sees moves with it. */
    get videoOffset() { return videoOffset; },
    setVideoOffset(offset) { videoOffset = Number.isFinite(offset) && offset > 0 ? offset : 0; if (kind === 'video') emit('seeked'); },
    /** The video's own position, whatever the offset. */
    videoPosition() { return kind === 'video' ? video.position() : 0; },
    /** The video player says it started, stopped, ended or jumped. */
    notify(name) { if (kind === 'video' && listeners[name]) emit(name); },

    /** Resolves once playing; rejects as the audio element does when the browser refuses. */
    play() {
      if (kind === 'audio') return Promise.resolve(audio.play());
      if (kind === 'video') { video.play(); return Promise.resolve(); }
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
      if (kind === 'video') { video.pause(); return; }
      if (silent.startedAt === null) return;
      hold();
      emit('pause');
    },
    seek(to) {
      if (kind === 'audio') { audio.currentTime = Math.min(Math.max(0, to), this.duration()); return; }
      if (kind === 'video') { video.seek(Math.max(0, Number.isFinite(to) ? to : 0) + videoOffset); return; }
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
      if (kind === 'video') video.setRate(value);
      if (silent.startedAt !== null) { silent.base = silentPosition(); silent.startedAt = now(); }
      silent.rate = value;
      arm();
    },
  };
}
