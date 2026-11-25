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
 * (site/editor/timesource.js `useVideo`) once it is ready.
 *
 * `notify(name)` is told 'play', 'pause', 'ended', 'seeked', 'durationchange' and 'ratechange';
 * `onError(kind)` gets 'embedDisabled', 'gone' or 'failed' after it is ready. `current()` says
 * whether this load is still wanted: one that was closed or replaced while it waited touches
 * nothing in the page and rejects with 'cancelled'. Rejects with 'blocked' or 'timeout' when the
 * API or the player does not come up in time, or with the error kind when the video fails first.
 */
export async function createYouTubePlayer(container, id, { start = 0, notify = () => {}, onError = () => {}, current = () => true, now = () => performance.now() / 1000, timeout = 15000 } = {}) {
  const YT = await loadYouTubeAPI({ timeout });
  if (!current()) throw new Error('cancelled');
  return new Promise((resolve, reject) => {
    // Its own holder, so taking this player away never takes anything else out of the container.
    const holder = document.createElement('div');
    const mount = document.createElement('div');
    holder.append(mount);
    container.replaceChildren(holder);
    let ready = false, gone = false, timer = null, length = 0;
    let sample = { time: start, at: now(), playing: false, rate: 1 };
    const expected = () => (sample.playing ? sample.time + (now() - sample.at) * sample.rate : sample.time);
    // The one place the player's state is read: every change is told once, whichever of the poll
    // and YouTube's own state event sees it first.
    const read = () => {
      if (gone) return;
      const time = player.getCurrentTime();
      if (!Number.isFinite(time)) return;
      const before = sample;
      const jumped = Math.abs(time - expected()) > 0.35;
      sample = { time, at: now(), playing: player.getPlayerState() === YT.PlayerState.PLAYING, rate: player.getPlaybackRate() || 1 };
      const total = player.getDuration();
      if (Number.isFinite(total) && total > 0 && total !== length) { length = total; notify('durationchange'); }
      if (sample.rate !== before.rate) notify('ratechange');
      // The visitor dragged YouTube's own progress bar.
      if (jumped) notify('seeked');
      if (sample.playing && !before.playing) notify('play');
      else if (!sample.playing && before.playing) notify('pause');
    };
    const source = {
      position: () => Math.min(expected(), length || Infinity),
      duration: () => length,
      get paused() { return !sample.playing; },
      get rate() { return sample.rate; },
      play: () => player.playVideo(),
      pause: () => player.pauseVideo(),
      seek: seconds => { player.seekTo(seconds, true); sample = { ...sample, time: seconds, at: now() }; notify('seeked'); },
      setRate: rate => { player.setPlaybackRate(rate); },
      destroy: () => {
        if (gone) return;
        gone = true;
        clearInterval(timer);
        clearTimeout(waiting);
        try { player.destroy(); } catch { /* already gone */ }
        holder.remove();
      },
    };
    const fail = reason => { source.destroy(); reject(new Error(reason)); };
    // The API being there does not mean the player will answer.
    const waiting = setTimeout(() => { if (!ready) fail('timeout'); }, timeout);
    const player = new YT.Player(mount, {
      width: '100%', height: '100%', videoId: id,
      playerVars: { playsinline: 1, rel: 0, origin: location.origin, ...(start > 0 ? { start: Math.floor(start) } : {}) },
      events: {
        onReady: () => {
          if (gone) return;
          clearTimeout(waiting);
          if (!current()) { fail('cancelled'); return; }
          ready = true;
          read();
          timer = setInterval(read, 250);
          resolve(source);
        },
        onStateChange: event => {
          if (!ready || gone) return;
          read();
          if (event.data === YT.PlayerState.ENDED) notify('ended');
        },
        onPlaybackRateChange: () => { if (ready) read(); },
        onError: event => {
          if (gone) return;
          const kind = youtubeErrorKind(event.data);
          if (!ready) fail(kind); else onError(kind);
        },
      },
    });
  });
}
