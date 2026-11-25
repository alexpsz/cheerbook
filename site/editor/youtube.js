// A YouTube video as the editor's time source (CheerBook C-016), through YouTube's own IFrame
// Player API and nothing else. Nothing here runs, and nothing is fetched from YouTube, until the
// visitor has pasted a link and chosen to load the video. The id is checked by lib/video.js before
// it gets here; this file never builds an address from what the visitor typed.
//
// The player reports its position only when asked, so the position is sampled a few times a second
// and carried forward on the page's clock in between: the cheer band moves smoothly and cannot drift.

const API_SRC = 'https://www.youtube.com/iframe_api';
let loading = null;

/** Loads the IFrame Player API once. Rejects with 'blocked' or 'timeout' when YouTube cannot be reached; a later call tries again. */
export function loadYouTubeAPI({ timeout = 15000 } = {}) {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = reason => { clearTimeout(timer); script.remove(); loading = null; reject(new Error(reason)); };
    const timer = setTimeout(() => fail('timeout'), timeout);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    script.src = API_SRC;
    script.addEventListener('error', () => fail('blocked'));
    document.head.append(script);
  });
  return loading;
}

/** What the player's error codes mean for the visitor (IFrame Player API, onError). */
export function youtubeErrorKind(code) {
  if (code === 101 || code === 150) return 'embedDisabled';
  if (code === 100) return 'gone';
  return 'failed';
}

/**
 * Puts a player for video `id` into `container` and resolves with a source for the transport
 * (site/editor/timesource.js `useVideo`) once it is ready. `notify(name)` is told 'play', 'pause',
 * 'ended' and 'seeked'; `onError(kind)` gets 'embedDisabled', 'gone' or 'failed' at any time.
 * Rejects when the API cannot be loaded, or the video fails before it is ready.
 */
export async function createYouTubePlayer(container, id, { start = 0, notify = () => {}, onError = () => {}, now = () => performance.now() / 1000 } = {}) {
  const YT = await loadYouTubeAPI();
  return new Promise((resolve, reject) => {
    const mount = document.createElement('div');
    container.replaceChildren(mount);
    let ready = false, timer = null;
    let sample = { time: start, at: now(), playing: false, rate: 1 };
    const expected = () => (sample.playing ? sample.time + (now() - sample.at) * sample.rate : sample.time);
    const read = () => {
      const time = player.getCurrentTime();
      if (!Number.isFinite(time)) return;
      const jumped = Math.abs(time - expected()) > 0.35;
      sample = { time, at: now(), playing: player.getPlayerState() === YT.PlayerState.PLAYING, rate: player.getPlaybackRate() || 1 };
      // The visitor dragged YouTube's own progress bar.
      if (jumped) notify('seeked');
    };
    const source = {
      position: () => Math.min(expected(), source.duration() || Infinity),
      duration: () => { const length = ready ? player.getDuration() : 0; return Number.isFinite(length) && length > 0 ? length : 0; },
      get paused() { return !sample.playing; },
      play: () => player.playVideo(),
      pause: () => player.pauseVideo(),
      seek: seconds => { player.seekTo(seconds, true); sample = { ...sample, time: seconds, at: now() }; notify('seeked'); },
      setRate: rate => { player.setPlaybackRate(rate); },
      destroy: () => { clearInterval(timer); try { player.destroy(); } catch { /* already gone */ } container.replaceChildren(); },
    };
    const player = new YT.Player(mount, {
      width: '100%', height: '100%', videoId: id,
      playerVars: { playsinline: 1, rel: 0, origin: location.origin, ...(start > 0 ? { start: Math.floor(start) } : {}) },
      events: {
        onReady: () => { ready = true; read(); timer = setInterval(read, 250); resolve(source); },
        onStateChange: event => {
          const was = sample.playing;
          read();
          if (event.data === YT.PlayerState.ENDED) { notify('pause'); notify('ended'); }
          else if (sample.playing && !was) notify('play');
          else if (!sample.playing && was) notify('pause');
        },
        onPlaybackRateChange: () => read(),
        onError: event => {
          const kind = youtubeErrorKind(event.data);
          if (!ready) { source.destroy(); reject(new Error(kind)); } else onError(kind);
        },
      },
    });
  });
}
