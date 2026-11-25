// CheerBook web editor: plays a local audio file, shows lyrics as a scroll, records cheers with
// hold-to-record sticks and keys, inserts built-in MIX, analyses the beat in a worker, suggests MIX
// for lyric gaps, and checks the file as it changes. The rules are the shared modules in lib/
// (bundled as /editor/lib.js); this file only wires them to the page. Audio and lyrics never leave
// the browser, except that "在线查找" sends the song's title, artist and length to lrclib.net.
import lib from '/editor/lib.js';
import { setupSubmission } from '/editor/submission.js';
import { h, clear, formatTime, formatClock, debounce, download, storage, typingTarget } from '/editor/dom.js';
import { createTransport } from '/editor/timesource.js';
import { createYouTubePlayer } from '/editor/youtube.js';

const { cheer, editor: E, suggest: S, lyrics: L, messages: M, paths: P, lyricsview: V, mixes: MX, video: VD } = lib;

const DRAFT_KEY = 'cheerbook.editor.draft.v1';
const REPO = 'https://github.com/alexpsz/cheerbook';
const BAND_LEAD = 5;
const $ = id => document.getElementById(id);
const root = $('editor');
const audio = new Audio();
audio.preload = 'auto';
// The time comes from the audio file when one is chosen, otherwise from a silent clock (C-016).
const transport = createTransport(audio);

const state = {
  ed: null,
  library: null,
  // Every artist MIX on the site (/mix/artists.json); the ones for this song come first in the MIX list.
  artistMixes: null,
  // The repository path of the community file this chart was opened from, so it can be edited in place.
  sourcePath: null,
  sourceSha256: null,
  audioURL: null,
  audioName: '',
  lyrics: null,
  lyricsText: '',
  grid: null,
  gridNote: '',
  // The last analysis of the loaded audio, to go back to after tapping or typing a grid.
  autoGrid: null,
  autoNote: '',
  // A grid typed in by hand, `{ bpm, anchor, audioName, duration }`: kept with the draft and used
  // again when an audio file of that name and length is chosen, since a grid is in that recording's time.
  manualGrid: null,
  gridDialogShown: null,
  member: null,
  selected: null,
  suggestions: null,
  choices: new Map(),
  dismissed: new Set(),
  issues: [],
  taps: null,
  held: new Map(),
  fresh: null,
  analysisRun: 0,
  worker: null,
  dirty: false,
  storageWarned: false,
  calibrating: false,
  lyricsLookup: null,
  // The length that came with lyrics picked from an online search, until those lyrics are applied.
  lyricsDuration: null,
  // Whether this cheer has been edited against real audio; a cheer made on the silent clock alone
  // is reminded to say so in its note. Unknown for a file opened from elsewhere (counts as true).
  heard: false,
  // The timeline row whose "add here" actions are open, as `kind:start`; and the row to give focus back to after a rebuild.
  adding: null,
  refocus: null,
  // Whether the taps being counted are timed on the wall clock (no playback) rather than on the song.
  wallTaps: false,
  // 'community' after "在网页中播放": a bar saying there is no sound, until audio is chosen or it is closed.
  notice: null,
  // A pasted video or a hand-synced one (C-016): `{ mode: 'youtube' | 'bilibili' | 'external' | 'failed', link, … }`.
  video: null,
  // The video used with this cheer last time, offered again but never loaded by itself.
  videoOffer: null,
  // Whether this cheer has been edited against a video that the page follows (YouTube).
  watched: false,
};
const DRAFT_BACKUP_KEY = 'cheerbook.editor.draft.backup.v1';
const DISPLAY_KEY = 'cheerbook.editor.display.v1';
state.display = (() => {
  const saved = storage.get(DISPLAY_KEY) || {};
  const display = { original: saved.original !== false, kana: saved.kana === true, romaji: saved.romaji === true };
  return display.original || display.kana || display.romaji ? display : { original: true, kana: false, romaji: false };
})();

// ---------------------------------------------------------------------------------------------
// Time: the source plays in playback time; a cheer file is in cheer time (playback + offset).

const position = () => transport.position();
const chart = () => state.ed.chart;
const cheerTime = pos => pos + (chart().offset || 0);
const playbackTime = time => time - (chart().offset || 0);
// With a video the song's own length comes first: the video usually runs on past the song.
const duration = () => (transport.kind === 'video' ? chart().song.duration || transport.duration() : transport.duration() || chart().song.duration || 0);
const hasAudio = () => transport.kind === 'audio';
const lyricLines = () => (state.lyrics && state.lyrics.lines.filter(line => Number.isFinite(line.start))) || [];
const lyricTexts = () => (state.lyrics ? state.lyrics.lines.map(line => line.text) : []);
const spans = () => (lyricLines().length ? S.spans(state.lyrics) : []);

function status(text, flash = false) {
  const node = $('status');
  node.textContent = text;
  node.classList.toggle('flash', flash);
}

// ---------------------------------------------------------------------------------------------
// Draft and editor lifecycle.

function newChart(song = {}) {
  const base = { title: song.title || '', artist: song.artist || '', duration: song.duration || 0 };
  return E.newChart(base, '');
}

function useChart(next, { compensation, quiet } = {}) {
  const keep = state.ed ? state.ed.compensation : E.DEFAULT_COMPENSATION;
  state.ed = new E.CheerEditor(next, { compensation: compensation ?? keep });
  if (state.member && !next.members.some(member => member.id === state.member)) state.member = null;
  state.selected = null;
  state.suggestions = null;
  state.choices.clear();
  state.dismissed.clear();
  syncSongFields();
  if (!quiet) changed({ save: false });
  else renderAll();
}

// The draft remembers whether it holds work not yet saved to a file (`dirty`), so opening another
// cheer can ask first even right after a reload; the previous draft is also kept as a backup.
const saveDraft = debounce(() => {
  if (!state.ed) return;
  const ok = storage.set(DRAFT_KEY, {
    chart: chart(), compensation: state.ed.compensation, lyricsText: state.lyricsText, dirty: state.dirty,
    audioName: state.audioName, heard: state.heard, watched: state.watched, member: state.member, sourcePath: state.sourcePath, sourceSha256: state.sourceSha256, grid: state.manualGrid, savedAt: new Date().toISOString(),
  });
  if (!ok && !state.storageWarned) {
    state.storageWarned = true;
    status('草稿没能保存在这个浏览器里（存储已满或被禁用）。请记得“保存到本机”。', true);
  }
}, 400);

/** After any change to the chart: re-check, re-render and remember the draft. */
function changed({ save = true, panel = true } = {}) {
  if (draftSnapshot && draftSnapshot !== chart()) resetDraftLink();
  if (save) state.dirty = true;
  if (save && hasAudio()) state.heard = true;
  if (save && transport.kind === 'video') state.watched = true;
  syncSource();
  check();
  renderAll({ panel });
  if (save) saveDraft();
}

/** Work that would be lost by replacing the chart: unsaved changes to a chart with cheers. */
const hasWorkToLose = () => state.dirty && chart().events.length > 0;

function backUpDraft() {
  const current = storage.get(DRAFT_KEY);
  if (current) storage.set(DRAFT_BACKUP_KEY, current);
}

function markExported() {
  state.dirty = false;
  state.ed.markSaved();
  saveDraft();
}

function commit(next, coalescing) {
  if (!next) return;
  state.ed.apply(next, coalescing);
  changed();
}

// ---------------------------------------------------------------------------------------------
// Live check: the same reader the community checks use, plus the lyric check (spec §10).

const check = debounce(() => {
  const result = E.validateChart(chart(), { sharing: false });
  const issues = result.valid ? result.warnings.slice() : result.errors.slice();
  if (state.lyrics && lyricLines().length) {
    for (const found of L.lyricIssues(chart(), lyricTexts())) if (found.code === 'lyricOverlap') issues.push(found);
  }
  state.issues = issues.map(found => ({ ...found, error: !M.isWarning(found) }));
  renderIssues();
}, 120);

function eventIndexOf(path) {
  const match = /^events\[(\d+)\]/.exec(path || '');
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------------------------
// Audio: local file only, played through a blob: URL; the beat is analysed in a worker.

function pickAudio() { $('audio-file').click(); }

async function loadAudio(file) {
  if (!file) return;
  closeVideo({ quiet: true });
  if (state.audioURL) URL.revokeObjectURL(state.audioURL);
  state.audioURL = URL.createObjectURL(file);
  state.audioName = file.name;
  audio.src = state.audioURL;
  status(`已载入“${file.name}”，正在读取时长与节拍…`);
  const meta = await new Promise(resolve => {
    const done = () => { audio.removeEventListener('loadedmetadata', done); audio.removeEventListener('error', fail); resolve(true); };
    const fail = () => { audio.removeEventListener('loadedmetadata', done); audio.removeEventListener('error', fail); resolve(false); };
    audio.addEventListener('loadedmetadata', done);
    audio.addEventListener('error', fail);
  });
  if (!meta) {
    status('这个文件无法在浏览器里播放。请换成 MP3、AAC / M4A、FLAC、WAV 或 Ogg 文件。', true);
    // The element now points at a file it cannot play, whatever it played before.
    dropAudio({ quiet: true });
    return;
  }
  transport.useAudio();
  transport.setRate(Number($('rate').value) || 1);
  const song = chart().song;
  const guess = guessSong(file.name);
  const edits = {};
  if (!song.title && guess.title) edits.title = guess.title;
  if (!song.artist && guess.artist) edits.artist = guess.artist;
  let mismatch = '';
  if (!song.duration || !chart().events.length) edits.duration = Math.round(audio.duration * 1000) / 1000;
  else if (!cheer.matchSong({ title: 'x', artist: 'x', duration: song.duration }, { title: 'x', artist: 'x', duration: audio.duration })) {
    mismatch = `注意：这份应援按 ${formatClock(song.duration)} 长的录音打轴，这个音频是 ${formatClock(audio.duration)}，可能不是同一个版本。`;
  }
  if (Object.keys(edits).length) updateSong(edits, 'song');
  if (mismatch) status(mismatch, true);
  syncSource();
  renderAll();
  analyseBeat(file);
}

/** "Artist - Title.mp3" → both; otherwise the file name is the title. */
function guessSong(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, '').trim();
  const parts = base.split(/\s+[-–—]\s+/);
  return parts.length === 2 ? { artist: parts[0].trim(), title: parts[1].trim() } : { title: base };
}

// ---------------------------------------------------------------------------------------------
// A pasted video (C-016). YouTube is followed through its own player API; Bilibili can only be
// shown, so the cheers run on the silent clock, started by hand when the song starts ("手动对时"),
// as they do for a video playing anywhere else. Nothing is fetched from either until the visitor
// has pasted a link and chosen "加载视频"; the link and the start are kept in this browser only.

const VIDEOS_KEY = 'cheerbook.editor.videos.v1';
const manual = () => (state.video && (state.video.mode === 'bilibili' || state.video.mode === 'external') ? state.video : null);
const platformName = link => (link.platform === 'youtube' ? 'YouTube' : 'Bilibili');
/** What a remembered video is kept under: the community file, or the song when it has a name. */
function chartKey() {
  const song = chart().song;
  return state.sourcePath || (song.title && song.artist ? [song.artist, song.title, Math.round(song.duration || 0)].join('\n') : null);
}

function rememberVideo() {
  const key = chartKey(), video = state.video;
  if (!key || !video || !video.link || video.mode === 'failed') return;
  const saved = storage.get(VIDEOS_KEY);
  const all = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  all[key] = { link: video.link, offset: video.mode === 'youtube' ? transport.videoOffset : 0, marked: video.marked === true, start: video.start ?? null, at: Date.now() };
  storage.set(VIDEOS_KEY, Object.fromEntries(Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 20)));
}

/** After a cheer is opened: the video used with it last time is offered, never loaded by itself. */
function offerVideo() {
  const key = chartKey();
  const all = storage.get(VIDEOS_KEY);
  const saved = key && all && typeof all === 'object' ? all[key] : null;
  // What was stored is checked again as if it had just been pasted.
  const link = saved && saved.link && VD.videoWatchURL(saved.link) ? saved.link : null;
  state.videoOffer = link && !state.video ? {
    link, marked: saved.marked === true,
    offset: Number.isFinite(saved.offset) && saved.offset > 0 ? saved.offset : 0,
    start: Number.isInteger(saved.start) && saved.start > 0 ? saved.start : null,
  } : null;
  renderVideoOffer();
}

function renderVideoOffer() {
  const offer = state.videoOffer;
  $('video-offer').hidden = !offer;
  if (offer) $('video-offer-text').textContent = `上次用的是一个 ${platformName(offer.link)} 视频。为保护隐私，没有自动加载；点“加载视频”后会连接 ${platformName(offer.link)}。`;
}

function openVideoDialog() {
  $('video-link').value = '';
  $('video-start').value = '';
  renderVideoDialog();
  $('video-dialog').showModal();
  $('video-link').focus();
}

/** Reads the pasted link and says what it is; returns it when it is one this page can load. */
function renderVideoDialog() {
  const text = $('video-link').value.trim();
  const found = text ? VD.parseVideoLink(text) : null;
  const ok = !!found && found.ok;
  const bilibili = ok && found.platform === 'bilibili';
  $('video-load').disabled = !ok;
  $('video-consent-youtube').hidden = !(ok && found.platform === 'youtube');
  $('video-consent-bilibili').hidden = !bilibili;
  $('video-start-row').hidden = !bilibili;
  $('video-start-note').hidden = !bilibili;
  if (!bilibili) $('video-start').value = '';
  else if (!$('video-start').value && found.start) $('video-start').value = formatClock(found.start);
  $('video-recognized').textContent = !text ? ''
    : ok ? (bilibili ? '已识别：Bilibili 视频（页面读不到播放进度，加载后用“开始 / 微调”手动对时）。' : '已识别：YouTube 视频（页面会自动跟随视频进度）。')
      : found.reason === 'shortLink' ? '这是短链，页面认不出它指向哪个视频。请先在浏览器打开视频，再复制地址栏的完整链接。'
        : '认不出这个链接。目前只支持 YouTube 和 Bilibili 的链接，不支持 b23.tv 这类短链——请先在浏览器打开视频，再复制地址栏的完整链接。其他来源请点下方“改用手动对时”。';
  return ok ? found : null;
}

function loadFromDialog() {
  const link = renderVideoDialog();
  if (!link) return;
  let start = null;
  if (link.platform === 'bilibili' && $('video-start').value.trim()) {
    const seconds = E.parseDuration($('video-start').value);
    if (seconds === null) { $('video-recognized').textContent = '歌曲起点请按 分:秒 填写，例如 1:23；不填就从头加载。'; return; }
    start = Math.floor(seconds);
  }
  $('video-dialog').close('load');
  loadVideo(link, { start });
}

/**
 * Loads the video of a link that lib/video.js has read (never a string the visitor typed).
 * `start` is where Bilibili's player should open; `offset` and `marked` restore a YouTube start.
 */
async function loadVideo(link, { start = null, offset = null, marked = false } = {}) {
  closeVideo({ quiet: true });
  state.videoOffer = null;
  renderVideoOffer();
  if (hasAudio()) dropAudio({ quiet: true });
  if (link.platform === 'bilibili') {
    const src = VD.bilibiliEmbedURL(link, start === null ? {} : { start });
    if (!src) return;
    // The frame may run its player and open Bilibili in a new tab, but can never navigate this page away.
    clear($('video-frame')).append(h('iframe', {
      src, title: 'Bilibili 视频', allow: 'fullscreen; encrypted-media; picture-in-picture', allowfullscreen: true,
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation',
    }));
    state.video = { mode: 'bilibili', link, start, phase: 'standby', nudge: 0 };
    rememberVideo();
    syncSource();
    renderVideo();
    status(transport.ready ? '已加载 Bilibili 视频。在视频里播放，歌一响就点“开始”。' : '已加载 Bilibili 视频。先在上方填写歌曲时长，才能对时。', true);
    return;
  }
  const video = { mode: 'youtube', link, loading: true, marked: false };
  state.video = video;
  renderVideo();
  try {
    const from = offset ?? link.start ?? 0;
    const player = await createYouTubePlayer($('video-frame'), link.id, {
      start: from, notify: name => transport.notify(name),
      onError: kind => { if (state.video === video) videoFailed(video, kind); },
    });
    // Closed, or another one chosen, while this one was loading.
    if (state.video !== video) { player.destroy(); return; }
    video.player = player;
    video.loading = false;
    video.marked = marked || from > 0;
    transport.useVideo(player, from);
    transport.setRate(Number($('rate').value) || 1);
    // A cheer with no length yet takes the rest of the video, until "歌到这里结束" says better.
    if (!chart().song.duration && transport.duration() > 0) updateSong({ duration: Math.min(7200, Math.round(transport.duration() * 1000) / 1000) }, 'song');
    rememberVideo();
    syncSource();
    renderVideo();
    frame(true);
    status(video.marked ? `已加载 YouTube 视频，歌曲起点在视频的 ${formatTime(from)}。` : '已加载 YouTube 视频。把视频播到这首歌开始的地方，点“歌从这里开始”。', true);
  } catch (error) {
    if (state.video === video) videoFailed(video, error && error.message);
  }
}

function videoFailed(video, kind) {
  if (transport.kind === 'video') transport.useSilent(chart().song.duration || 0);
  if (video.player) video.player.destroy();
  clear($('video-frame'));
  state.video = { mode: 'failed', link: video.link, failure: kind };
  syncSource();
  renderVideo();
  frame(true);
}

/** "外部播放 · 手动对时": the video or the song plays somewhere else; the cheers are started by hand. */
function startExternal() {
  closeVideo({ quiet: true });
  if (hasAudio()) dropAudio({ quiet: true });
  state.video = { mode: 'external', link: null, phase: 'standby', nudge: 0 };
  syncSource();
  renderVideo();
  status(transport.ready ? '在别处播放这首歌，歌一响就点“开始”。' : '先在上方填写歌曲时长，才能对时。', true);
}

function closeVideo({ quiet = false } = {}) {
  const video = state.video;
  if (!video) return;
  // The silent clock takes over from where the video was, so it is asked before the player goes.
  if (transport.kind === 'video') transport.useSilent(chart().song.duration || 0);
  if (video.player) video.player.destroy();
  clear($('video-frame'));
  state.video = null;
  $('rate').disabled = false;
  syncSource();
  renderVideo();
  frame(true);
  if (!quiet) status('已关闭。现在是无声计时：页面自己计时，没有声音。', true);
}

function manualStart() {
  const hand = manual();
  if (!hand) return;
  if (!transport.ready) { status('还不知道这首歌多长：先在上方填“时长”，或在“歌词…”里在线查找。', true); return; }
  hand.phase = 'running';
  hand.nudge = 0;
  transport.seek(0);
  transport.play();
  syncSource();
  renderVideo();
}

/** 提前 / 推后: the cheers come that much sooner or later from here on; the running total stays in view. */
function manualNudge(delta) {
  const hand = manual();
  if (!hand || hand.phase !== 'running') return;
  hand.nudge = Math.round((hand.nudge + delta) * 10) / 10;
  seek(position() + delta);
  renderVideo();
}

function manualReset() {
  const hand = manual();
  if (!hand) return;
  hand.phase = 'standby';
  hand.nudge = 0;
  hand.ended = false;
  transport.pause();
  transport.seek(0);
  syncSource();
  renderVideo();
  frame(true);
}

/** YouTube: the song starts where the video is now; from then on the editor's time is the song's. */
function markStart() {
  const video = state.video;
  if (!video || transport.kind !== 'video') return;
  const at = Math.round(transport.videoPosition() * 10) / 10;
  video.marked = true;
  transport.setVideoOffset(at);
  afterOffset();
  status(`歌曲起点设在视频的 ${formatTime(at)}。不准的话用“提前 / 推后 0.1 秒”微调。`, true);
}
function nudgeStart(delta) {
  if (transport.kind !== 'video') return;
  transport.setVideoOffset(Math.max(0, Math.round((transport.videoOffset + delta) * 10) / 10));
  afterOffset();
}
function unmarkStart() {
  const video = state.video;
  if (!video || transport.kind !== 'video') return;
  video.marked = false;
  transport.setVideoOffset(0);
  afterOffset();
}
function afterOffset() {
  rememberVideo();
  syncSource();
  renderVideo();
  frame(true);
}
/** YouTube, while making a cheer: the song ends where the video is now. */
function markEnd() {
  if (transport.kind !== 'video') return;
  const seconds = Math.round(position() * 1000) / 1000;
  if (seconds < 10) { status('离歌曲起点太近了：先标记歌曲起点，再把视频播到歌结束的地方。', true); return; }
  if (seconds > 7200) { status('歌曲最长 2 小时。', true); return; }
  updateSong({ duration: seconds }, 'song:duration');
  const from = transport.videoOffset;
  status(`已将歌曲时长设为 ${formatClock(seconds)}（视频 ${formatTime(from)}–${formatTime(from + seconds)}）。`, true);
}

const VIDEO_FAILURES = {
  embedDisabled: '上传者禁止在其他网站播放这个视频。可以换一个视频，或在原网站打开它，再在这里用“手动对时”。',
  gone: '这个视频不存在，或者已被删除、设为不公开。可以换一个视频。',
};

function renderVideo() {
  const video = state.video;
  $('video-panel').hidden = !video;
  root.dataset.video = video && (video.mode === 'youtube' || video.mode === 'bilibili') ? 'frame' : 'none';
  if (!video) return;
  const youtube = video.mode === 'youtube' && !video.loading, failed = video.mode === 'failed', hand = manual();
  $('video-mark').hidden = !youtube;
  $('video-manual').hidden = !hand;
  $('video-manual-note').hidden = video.mode !== 'bilibili';
  $('video-open').hidden = !video.link;
  if (video.link) $('video-open').href = VD.videoWatchURL(video.link);
  for (const id of ['video-change', 'video-retry', 'video-to-external']) $(id).hidden = !failed;
  $('video-close').textContent = video.mode === 'external' ? '结束手动对时' : '关闭视频';
  $('video-status').textContent = failed ? VIDEO_FAILURES[video.failure] || `连不上 ${platformName(video.link)}，视频没能加载。可以重试、换其他来源，或改用无声计时。`
    : video.loading ? '正在连接 YouTube…'
      : youtube ? 'YouTube 视频：应援跟着视频走。在视频上播放、暂停、拖动都可以。'
        : hand.phase === 'standby' ? (video.mode === 'bilibili' ? '视频里歌一响，就点“开始”' : '歌一响，就点“开始”')
          : video.ended ? '本首应援已结束' : transport.paused ? '已暂停' : '正在跟着计时。对不上时用“提前 / 推后 0.1 秒”。';
  if (youtube) {
    for (const id of ['video-mark-hint', 'video-mark-start']) $(id).hidden = video.marked;
    for (const id of ['video-mark-at', 'video-mark-earlier', 'video-mark-later', 'video-mark-again']) $(id).hidden = !video.marked;
    $('video-mark-at').textContent = `歌曲起点 ${formatTime(transport.videoOffset)}`;
    $('video-mark-end').hidden = false;
  }
  if (hand) {
    const running = hand.phase === 'running';
    for (const id of ['manual-earlier', 'manual-later', 'manual-reset']) $(id).disabled = !running;
    $('manual-nudge').textContent = hand.nudge > 0.049 ? `已提前 ${hand.nudge.toFixed(1)} 秒` : hand.nudge < -0.049 ? `已推后 ${(-hand.nudge).toFixed(1)} 秒` : '';
    // The page cannot slow a video it does not control, so the clock keeps to 1×.
    if ($('rate').value !== '1') { $('rate').value = '1'; transport.setRate(1); }
  }
  $('rate').disabled = !!hand;
  syncPlayLabel();
}

/** Leaves the audio file for the silent clock ("切回无声"), or clears a file that would not load. */
function dropAudio({ quiet = false } = {}) {
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  state.analysisRun++;
  // The clock takes over from where the audio was, so it is asked before the file is let go.
  transport.useSilent(chart().song.duration || 0);
  if (state.audioURL) URL.revokeObjectURL(state.audioURL);
  state.audioURL = null;
  state.audioName = '';
  state.autoGrid = null;
  audio.removeAttribute('src');
  audio.load();
  // A beat already found stays (it is this song's); an analysis cut short is no longer "正在分析…".
  const kept = state.grid;
  setGrid(kept, !kept ? '' : kept.source === 'beatMap' ? `节拍：${Math.round(kept.bpm)} BPM · 自动分析` : handNote(kept));
  state.taps = null;
  syncTapButton();
  syncSource();
  frame(true);
  if (!quiet) status('已切回无声计时：页面自己计时，没有声音。', true);
}

// Without an audio file the silent clock plays the song's own length, so a cheer with a length can
// be played at once. The controls follow whichever source is in use.
let sourceKey = '';
function syncSource() {
  if (!state.ed) return;
  if (!hasAudio() && transport.kind !== 'video') {
    const length = chart().song.duration || 0;
    if (transport.kind !== 'silent' || transport.duration() !== length) transport.useSilent(length);
  }
  const ready = transport.ready;
  const video = state.video;
  const key = [transport.kind, ready, duration(), state.notice, !!state.lyrics, video && video.mode, video && video.phase].join(':');
  if (key === sourceKey) return;
  sourceKey = key;
  for (const id of ['play', 'seek']) $(id).disabled = !ready;
  $('seek').max = String(duration());
  $('grid-set').hidden = !ready;
  $('source').hidden = !ready;
  $('source').textContent = hasAudio() ? '本地音频' : transport.kind === 'video' ? 'YouTube'
    : video && video.mode === 'bilibili' ? 'Bilibili · 手动对时' : video && video.mode === 'external' ? '外部播放 · 手动对时' : '无声计时';
  $('source-silent').hidden = !hasAudio();
  $('song-duration').readOnly = hasAudio();
  $('notice').hidden = !(state.notice && !hasAudio() && !video && ready);
  syncPlayLabel();
  root.dataset.ready = String(ready || !!state.lyrics);
  // A tempo typed or tapped for the silent clock comes back with the draft, as one for a file does.
  if (!hasAudio() && ready && !state.grid && typedForThisAudio()) {
    const typed = S.gridFromBPM(state.manualGrid.bpm, state.manualGrid.anchor, duration());
    if (typed) setGrid(typed, handNote(typed));
  }
}

function setMode(watching) {
  dropHeld('已取消正在记录的这一下。');
  root.dataset.mode = watching ? 'watch' : 'edit';
  $('toggle-mode').setAttribute('aria-pressed', String(watching));
  $('toggle-mode').textContent = watching ? '回到编辑' : '观看模式';
  state.adding = null;
  if (watching && state.selected !== null) { state.selected = null; renderSelected(); }
  // Its switch is not shown while watching, so it does not keep ticking there.
  if (watching && click.on) { click.enable(false); $('metronome').checked = false; }
  renderTimeline();
}

// 节拍提示音: a tick on each beat of the grid while the clock runs, so a tempo typed or tapped
// without audio can be checked by ear. It is synthesised here; nothing is loaded.
const click = {
  on: false, context: null, next: null, pending: [],
  /** Forgets where it was and silences the ticks already handed over (a seek, a pause, a new rate or grid). */
  reset() {
    this.next = null;
    const now = this.context ? this.context.currentTime : 0;
    for (const { osc, when } of this.pending) if (when > now) { try { osc.stop(); } catch { /* already stopped */ } }
    this.pending = [];
  },
  enable(on) {
    this.on = on;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (on && !this.context && Context) this.context = new Context();
    if (on && this.context && this.context.state === 'suspended') this.context.resume();
    this.reset();
  },
  tick(pos) {
    const grid = state.grid, context = this.context;
    if (!this.on || !context || !grid || transport.paused) return;
    const rate = Number($('rate').value) || 1;
    // Beats in the next 0.15 s of real time are handed to the audio clock, which keeps them even.
    const horizon = pos + 0.15 * rate;
    let index = this.next ?? Math.ceil((pos - grid.anchor) / grid.beat - 1e-6);
    for (; grid.anchor + index * grid.beat <= horizon; index++) {
      const at = grid.anchor + index * grid.beat;
      if (at < pos - 0.02) continue;
      const when = context.currentTime + Math.max(0, (at - pos) / rate);
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.frequency.value = ((index % 4) + 4) % 4 === 0 ? 1320 : 880;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.25, when + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
      osc.connect(gain).connect(context.destination);
      osc.start(when);
      osc.stop(when + 0.08);
      this.pending.push({ osc, when });
    }
    if (this.pending.length > 16) this.pending = this.pending.filter(tick => tick.when > context.currentTime - 0.1);
    this.next = index;
  },
};

async function analyseBeat(file) {
  const run = ++state.analysisRun;
  state.autoGrid = null;
  // Called once the metadata is in, so the length is known.
  const typed = typedForThisAudio() ? S.gridFromBPM(state.manualGrid.bpm, state.manualGrid.anchor, duration()) : null;
  const kept = typed || (state.grid && state.grid.source === 'taps' ? state.grid : null);
  setGrid(kept, kept ? handNote(kept, '（正在分析…）') : '节拍：正在分析…');
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  try {
    const bytes = await file.arrayBuffer();
    const buffer = await decodeForAnalysis(bytes);
    if (run !== state.analysisRun) return;
    const channels = [];
    for (let i = 0; i < Math.min(2, buffer.numberOfChannels); i++) channels.push(new Float32Array(buffer.getChannelData(i)));
    const worker = new Worker('/editor/analysis-worker.js', { type: 'module' });
    state.worker = worker;
    let reply;
    try {
      reply = await new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message || '分析线程出错'));
        worker.postMessage({ channels, sampleRate: buffer.sampleRate }, channels.map(channel => channel.buffer));
      });
    } finally {
      worker.terminate();
      if (state.worker === worker) state.worker = null;
    }
    if (run !== state.analysisRun) return;
    if (!reply.ok) throw new Error(reply.message);
    const found = reply.result;
    if (found) {
      const level = found.confidence >= 0.66 ? '高' : found.confidence >= 0.4 ? '中' : '低';
      state.autoGrid = S.makeGrid(found.beat, found.anchor, 'beatMap');
      state.autoNote = `节拍：${Math.round(found.bpm)} BPM · 自动分析（把握${level}）`;
    }
    // A grid tapped or typed in by hand stays over the analysis.
    const hand = handMade(state.grid);
    if (hand) {
      setGrid(hand, handNote(hand, found ? `（自动分析为 ${Math.round(found.bpm)} BPM）` : ''));
      status(`已载入音频，按${hand.source === 'manual' ? '手动设置' : '跟拍'}的 ${bpmText(hand)} BPM 对齐。`);
      return;
    }
    if (!found) { setGrid(null, '节拍：没找到稳定的节拍，可以跟拍 8 下，或点“BPM 与起拍偏移…”直接填写。'); status('已载入音频。没找到稳定的节拍：MIX 会插到当前位置，推荐只标出空位。', true); return; }
    const doubtful = found.confidence < 0.4 || (found.downbeatConfidence ?? 1) < 0.5;
    setGrid(state.autoGrid, state.autoNote);
    status(`已载入音频，节拍 ${Math.round(found.bpm)} BPM。${lyricLines().length ? '可以边听边点了。' : '可以加载歌词，然后边听边点。'}`);
    if (doubtful) status('自动分析的节拍把握不大：播放时看节拍点是否跟上鼓点，不对可以用 ×2、÷2、移一拍调整，跟拍 8 下，或点“BPM 与起拍偏移…”直接填写。', true);
  } catch (error) {
    if (run !== state.analysisRun) return;
    const hand = handMade(state.grid);
    setGrid(hand, hand ? handNote(hand, `（自动分析失败：${error.message}）`) : '节拍：分析失败（' + error.message + '），可以跟拍 8 下，或点“BPM 与起拍偏移…”直接填写。');
  }
}

/**
 * Decodes the file at the analysis rate (11025 Hz) where the browser allows it, which needs a
 * fraction of the memory of full-rate audio; otherwise at the browser's own rate. Any context
 * opened is closed again, whatever happens.
 */
async function decodeForAnalysis(bytes) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  for (const rate of [11025, 22050]) {
    try { return await new Offline(1, 1, rate).decodeAudioData(bytes.slice(0)); } catch { /* try the next rate */ }
  }
  const Context = window.AudioContext || window.webkitAudioContext;
  const context = new Context();
  try { return await context.decodeAudioData(bytes.slice(0)); } finally { context.close(); }
}

/** A grid's tempo as shown: whole BPM, or up to two decimals for one typed in by hand. */
const bpmText = grid => String(grid.source === 'manual' ? Math.round(grid.bpm * 100) / 100 : Math.round(grid.bpm));
/** The grid when it was tapped or typed in rather than analysed, else null. */
const handMade = grid => (grid && grid.source !== 'beatMap' ? grid : null);
/** The grid status for a tapped or typed-in grid, with an optional note on the analysis. */
const handNote = (grid, extra = '') => `节拍：${bpmText(grid)} BPM · ${grid.source === 'manual' ? '手动设置' : '跟拍'}${extra}`;

function setGrid(grid, note) {
  state.grid = grid;
  state.gridNote = note;
  $('grid-status').textContent = note;
  for (const id of ['grid-double', 'grid-half', 'grid-shift']) $(id).hidden = !grid;
  $('mix-hint').textContent = grid ? '点一下插入到当前位置，对齐到下一拍。' : '点一下插入到当前位置。';
  $('metronome').disabled = !grid;
  $('metronome-row').title = grid ? '按当前 BPM 打拍，只有嘀嘀声，不是歌。' : '设置或跟拍估出 BPM 后可开启（只有嘀嘀声）。';
  if (!grid && click.on) { click.enable(false); $('metronome').checked = false; }
  click.reset();
  state.suggestions = null;
  $('suggest').textContent = '✦ 推荐';
  // The analysis can finish while the beat dialog is open.
  if ($('grid-dialog').open) syncGridRestore();
  renderTimeline();
}

// ---------------------------------------------------------------------------------------------
// Playback controls and the frame loop.

/** Manual corrections for the usual estimator slips: double / half tempo, bar line a beat off. */
function adjustGrid(kind) {
  const grid = state.grid;
  if (!grid) return;
  const beat = kind === 'double' ? grid.beat / 2 : kind === 'half' ? grid.beat * 2 : grid.beat;
  if (60 / beat < S.GRID_BPM.min || 60 / beat > S.GRID_BPM.max) return;
  const anchor = kind === 'shift' ? grid.anchor + grid.beat : grid.anchor;
  const next = S.makeGrid(beat, anchor, grid.source);
  if (next.source === 'manual') rememberManualGrid(next);
  setGrid(next, `节拍：${bpmText(next)} BPM · 已手动调整`);
  status(kind === 'shift' ? '小节线已移后一拍。' : `已改为 ${bpmText(next)} BPM。`, true);
}

// Tempo and first bar line typed in by hand, for when the analysis and the taps both miss: a
// recording whose first beat is not at 0:00, or a tempo the estimator halves or doubles.

/** Whether the remembered typed grid is for the loaded audio: same file name and length. */
const typedForThisAudio = () => !!state.manualGrid && state.manualGrid.audioName === state.audioName && Math.abs(state.manualGrid.duration - duration()) <= 0.5;
const audioKnown = () => duration() > 0;
/** One of the grid's bar lines inside the recording: its own, or else the first after 0:00 (after many "移一拍"). */
const barLineInside = grid => (grid.anchor >= 0 && grid.anchor <= duration() ? grid.anchor : Math.max(0, S.barLine(grid, 0)));

/** Remembers (or with null forgets) the typed grid for the loaded audio, with the draft. */
function rememberManualGrid(grid) {
  state.manualGrid = grid ? { bpm: grid.bpm, anchor: barLineInside(grid), audioName: state.audioName, duration: duration() } : null;
  saveDraft();
}

function syncGridRestore() {
  $('grid-auto').hidden = !state.autoGrid || state.grid === state.autoGrid;
}

function openGridDialog() {
  if (!audioKnown()) { status('先填写歌曲时长或选择本地音频，再设置 BPM 与起拍偏移。', true); return; }
  const grid = state.grid;
  $('grid-bpm').value = grid ? String(Math.round(grid.bpm * 100) / 100) : '';
  $('grid-anchor').value = String(Math.round((grid ? barLineInside(grid) : 0) * 1000) / 1000);
  $('grid-anchor').max = String(Math.floor(duration() * 1000) / 1000);
  // What the fields opened with: applying them unchanged leaves the grid (and its source) alone.
  state.gridDialogShown = { grid, bpm: $('grid-bpm').value, anchor: $('grid-anchor').value };
  syncGridRestore();
  $('grid-dialog').returnValue = '';
  $('grid-dialog').showModal();
}

/** The current position for the first bar line; a click while playing lands late, as taps do. */
function gridAnchorHere() {
  const at = position() - (transport.paused ? 0 : state.ed.compensation);
  $('grid-anchor').value = String(Math.round(Math.max(0, at) * 1000) / 1000);
}

function applyGridDialog() {
  const shown = state.gridDialogShown;
  if (shown && shown.grid && shown.grid === state.grid && $('grid-bpm').value === shown.bpm && $('grid-anchor').value === shown.anchor) return;
  if (!audioKnown()) return;
  const grid = S.gridFromBPM(Number($('grid-bpm').value), Number($('grid-anchor').value), duration());
  if (!grid) { status(`没能设置节拍：节拍速度要在 ${S.GRID_BPM.min}–${S.GRID_BPM.max} BPM 之间，起拍偏移在 0 到歌曲长度之间。`, true); return; }
  rememberManualGrid(grid);
  setGrid(grid, handNote(grid));
  status(`节拍已设为 ${bpmText(grid)} BPM，${grid.anchor.toFixed(3)} 秒处是一个小节的第一拍。播放时看节拍点是否跟上鼓点。`, true);
}

function restoreAutoGrid() {
  if (!state.autoGrid) return;
  if (typedForThisAudio()) rememberManualGrid(null);
  setGrid(state.autoGrid, state.autoNote);
  $('grid-dialog').close('cancel');
  status('已恢复自动分析的节拍。', true);
}

/** The play button says what it will do; with a YouTube video it names YouTube, whose player it drives. */
function syncPlayLabel() {
  const hand = manual();
  const youtube = transport.kind === 'video';
  $('play').textContent = !transport.paused ? (youtube ? '暂停 YouTube' : '暂停')
    : hand ? (hand.phase === 'standby' ? '开始' : '继续') : youtube ? '播放 YouTube' : '播放';
}

function togglePlay() {
  const hand = manual();
  if (hand && hand.phase === 'standby') { manualStart(); return; }
  if (!transport.ready) { status('还不知道这首歌多长：在上方填“时长”，在“歌词…”里在线查找，或选择本地音频。', true); return; }
  if (transport.paused) transport.play().catch(() => status('浏览器没有允许播放，请再点一次播放。', true));
  else transport.pause();
}

function seek(to) {
  if (!transport.ready) return;
  follow.manualAt = -Infinity;
  transport.seek(Math.min(Math.max(0, to), duration()));
  frame(true);
}

// One animation loop at most, running only while the audio plays; everything else draws a single
// frame with `frame()`.
let rafId = 0;
function loop() {
  rafId = 0;
  frame();
  if (!transport.paused) rafId = requestAnimationFrame(loop);
}
function startLoop() { if (!rafId && !transport.paused) rafId = requestAnimationFrame(loop); }

function frame(force = false, { reposition = true } = {}) {
  const pos = position();
  $('clock').textContent = `${formatTime(pos)} / ${formatClock(duration())}`;
  if (!$('seek').matches(':active')) $('seek').value = String(pos);
  renderBand(pos);
  renderBeatDot(pos);
  click.tick(pos);
  syncFocus(pos, { force, reposition });
  updateFill(pos);
  if (state.held.size) renderHeldTags(pos);
}

transport.on('play', () => { if (state.video) state.video.ended = false; syncPlayLabel(); renderVideo(); click.reset(); frame(true); startLoop(); });
transport.on('pause', () => { syncPlayLabel(); renderVideo(); click.reset(); frame(true); });
transport.on('ended', () => { if (state.video) state.video.ended = true; syncPlayLabel(); renderVideo(); });
transport.on('seeked', () => { click.reset(); frame(true); });

/** A dot that lights on each beat (brighter on bar lines), to check the grid by ear and eye. */
function renderBeatDot(pos) {
  const dot = $('beat-dot');
  const grid = state.grid;
  if (!grid || transport.paused) { dot.dataset.on = 'off'; return; }
  const sinceBeat = ((pos - grid.anchor) % grid.beat + grid.beat) % grid.beat;
  const beatIndex = Math.round((pos - grid.anchor - sinceBeat) / grid.beat);
  dot.dataset.on = sinceBeat < 0.12 ? (((beatIndex % 4) + 4) % 4 === 0 ? 'bar' : 'beat') : 'off';
}

// ---------------------------------------------------------------------------------------------
// Recording: sticks and keys. Hold to record a span; a short press takes the default length.

// Keys are matched by physical position (`event.code`), so Shift, the keyboard layout or a
// number pad never leave a hold without its release.
function stickKeys() {
  const keys = chart().members.slice(0, 9).map((member, i) => ({ key: { member: member.id }, codes: [`Digit${i + 1}`, `Numpad${i + 1}`], label: member.name, hint: String(i + 1), color: member.color, id: 'member:' + member.id }));
  keys.push({ key: 'mix', codes: ['KeyM'], hint: 'M', label: 'MIX', id: 'mix' }, { key: 'call', codes: ['KeyC'], hint: 'C', label: 'Call', id: 'call' }, { key: 'note', codes: ['KeyN'], hint: 'N', label: '提示', id: 'note' });
  return keys;
}

function press(stick, via = { pointer: true }) {
  if (root.dataset.mode === 'watch' || state.held.has(stick.id)) return;
  if (!transport.ready) { status('先填写歌曲时长或选择本地音频，再打点。', true); return; }
  const pos = position();
  // The clock is not running (no audio, or paused): nothing to hold against, so the cheer goes
  // down at this very position with its default length, and no reaction time is taken off.
  if (transport.paused) { placeAt(stick.key === 'mix' || stick.key === 'call' || stick.key === 'note' ? stick.key : 'part', pos, NaN, { member: stick.key.member }); return; }
  state.ed.press(stick.key, pos);
  state.held.set(stick.id, { stick, start: pos, code: via.code || null });
  const button = document.querySelector(`[data-stick="${CSS.escape(stick.id)}"]`);
  if (button) button.classList.add('down');
  status(`正在记录 · ${stick.label}`, true);
  renderHeldTags(pos);
}

function release(stick) {
  const held = state.held.get(stick.id);
  if (!held) return;
  state.held.delete(stick.id);
  const button = document.querySelector(`[data-stick="${CSS.escape(stick.id)}"]`);
  if (button) button.classList.remove('down');
  const index = state.ed.release(stick.key, position());
  if (index === null || index === undefined) { status('这一下太短或不在歌曲范围内，没有记录。', true); changed({ save: false }); return; }
  state.selected = index;
  state.fresh = index;
  const event = chart().events[index];
  status(`已记录 ${describe(event)} · ${formatTime(playbackTime(event.start))}–${formatTime(playbackTime(event.end))}`, true);
  changed();
}

/** Puts a cheer down at a position rather than by holding a key: from a lyric row, or with the clock stopped. */
function placeAt(kind, start, end, { member = null, echo = false } = {}) {
  if (kind === 'part') {
    if (!chart().members.length) { status('请先在右侧“成员”栏添加成员，再标记演唱段落。', true); return; }
    member = member || state.member || chart().members[0].id;
  } else if (kind === 'mix') member = state.member;
  else member = null;
  const index = state.ed.place(kind, start, end, { member, echo });
  if (index === null || index === undefined) { status('这里放不下：不在歌曲范围内。', true); return; }
  state.selected = index;
  state.fresh = index;
  state.adding = null;
  const event = chart().events[index];
  const fill = event.kind === 'part' || event.echo ? '' : '在“这一条”里填写内容。';
  status(`已添加 ${describe(event)} · ${formatTime(playbackTime(event.start))}。${fill}`, true);
  changed();
}

/** What can be put on a lyric line or on a stretch nobody sings, without playing through it. */
function rowActions(row) {
  const start = row.start, end = row.end;
  const act = (label, run) => h('button', { type: 'button', onclick: event => { event.stopPropagation(); run(); } }, label);
  if (row.kind === 'line') return [
    act('标演唱', () => placeAt('part', start, end)),
    act('标跟唱', () => placeAt('call', start, end, { echo: true })),
    act('句前 Call', () => placeAt('call', Math.max(0, start - 1), start)),
    act('句后 Call', () => placeAt('call', end, end + 1)),
    act('加提示', () => placeAt('note', start, start + 1)),
  ];
  return [
    act('插入 MIX…', () => {
      state.adding = null;
      seek(start);
      renderTimeline();
      $('mix-title').scrollIntoView({ block: 'nearest' });
      status('已定位到这段空位：在“MIX”栏点一条插入。', true);
    }),
    act('加 Call', () => placeAt('call', start, start + 1)),
    act('加提示', () => placeAt('note', start, start + 1)),
  ];
}

/** Drops every hold without recording it (Escape, or the window losing focus mid-hold). */
function dropHeld(reason) {
  if (!state.held.size) return;
  state.ed.cancelRecordings();
  for (const node of document.querySelectorAll('.stick.down')) node.classList.remove('down');
  for (const node of document.querySelectorAll('.tag.recording')) node.remove();
  state.held.clear();
  status(reason, true);
}

function describe(event) {
  if (event.kind === 'part') return '演唱 · ' + memberNames(event.members).join('・');
  return E.eventTitle(event, chart(), state.library);
}

function memberNames(ids = []) {
  const byId = new Map(chart().members.map(member => [member.id, member.name]));
  return ids.map(id => byId.get(id) || id);
}

function memberColor(ids = []) {
  const member = chart().members.find(item => item.id === ids[0]);
  return member ? E.legibleColor(member.color, matchMedia('(prefers-contrast: more)').matches) : null;
}

// ---------------------------------------------------------------------------------------------
// Timeline: lyric lines in order, each with the cheers that start during it; cheers before the
// first line or between lines get a gap row of their own.

function buildRows() {
  const lines = lyricLines();
  const events = chart().events.map((event, index) => ({ event, index, at: playbackTime(event.start) }));
  const ghosts = suggestionGhosts();
  const rows = [];
  if (!lines.length) {
    for (const item of events.sort((a, b) => a.at - b.at)) rows.push({ kind: 'event', start: item.at, events: [item], ghosts: [] });
    for (const ghost of ghosts) rows.push({ kind: 'event', start: ghost.at, events: [], ghosts: [ghost] });
    return rows.sort((a, b) => a.start - b.start);
  }
  const lineEnd = i => (Number.isFinite(lines[i].end) ? lines[i].end : i + 1 < lines.length ? lines[i + 1].start : duration());
  // Cheers tapped on a line's first word often land a little before it (reaction compensation),
  // so a line takes events from up to 0.3 s ahead of its start.
  const place = at => {
    if (at < lines[0].start - 0.3) return { gapBefore: 0 };
    for (let i = lines.length - 1; i >= 0; i--) {
      if (at >= lines[i].start - 0.3) return at <= lineEnd(i) + 0.05 || i === lines.length - 1 && !Number.isFinite(lines[i].end) ? { line: i } : { gapBefore: i + 1 };
    }
    return { gapBefore: 0 };
  };
  const lineRows = lines.map((line, i) => ({ kind: 'line', line, lineIndex: i, start: line.start, end: lineEnd(i), events: [], ghosts: [] }));
  const gapRows = new Map();
  const gapRow = before => {
    if (!gapRows.has(before)) {
      const start = before === 0 ? 0 : lineEnd(before - 1);
      gapRows.set(before, { kind: 'gap', before, start, end: before < lines.length ? lines[before].start : duration(), events: [], ghosts: [] });
    }
    return gapRows.get(before);
  };
  for (const item of events) {
    const where = place(item.at);
    (where.line !== undefined ? lineRows[where.line] : gapRow(where.gapBefore)).events.push(item);
  }
  for (const ghost of ghosts) {
    const where = place(ghost.at);
    (where.line !== undefined ? lineRows[where.line] : gapRow(where.gapBefore)).ghosts.push(ghost);
  }
  // While editing, a stretch nobody sings has a row even when it is empty, so a cheer can be put there.
  if (root.dataset.mode !== 'watch') {
    for (const gap of S.gaps(state.lyrics, duration(), state.grid)) {
      const next = lines.findIndex(line => line.start >= gap.end - 0.05);
      const row = gapRow(next === -1 ? lines.length : next);
      // A row that already holds cheers keeps its own times; the first stretch names an empty one.
      if (row.events.length || row.ghosts.length || row.named) continue;
      row.named = true;
      row.start = gap.start;
      row.end = gap.end;
    }
  }
  for (const [before, row] of gapRows) lineRows.splice(lineRows.findIndex(r => r.kind === 'line' && r.lineIndex === before) === -1 ? lineRows.length : lineRows.findIndex(r => r.kind === 'line' && r.lineIndex === before), 0, row);
  for (const row of lineRows) row.events.sort((a, b) => a.at - b.at);
  return lineRows;
}

let rows = [];
function renderTimeline() {
  if (!state.ed) return;
  const list = $('timeline');
  // A rebuild after an edit keeps the list where it was; only the song moves it.
  const box = lyricsBox();
  const keep = box ? box.scrollTop : 0;
  clear(list);
  rows = buildRows();
  $('timeline-empty').hidden = rows.length > 0;
  const watching = root.dataset.mode === 'watch';
  root.dataset.lyrics = lyricLines().length ? 'timed' : 'none';
  $('watch-note').hidden = !(watching && !lyricLines().length && rows.length > 0);
  const singers = singersByLine();
  rows.forEach((row, i) => {
    const tags = h('div', { class: 'tags' },
      row.events.map(item => eventTag(item)),
      row.ghosts.map(ghost => ghostTag(ghost)));
    const addKey = `${row.kind}:${row.start}`;
    const canAdd = !watching && row.kind !== 'event' && transport.ready;
    const open = canAdd && state.adding === addKey;
    const actions = open ? h('div', { class: 'row-actions', role: 'group', 'aria-label': '在这里添加' }, rowActions(row)) : null;
    const body = row.kind === 'line'
      ? h('div', { class: 'body' }, lineText(row.line), tags, actions)
      : h('div', { class: 'body' }, row.kind === 'gap' ? h('div', { class: 'text' }, gapLabel(row)) : null, tags, actions);
    const add = canAdd ? h('button', { type: 'button', class: 'row-add', 'aria-expanded': String(open), 'aria-label': '在这里添加应援', title: '在这里添加',
      onclick: event => { event.stopPropagation(); state.adding = open ? null : addKey; state.refocus = addKey; renderTimeline(); } }, '＋') : null;
    const bars = h('span', { class: 'singers', 'aria-hidden': 'true' },
      (row.kind === 'line' ? singers.get(row.lineIndex) || [] : []).map(color => h('i', { style: { '--member': color } })));
    const label = row.kind === 'line' ? `${formatTime(row.start)} ${row.line.text}` : gapLabel(row);
    list.append(h('li', { class: `row ${row.kind}`, dataset: { row: String(i) }, tabindex: '-1', 'aria-label': label,
      onclick: event => { if (!event.target.closest('.tag, .row-actions, .row-add')) { follow.manualAt = -Infinity; seek(row.start); } } },
    h('span', { class: 'time' }, formatTime(row.start)), bars, body, add));
  });
  if (box) box.scrollTop = keep;
  // The list was rebuilt under a keyboard user: focus goes back to the row's add button or its first action.
  if (state.refocus) {
    const at = rows.findIndex(row => `${row.kind}:${row.start}` === state.refocus);
    const node = at >= 0 ? list.querySelector(`[data-row="${at}"]`) : null;
    const target = node && (node.querySelector('.row-actions button') || node.querySelector('.row-add'));
    if (target) target.focus({ preventScroll: true });
    state.refocus = null;
  }
  follow.focus = null;
  frame(true, { reposition: false });
  if (state.fresh !== null) {
    const node = list.querySelector(`[data-event="${state.fresh}"]`);
    if (node) node.classList.add('fresh');
    state.fresh = null;
  }
}

function lineText(line) {
  return h('div', { class: 'text' }, h('span', { class: 'ink' }, line.text));
}

function gapLabel(row) {
  const length = Math.max(0, row.end - row.start);
  const name = row.before === 0 ? '前奏' : row.before >= lyricLines().length ? '尾奏' : '间奏';
  return `${name} · ${Math.round(length)} 秒`;
}

/** Colours of the members singing over most of each line, from the `part` events. */
function singersByLine() {
  const map = new Map();
  const lines = lyricLines();
  if (!lines.length) return map;
  const parts = chart().events.filter(event => event.kind === 'part');
  lines.forEach((line, i) => {
    const end = Number.isFinite(line.end) ? line.end : i + 1 < lines.length ? lines[i + 1].start : line.start + 4;
    let best = null, overlap = 0;
    for (const part of parts) {
      const o = Math.min(end, playbackTime(part.end)) - Math.max(line.start, playbackTime(part.start));
      if (o > overlap) { overlap = o; best = part; }
    }
    if (best) map.set(i, (best.members || []).map(id => memberColor([id])).filter(Boolean));
  });
  return map;
}

function eventTag({ event, index }) {
  const color = memberColor(event.members);
  const kind = { mix: 'MIX', call: event.echo ? '跟唱' : 'CALL', part: '演唱', note: '提示' }[event.kind] || event.kind;
  const text = event.kind === 'part' ? memberNames(event.members).join('・') : event.echo ? '跟唱这一句' : describe(event);
  return h('button', { type: 'button', class: 'tag', dataset: { event: String(index) }, 'aria-pressed': state.selected === index ? 'true' : 'false',
    style: color ? { '--member': color } : undefined,
    'aria-label': `${kind} ${text}，${formatTime(playbackTime(event.start))} 到 ${formatTime(playbackTime(event.end))}`,
    onclick: () => select(index), ondblclick: () => seek(playbackTime(event.start)) },
  h('span', { class: 'kind' }, kind), h('span', {}, text), h('span', { class: 'when' }, formatTime(playbackTime(event.start))));
}

function renderHeldTags(pos) {
  for (const node of document.querySelectorAll('.tag.recording')) node.remove();
  const row = $('timeline').querySelector(`[data-row="${rowAt(pos)}"] .tags`) || $('timeline');
  for (const { stick, start } of state.held.values()) {
    row.append(h('span', { class: 'tag recording', style: stick.color ? { '--member': stick.color } : undefined },
      h('span', { class: 'kind' }, '正在记录'), stick.label, h('span', { class: 'when' }, `${formatTime(start)}–${formatTime(pos)}`)));
  }
}

// ---------------------------------------------------------------------------------------------
// The lyric list, as Liveglow's 歌词 view (lib/lyricsview.js): it moves to the next row 0.3 s
// early, the focus row sits at 30% of the list, rows below follow as a wave on a no-bounce spring,
// every lyric is a dim ink and the sung part fills to full ink — word by word with word timing,
// otherwise a smooth sweep. A manual scroll holds the list for 4 s. Reduce Motion: no movement,
// the whole line lights at once.

const follow = { focus: null, manualAt: -Infinity, fill: null };
const SPRING = (() => {
  const spring = V.springEasing();
  const supported = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 1)');
  return supported ? spring : { easing: 'cubic-bezier(0.22, 1, 0.36, 1)', duration: spring.duration };
})();
const lyricsBox = () => document.querySelector('.ed-lyrics');
const graphemes = text => (typeof Intl !== 'undefined' && Intl.Segmenter
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment)
  : [...text]);

/** The row a time falls in, without the lead (for recording marks). */
function rowAt(pos) {
  let found = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i].start <= pos + 0.02) found = i;
  return found;
}

function syncFocus(pos, { force = false, reposition = true } = {}) {
  const focus = V.focusIndex(rows.map(row => row.start), pos);
  if (!force && focus === follow.focus) return;
  const previous = follow.focus;
  follow.focus = focus;
  const list = $('timeline');
  for (const node of list.querySelectorAll('.row.focus')) node.classList.remove('focus');
  if (previous !== null && previous !== focus) settleFill(previous);
  const node = focus >= 0 ? list.querySelector(`[data-row="${focus}"]`) : null;
  if (node) node.classList.add('focus');
  prepareFill(focus);
  if (!reposition) return;
  const now = performance.now() / 1000;
  if (!V.resumesFollowing(follow.manualAt, now)) return;
  list.classList.remove('browsing');
  const box = lyricsBox();
  if (!box) return;
  const target = node ? V.anchorScroll(node.offsetTop, box.clientHeight) : 0;
  // A rebuild or a long jump re-anchors at once; a line change while playing moves on the spring.
  const animated = !force && !reducedMotion() && !transport.paused && Math.abs(target - box.scrollTop) < box.clientHeight * 2;
  moveList(box, target, focus, animated);
}

/** Scrolls to `target` and, when animated, lets each nearby row travel from where it was. */
function moveList(box, target, focus, animated) {
  const before = box.scrollTop;
  if (Math.abs(target - before) < 1) return;
  box.scrollTop = target;
  const delta = box.scrollTop - before;
  if (!animated || !delta) return;
  const top = box.scrollTop - box.clientHeight, bottom = box.scrollTop + box.clientHeight * 2;
  for (const node of $('timeline').children) {
    if (node.offsetTop < top || node.offsetTop > bottom) continue;
    // Interrupt a running move where it is, so a quick second change never jumps.
    let carry = 0;
    for (const running of node.getAnimations()) {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      carry = matrix.m42;
      running.cancel();
      break;
    }
    const index = Number(node.dataset.row);
    node.animate([{ transform: `translateY(${delta + carry}px)` }, { transform: 'translateY(0)' }],
      { duration: SPRING.duration, easing: SPRING.easing, delay: V.staggerDelay(index, focus) * 1000, fill: 'backwards' });
  }
}

/** Splits the focus lyric into characters and measures them, once per focus change. */
function prepareFill(index) {
  follow.fill = null;
  const row = rows[index];
  const node = index >= 0 ? $('timeline').querySelector(`[data-row="${index}"] .text`) : null;
  if (!row || row.kind !== 'line' || !node) return;
  const chars = graphemes(row.line.text);
  clear(node);
  const spans = chars.map(c => h('span', { class: 'ch' }, c));
  node.append(...spans);
  const widths = spans.map(span => span.getBoundingClientRect().width);
  // Wrapped rows count in reading order: a character's position is its offset along the text.
  const along = []; let sum = 0;
  for (const width of widths) { along.push(sum); sum += width; }
  let words = null;
  if (row.line.words && row.line.words.length) {
    let at = 0;
    words = row.line.words.map((word, i) => {
      const count = graphemes(word.text).length;
      const next = row.line.words[i + 1];
      const range = { start: word.start, end: Number.isFinite(word.end) ? word.end : next ? next.start : row.end, from: at, to: at + count };
      at += count;
      return range;
    });
    if (at !== chars.length) words = null;
  }
  const lines = lyricLines();
  const lineSweep = words ? null : V.sweep(lines, row.lineIndex, duration());
  const fontSize = parseFloat(getComputedStyle(node).fontSize) || 16;
  follow.fill = { index, spans, along, widths, words, lineSweep, feather: fontSize * 0.9, last: [] };
}

/** Sets each character's ink for the current time; only changed values touch the page. */
function updateFill(pos) {
  const fill = follow.fill;
  if (!fill) return;
  if (reducedMotion()) {
    const on = pos >= rows[fill.index].start - 0.02 ? 1 : 0;
    for (let i = 0; i < fill.spans.length; i++) if (fill.last[i] !== on) { fill.last[i] = on; fill.spans[i].style.setProperty('--b', String(on)); }
    return;
  }
  const lit = V.litWidth(fill.widths, pos, { words: fill.words, lineSweep: fill.lineSweep });
  for (let i = 0; i < fill.spans.length; i++) {
    const b = Math.round(V.brightness(fill.along[i], lit, fill.feather) * 50) / 50;
    if (fill.last[i] !== b) { fill.last[i] = b; fill.spans[i].style.setProperty('--b', String(b)); }
  }
}

/** The line just sung eases back to the dim ink. */
function settleFill(index) {
  const node = $('timeline').querySelector(`[data-row="${index}"] .text`);
  if (!node) return;
  node.classList.add('settling');
  for (const span of node.querySelectorAll('.ch')) span.style.setProperty('--b', '0');
}

/** A manual scroll of the list holds it where the listener left it for a while. */
function noteManualScroll() {
  follow.manualAt = performance.now() / 1000;
  $('timeline').classList.add('browsing');
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------------------------
// The band: what a listener sees at this moment, as the app shows it during playback.

let bandKey = '';
const increasedContrast = () => matchMedia('(prefers-contrast: more)').matches;
function renderBand(pos) {
  const band = $('band');
  if (!state.ed) return;
  const view = E.bandItems(chart(), cheerTime(pos), { lead: BAND_LEAD, library: state.library, lyrics: state.lyrics, increasedContrast: increasedContrast() });
  // Rebuilt only when what it shows changes, not on every frame.
  const key = JSON.stringify([view, transport.ready, state.display]);
  if (key === bandKey) return;
  bandKey = key;
  clear(band);
  if (view.singers && view.singers.length) {
    band.append(h('span', { class: 'item singing', style: { '--member': view.singers[0].color } },
      h('span', { class: 'kind meta' }, '演唱'), view.singers.map(singer => singer.name).join('・')));
  }
  const show = state.display;
  for (const item of view.current || []) {
    const color = item.singers && item.singers[0] ? item.singers[0].color : null;
    const words = item.words && item.words.length ? item.words : [item.text];
    const columns = words.map((word, i) => V.rubyColumn(word, item.kana?.[i], item.romaji?.[i], show));
    band.append(h('span', { class: 'item', style: color ? { '--member': color } : undefined },
      h('span', { class: 'kind meta' }, item.label),
      columns.map((column, i) => h('span', { class: i === item.activeWord ? 'w on' : i < item.activeWord ? 'w past' : 'w' },
        h('span', { class: 'orig', lang: !show.original && !show.kana && item.romaji?.[i] ? 'ja-Latn' : 'ja' },
          column.segments.map(segment => segment.ruby
            ? h('ruby', {}, segment.base, h('rt', {}, segment.ruby))
            : segment.base)),
        column.romaji ? h('span', { class: 'romaji', lang: 'ja-Latn' }, column.romaji) : null))));
  }
  if (view.upcoming) {
    band.append(h('span', { class: 'next' }, '下一条：', view.upcoming.title || view.upcoming.text || ''),
      view.countdown !== null ? h('span', { class: 'count' }, view.imminent ? String(view.countdown) : `${view.countdown} 秒后`) : null);
  }
  if (!band.childNodes.length) band.append(h('span', { class: 'idle' }, transport.ready ? '这里会显示正在进行的应援和下一条。' : '填写时长或选择本地音频后开始。'));
}

// ---------------------------------------------------------------------------------------------
// Selection and the side panel's editor for one cheer.

function select(index) {
  // Watching changes nothing: a cheer's tag only jumps to it.
  if (root.dataset.mode === 'watch') { const event = chart().events[index]; if (event) seek(playbackTime(event.start)); return; }
  state.selected = index === state.selected ? null : index;
  renderTimeline();
  renderSelected();
}

// The panel is rebuilt only when the selection or the event's shape changes; typing into its
// text fields updates the chart without replacing them (so input methods and focus survive), and
// after a rebuild focus returns to the control that had it.
function renderSelected() {
  const panel = $('selected-panel');
  const box = $('selected-editor');
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  clear(box);
  const event = state.selected !== null ? chart().events[state.selected] : null;
  panel.hidden = !event;
  if (!event) return;
  const index = state.selected;
  const update = (patch, { coalescing = null, keepPanel = false } = {}) => {
    const next = { ...chart().events[index], ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key];
    state.ed.edit(draft => { draft.events[index] = next; }, coalescing);
    changed({ panel: !keepPanel });
  };
  const typed = (field, transform = value => value) => ({
    oninput: e => { if (!e.isComposing) update({ [field]: transform(e.target.value) }, { coalescing: `${field}:${index}`, keepPanel: true }); },
    oncompositionend: e => update({ [field]: transform(e.target.value) }, { coalescing: `${field}:${index}`, keepPanel: true }),
  });
  const kinds = [['mix', 'MIX'], ['call', 'Call'], ['note', '提示'], ['part', '演唱段落']];
  const kindSelect = h('select', { id: 'sel-kind', dataset: { focus: 'kind' }, onchange: e => {
    const kind = e.target.value;
    const patch = { kind };
    if (kind === 'part') { patch.text = undefined; patch.echo = undefined; patch.mixRef = undefined; patch.name = undefined; patch.steps = undefined; patch.readings = undefined; if (!(event.members || []).length && chart().members[0]) patch.members = [chart().members[0].id]; }
    else if (!event.text && !(kind === 'call' && event.echo)) patch.text = kind === 'note' ? '举灯' : '';
    if (kind !== 'mix') patch.mixRef = undefined;
    if (kind !== 'call') patch.echo = undefined;
    update(patch);
  } }, kinds.map(([value, label]) => h('option', { value, selected: event.kind === value }, label)));
  const textField = event.kind === 'part' ? null : h('label', { class: 'ed-field block' }, h('span', {}, event.kind === 'mix' ? '口号（{name} 代表成员名字）' : '文字'),
    h('textarea', { rows: '2', dataset: { focus: 'text' }, disabled: event.kind === 'call' && event.echo, ...typed('text') }, event.text || ''));
  const echo = event.kind === 'call' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { focus: 'echo' }, checked: !!event.echo,
    onchange: e => update(e.target.checked ? { echo: true, text: undefined, steps: undefined, readings: undefined } : { echo: undefined, text: '' }) }), '跟唱这一句（不写文字，播放时显示歌词）') : null;
  const name = event.kind === 'mix' || event.kind === 'call' ? h('label', { class: 'ed-field' }, h('span', {}, '名称（可选，显示在“下一条”）'),
    h('input', { maxlength: '32', dataset: { focus: 'name' }, value: event.name || '', ...typed('name', value => value || undefined) })) : null;
  const picks = h('div', { class: 'member-picks', role: 'group', 'aria-label': '成员' }, chart().members.map(member => h('label', {},
    h('input', { type: 'checkbox', dataset: { focus: 'member:' + member.id }, checked: (event.members || []).includes(member.id), onchange: e => {
      const set = new Set(chart().events[index].members || []);
      if (e.target.checked) set.add(member.id); else set.delete(member.id);
      const ordered = chart().members.map(m => m.id).filter(id => set.has(id));
      update({ members: ordered.length ? ordered : undefined });
    } }), h('span', { class: 'swatch', style: { '--member': member.color } }), member.name)));
  // Times here are playback times, as on the timeline; the file stores them plus the offset.
  const time = (field, label) => h('span', { class: 'nudge' }, h('span', { class: 'meta' }, label),
    h('button', { type: 'button', dataset: { focus: field + ':-' }, 'aria-label': `${label}提前 0.05 秒`, onclick: () => { state.ed.nudge(index, { [field]: -0.05 }); changed(); } }, '−'),
    h('input', { type: 'number', step: '0.05', min: '0', dataset: { focus: field }, value: String(Math.round(playbackTime(event[field]) * 1000) / 1000), 'aria-label': `${label}（秒）`, style: { width: '6.5em' },
      onchange: e => { const value = Number(e.target.value); if (Number.isFinite(value)) update({ [field]: Math.round((value + (chart().offset || 0)) * 1000) / 1000 }); } }),
    h('button', { type: 'button', dataset: { focus: field + ':+' }, 'aria-label': `${label}推后 0.05 秒`, onclick: () => { state.ed.nudge(index, { [field]: 0.05 }); changed(); } }, '+'));
  box.append(h('div', { class: 'selected-grid' },
    h('div', { class: 'row2' }, h('label', { class: 'ed-field' }, h('span', {}, '种类'), kindSelect), name),
    textField, echo, chart().members.length ? picks : h('p', { class: 'meta' }, '还没有成员，可以在下方添加。'),
    h('div', { class: 'row2' }, time('start', '开始'), time('end', '结束')),
    h('div', { class: 'row2' },
      h('button', { type: 'button', dataset: { focus: 'play' }, onclick: () => seek(playbackTime(event.start) - 1) }, '从这里前 1 秒播放'),
      (event.kind === 'mix' || event.kind === 'call') && event.text ? h('button', { type: 'button', dataset: { focus: 'steps' }, onclick: () => commit(S.redistributeSteps(chart(), index, state.grid, spans())) }, state.grid ? '逐词对齐到拍子' : '逐词均分') : null,
      h('button', { type: 'button', class: 'danger', onclick: () => { state.ed.removeEvent(index); state.selected = null; status('已删除这一条（可以撤销）。', true); changed(); } }, '删除'))));
  if (focused) { const again = box.querySelector(`[data-focus="${CSS.escape(focused)}"]`); if (again) again.focus(); }
}

// ---------------------------------------------------------------------------------------------
// Members, MIX library and sticks.

function renderMembers() {
  const list = clear($('members'));
  chart().members.forEach((member, i) => {
    list.append(h('li', { 'aria-current': state.member === member.id ? 'true' : 'false' },
      h('span', { class: 'swatch', style: { '--member': member.color } }),
      h('button', { type: 'button', class: 'name', 'aria-pressed': state.member === member.id ? 'true' : 'false', title: '设为当前成员（MIX 的 {name} 用这位）',
        onclick: () => { state.member = state.member === member.id ? null : member.id; saveDraft(); renderMembers(); } }, member.name),
      i < 9 ? h('span', { class: 'key' }, String(i + 1)) : null,
      h('input', { type: 'color', value: member.color.toLowerCase(), 'aria-label': `${member.name}的应援色`, onchange: e => {
        const color = e.target.value.toUpperCase();
        state.ed.edit(draft => { const target = draft.members.find(m => m.id === member.id); if (target) target.color = color; });
        changed();
      } }),
      h('button', { type: 'button', 'aria-label': `删除成员${member.name}`, onclick: () => {
        if (!confirm(`删除成员“${member.name}”？她的演唱段落也会一起删除。`)) return;
        state.ed.removeMember(member.id);
        if (state.member === member.id) state.member = null;
        changed();
      } }, '×')));
  });
}

/** The artist MIX for the song being edited (lib/mixes.js), song-specific ones first; remembered per title and artist. */
let artistCache = { key: null, entries: [] };
function artistEntries() {
  const song = chart().song;
  const key = JSON.stringify([song.title || '', song.artist || '', state.artistMixes ? state.artistMixes.length : -1]);
  if (artistCache.key !== key) artistCache = { key, entries: MX.artistEntries(state.artistMixes, song) };
  return artistCache.entries;
}

// Rebuilt only when what it lists changes, so a focused MIX button is not replaced by the edit it
// just made.
let libraryKey = '';
function renderLibrary() {
  const artist = state.ed ? artistEntries() : [];
  const key = JSON.stringify([state.library ? S.libraryEntries(state.library).length : null, state.artistMixes ? state.artistMixes.length : null, artist.map(entry => entry.path)]);
  const artistName = state.ed ? cheer.trimmed(chart().song.artist || '') : '';
  $('mix-contribute').href = '/editor/mix/?type=artist' + (artistName ? '&artist=' + encodeURIComponent(artistName) : '');
  $('mix-contribute').textContent = artistName ? `投稿 ${artistName} 的专属 MIX` : '投稿艺人专属 MIX';
  if (key === libraryKey) return;
  libraryKey = key;
  const list = clear($('mix-library'));
  if (!state.library) { list.append(h('li', { class: 'meta' }, '正在读取 MIX 库…')); return; }
  const entries = S.libraryEntries(state.library);
  if (!entries.length && !artist.length) { list.append(h('li', { class: 'meta' }, '没能读取 MIX 库，刷新页面再试。')); return; }
  const item = entry => {
    const bars = entry.bars[0] === entry.bars[1] ? entry.bars[0] : `${entry.bars[0]}–${entry.bars[1]}`;
    const scope = entry.scope === 'artist' ? (entry.match === 'song' ? ' · 这首歌专属' : ' · 艺人专属') : '';
    return h('li', {}, h('button', { type: 'button', onclick: () => insertMix(entry), title: entry.text },
      h('span', { class: 'mix-name', lang: entry.scope === 'artist' ? undefined : 'ja' }, entry.name),
      h('span', { class: 'mix-meta' }, `${entry.kind === 'call' ? 'Call' : 'MIX'} · 约 ${bars} 小节${entry.text.includes('{name}') ? ' · 有名字空位' : ''}${scope}`)));
  };
  if (artist.length) {
    list.append(h('li', { class: 'mix-group' }, `${[...new Set(artist.map(entry => entry.artist))].join('、')} 专属`));
    for (const entry of artist) list.append(item(entry));
    list.append(h('li', { class: 'mix-group' }, '通用 MIX'));
  }
  for (const entry of entries) list.append(item(entry));
}

function insertMix(entry) {
  if (!transport.ready) { status('先填写歌曲时长或选择本地音频，MIX 会插入到当前位置。', true); return; }
  const member = state.member || (entry.text.includes('{name}') && chart().members[0] ? chart().members[0].id : null);
  const result = S.insertMix(chart(), entry, position(), state.grid, member, { spans: spans() });
  if (!result || result.index === null || result.index === undefined) { status('这里放不下这条 MIX（会超出歌曲或与别的 MIX 重叠），换个位置再试。', true); return; }
  state.ed.apply(result.chart);
  state.selected = result.index;
  state.fresh = result.index;
  const event = chart().events[result.index];
  status(`已插入 ${entry.name} · ${formatTime(playbackTime(event.start))}${state.grid ? '（对齐到拍子）' : ''}`, true);
  changed();
}

// Rebuilt only when the members change and nothing is held, so a focused or pressed stick is never
// replaced under the finger.
let sticksKey = '';
function renderSticks() {
  const key = JSON.stringify(stickKeys().map(stick => [stick.id, stick.label, stick.color]));
  if (key === sticksKey || state.held.size) return;
  sticksKey = key;
  const box = clear($('sticks'));
  for (const stick of stickKeys()) {
    const button = h('button', { type: 'button', class: 'stick', dataset: { stick: stick.id }, style: stick.color ? { '--member': stick.color } : undefined,
      'aria-keyshortcuts': stick.hint, 'aria-label': `${stick.label}，按住记录，快捷键 ${stick.hint}` },
    h('span', {}, stick.label), h('span', { class: 'k' }, stick.hint));
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      press(stick);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, event => { if (event.isPrimary) releaseIfPointer(stick); });
    button.addEventListener('keydown', event => {
      if ((event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') && !event.repeat) { event.preventDefault(); event.stopPropagation(); press(stick, { code: event.code }); }
    });
    box.append(button);
  }
}

function releaseIfPointer(stick) {
  const held = state.held.get(stick.id);
  if (held && !held.code) release(stick);
}

// ---------------------------------------------------------------------------------------------
// Suggestions: dashed ghosts in the timeline; only a click adopts one.

function computeSuggestions() {
  if (!lyricLines().length) { status('智能推荐要用到带时间的歌词：先在“歌词…”里加载 LRC。', true); return; }
  if (!duration()) { status('先填写歌曲时长或选择本地音频。', true); return; }
  state.suggestions = S.suggestions(state.lyrics, duration(), state.grid, chart(), state.library, { extra: artistEntries() });
  state.dismissed.clear();
  state.choices.clear();
  const count = state.suggestions.length;
  status(count ? `找到 ${count} 个可以喊 MIX 的空位，虚线标出；点“采纳”才会写进去。${state.grid ? '' : '没有节拍信息，只标出空位和秒数。'}` : '没找到合适的空位。', true);
  $('suggest').textContent = count ? `✦ 推荐 ${count}` : '✦ 推荐';
  renderTimeline();
}

function suggestionGhosts() {
  if (!state.suggestions) return [];
  return state.suggestions.filter(item => !state.dismissed.has(item.id)).map(item => ({ suggestion: item, at: item.gap.start }));
}

function ghostTag({ suggestion }) {
  const choice = state.choices.get(suggestion.id) || 0;
  const options = suggestion.candidates || [];
  const names = options.length ? options[choice % options.length].map(entry => entry.name).join(' + ') : '';
  return h('span', { class: 'tag ghost', role: 'group', 'aria-label': `推荐：${suggestion.summary}` },
    h('span', { class: 'kind' }, '推荐'),
    h('span', {}, `${suggestion.gap.title}${suggestion.gap.bars ? ` ${suggestion.gap.bars} 小节` : ` ${Math.round(suggestion.gap.end - suggestion.gap.start)} 秒`}${names ? ' · ' + names : ''}`),
    h('span', { class: 'when' }, suggestion.confidenceTitle || ''),
    options.length ? h('button', { type: 'button', onclick: () => {
      const next = S.acceptSuggestion(chart(), suggestion, choice % options.length, state.grid, state.member, { spans: spans() });
      state.dismissed.add(suggestion.id);
      commit(next);
      status(`已采纳：${names}（可以撤销）`, true);
    } }, '采纳') : null,
    options.length > 1 ? h('button', { type: 'button', onclick: () => { state.choices.set(suggestion.id, choice + 1); renderTimeline(); } }, '换一个') : null,
    h('button', { type: 'button', onclick: () => { state.dismissed.add(suggestion.id); renderTimeline(); } }, '忽略'));
}

// ---------------------------------------------------------------------------------------------
// Issues panel.

let issuesSummary = '';
function renderIssues() {
  const list = clear($('issues'));
  const errors = state.issues.filter(found => found.error).length;
  const summary = errors ? `还有 ${errors} 个问题要改` : state.issues.length ? `格式通过，有 ${state.issues.length} 条提醒` : '格式检查通过';
  if (summary !== issuesSummary) { issuesSummary = summary; $('issues-summary').textContent = summary; }
  if (!state.issues.length) { list.append(h('li', { class: 'ok' }, '格式检查通过。')); return; }
  for (const found of state.issues) {
    const index = eventIndexOf(found.path);
    list.append(h('li', { class: found.error ? 'error' : 'warning' }, M.issueMessage(found),
      index !== null && chart().events[index] ? h('button', { type: 'button', onclick: () => { state.selected = index; renderTimeline(); renderSelected(); } }, '查看') : null));
  }
}

// ---------------------------------------------------------------------------------------------
// Song fields.

function syncSongFields() {
  const song = chart().song;
  for (const [id, key] of [['song-title', 'title'], ['song-artist', 'artist'], ['song-album', 'album'], ['song-isrc', 'isrc'], ['song-amid', 'appleMusicID']]) {
    if (document.activeElement !== $(id)) $(id).value = song[key] || '';
  }
  if (document.activeElement !== $('song-duration')) $('song-duration').value = song.duration ? formatClock(song.duration) : '';
  $('offset').value = String(chart().offset || 0);
  $('compensation').value = String(state.ed.compensation);
}

function updateSong(patch, coalescing) {
  state.ed.edit(draft => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === '' || value === undefined || value === null) delete draft.song[key];
      else draft.song[key] = value;
    }
  }, coalescing);
  changed();
}

// ---------------------------------------------------------------------------------------------
// Lyrics dialog: paste, import a file, or look up LRCLIB on request.

function openLyrics() {
  $('lyrics-text').value = state.lyricsText;
  $('lyrics-result').textContent = '';
  state.lyricsDuration = null;
  renderCandidates(null);
  $('lyrics-dialog').returnValue = '';
  $('lyrics-dialog').showModal();
}

function applyLyrics(text, { restoring = false } = {}) {
  state.lyricsText = text;
  if (!text.trim()) { state.lyrics = null; }
  else {
    const parsed = L.parseLRC(text);
    const timed = parsed.lines.some(line => Number.isFinite(line.start));
    state.lyrics = timed ? parsed : L.parsePlain(text);
    if (timed && state.lyrics.meta) {
      const song = chart().song;
      const patch = {};
      if (!song.title && state.lyrics.meta.ti) patch.title = state.lyrics.meta.ti;
      if (!song.artist && state.lyrics.meta.ar) patch.artist = state.lyrics.meta.ar;
      if (Object.keys(patch).length) updateSong(patch, 'song');
    }
  }
  // With no audio and no length yet, the length comes with the lyrics: the record picked online,
  // the file's own length tag, or a guess from its last line that the maker should check.
  let lengthNote = '';
  if (!restoring && state.lyrics && !chart().song.duration && !hasAudio()) {
    const picked = state.lyricsDuration && state.lyricsDuration.text === text ? state.lyricsDuration.duration : null;
    const guess = picked ? { duration: picked, source: 'picked' } : lyricLines().length ? L.durationFromLyrics(state.lyrics) : null;
    if (guess) {
      updateSong({ duration: guess.duration }, 'song');
      lengthNote = guess.source === 'lastLine' ? `歌曲时长按最后一句估为 ${formatClock(guess.duration)}，请在上方“时长”里核对。` : `歌曲时长设为 ${formatClock(guess.duration)}。`;
    }
  }
  state.lyricsDuration = null;
  state.suggestions = null;
  changed();
  const count = state.lyrics ? state.lyrics.lines.length : 0;
  status(count ? `已加载 ${count} 行歌词${lyricLines().length ? '' : '（没有时间，只能显示）'}。${lengthNote}` : '已清除歌词。', true);
}

/** The records an online search found when the song's length is not known yet; picking one fills the box. */
function renderCandidates(list) {
  const box = $('lyrics-candidates');
  clear(box);
  $('lyrics-candidates-note').hidden = !(list && list.length);
  if (!list) return;
  for (const found of list) {
    const parts = [found.title, found.artist, found.album, found.duration ? formatClock(found.duration) : '时长未知', found.synced ? '带时间' : '无时间'].filter(Boolean);
    box.append(h('li', {}, h('button', { type: 'button', onclick: () => {
      const record = L.fromLRCLIB(found.record);
      const text = record.synced || record.plain || '';
      $('lyrics-text').value = text;
      state.lyricsDuration = found.duration ? { duration: found.duration, text } : null;
      const length = found.duration ? `时长 ${formatClock(found.duration)}` : '时长未知';
      $('lyrics-result').textContent = found.synced
        ? `已填入带时间的歌词（${length}），确认后点“使用这些歌词”。`
        : `已填入纯文本歌词（不含时间，${length}），不能用来按句对时间；确认后点“使用这些歌词”。`;
    } }, parts.join(' · '))));
  }
}

async function lookupLyrics() {
  const song = chart().song;
  if (!song.title || !song.artist) { $('lyrics-result').textContent = '请先在页面上方填写歌名和艺人。'; return; }
  // As Liveglow does: no album in the exact lookup (catalogues name albums differently), then a
  // search by title with the same matching rule as cheer files (spec §8).
  const query = { title: song.title, artist: song.artist, duration: duration() || song.duration };
  $('lyrics-result').textContent = '正在查找…';
  if (state.lyricsLookup) state.lyricsLookup.abort();
  const lookup = new AbortController();
  state.lyricsLookup = lookup;
  const before = $('lyrics-text').value;
  const options = { referrerPolicy: 'no-referrer', signal: lookup.signal, credentials: 'omit' };
  renderCandidates(null);
  try {
    // Without a length there is nothing to match a recording by, so the maker picks from what the
    // search finds; the pick brings its length along.
    if (!(query.duration > 0)) {
      const searchURL = L.lrclibSearchURL({ title: song.title, artist: song.artist });
      const search = searchURL ? await fetch(searchURL, options) : null;
      const list = search && search.ok ? L.lrclibCandidates(await search.json()) : [];
      if (lookup.signal.aborted) return;
      renderCandidates(list);
      $('lyrics-result').textContent = !list.length ? '没有找到这首歌的歌词。可以粘贴或导入 LRC，或手填歌曲时长后用无声计时打点。'
        : list.some(found => found.synced) ? '' : '没有找到带时间的歌词。可以粘贴或导入 LRC，或手填歌曲时长后用无声计时打点。';
      return;
    }
    let record = null;
    const exactURL = L.lrclibGetURL(query);
    if (exactURL) {
      const exact = await fetch(exactURL, options);
      if (exact.ok) record = await exact.json();
    }
    if (!record || (!record.syncedLyrics && !record.plainLyrics)) {
      const searchURL = L.lrclibSearchURL({ title: song.title, artist: song.artist });
      const search = searchURL ? await fetch(searchURL, options) : null;
      if (search && search.ok) record = L.pickLRCLIB(await search.json(), query);
    }
    if (lookup.signal.aborted) return;
    const found = record ? L.fromLRCLIB(record) : null;
    if (!found || (!found.synced && !found.plain)) {
      $('lyrics-result').textContent = found && found.instrumental ? 'LRCLIB 标注这首是纯音乐。' : '没有找到这首歌的歌词，可以粘贴或导入 LRC。';
      return;
    }
    if ($('lyrics-text').value !== before) { $('lyrics-result').textContent = '查到了歌词，但你已经改过文本框，没有覆盖。'; return; }
    $('lyrics-text').value = found.synced || found.plain;
    $('lyrics-result').textContent = found.synced ? '找到了带时间的歌词，确认后点“使用这些歌词”。' : '只找到不带时间的歌词：可以显示，但不能用来对时间和推荐。';
  } catch {
    if (!lookup.signal.aborted) $('lyrics-result').textContent = '连不上 LRCLIB，请稍后再试，或粘贴 / 导入 LRC。';
  } finally {
    if (state.lyricsLookup === lookup) state.lyricsLookup = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Import, export and sharing.

/** Opens a cheer file; `path` is its place in the repository when it came from the community library. */
function importCheer(bytes, source, { path = null, sha256 = null } = {}) {
  const result = cheer.parse(bytes, { sharedFile: false });
  if (!result.valid) { status(`无法打开${source}：${result.errors.slice(0, 2).map(M.issueMessage).join(' ')}`, true); return false; }
  if (state.ed && hasWorkToLose() && !confirm('打开这份应援会替换当前草稿（还没有保存到本机）。上一份草稿会留一份备份。继续？')) return false;
  backUpDraft();
  state.sourcePath = path;
  state.sourceSha256 = sha256;
  // How a file from elsewhere was made is not known; only a cheer started here is asked about it.
  state.heard = true;
  state.watched = false;
  state.notice = null;
  closeVideo({ quiet: true });
  useChart(result.chart);
  offerVideo();
  state.dirty = false;
  saveDraft();
  const song = chart().song;
  const playing = { title: song.title, artist: song.artist, duration: audio.duration };
  const mismatch = hasAudio() && audio.duration && !cheer.matchSong({ title: song.title, artist: song.artist, duration: song.duration }, playing);
  const notes = result.warnings.length ? ' ' + result.warnings.map(M.issueMessage).join(' ') : '';
  status(`已打开${source}（${chart().events.length} 条应援）。${mismatch ? '注意：时长和当前音频对不上，可能不是同一个录音版本。' : ''}${notes}`, true);
  return true;
}

function fileName(song, suffix = '') {
  const base = P.folderName([song.artist, song.title].filter(Boolean).join(' - ') || '应援');
  return `${base}${suffix}.cheer.json`;
}

/** A cheer made here without ever being checked against the recording, and not yet saying so in its note. */
const unheard = () => !state.heard && chart().events.length > 0 && !(chart().credits.note || '').trim();
const UNHEARD_NOTE = '凭记忆与歌词时间制作，未对着音频校对，在映场播放时可能需要微调偏移。';
const WATCHED_NOTE = '对着视频制作（请写明版本或场次），未对着音源校对。';

function saveLocal() {
  download(fileName(chart().song), E.serialize(chart()));
  markExported();
  status(`已保存到本机下载文件夹。这份文件可以在映场里“导入…”。${unheard() ? (state.watched ? '这份应援是对着视频做的，可以在“分享 / 投稿”的制作说明里写明版本或场次。' : '这份应援还没有对着音频校对过，可以在“分享 / 投稿”里填写制作说明。') : ''}`, true);
}

// CheerEditor replaces its immutable chart on edits. A completed copy is usable only while
// that snapshot and its dialog are still current, including when an earlier write finishes late.
let draftSnapshot = null;
let draftAttempt = 0;
let draftCopyPending = false;
function resetDraftLink() {
  draftAttempt++;
  draftSnapshot = null;
  const link = $('draft-launch');
  link.hidden = true;
  link.removeAttribute('href');
  $('draft-result').textContent = '';
  $('draft-copy').disabled = draftCopyPending;
}

async function openDraftInLiveglow() {
  if (draftCopyPending) return;
  resetDraftLink();
  const attempt = draftAttempt, snapshot = chart();
  draftSnapshot = snapshot;
  draftCopyPending = true;
  $('draft-copy').disabled = true;
  const current = () => attempt === draftAttempt && snapshot === chart() && $('draft-dialog').open;
  try {
    const result = await E.copyLocalDraft(snapshot, text => navigator.clipboard.writeText(text));
    if (!current()) return;
    if (result.errors) {
      $('draft-result').textContent = '请先修正应援文件：' + result.errors.slice(0, 2).map(M.issueMessage).join(' ');
      return;
    }
    const link = $('draft-launch');
    link.href = result.url;
    link.hidden = false;
    $('draft-result').textContent = '已复制。请使用支持草稿交接的映场客户端。如果没有自动打开，请点“打开映场”。';
    link.click();
  } catch {
    if (current()) $('draft-result').textContent = '浏览器未能完成剪贴板交接，草稿仍保存在此编辑器。可以允许本站写入剪贴板后重试，或关闭后点“保存到本机”备份。';
  } finally {
    draftCopyPending = false;
    $('draft-copy').disabled = false;
  }
}

function shareChoice() {
  const origin = document.querySelector('input[name="origin"]:checked').value;
  const consent = document.querySelector('input[name="consent"]:checked').value;
  const link = $('share-link').value.trim();
  if (origin === 'self') return { kind: 'selfMade' };
  return { kind: 'referenced', link: link || undefined, consented: consent === 'yes' };
}

/**
 * Where "投稿" goes: the community file this chart was opened from, while its song still belongs
 * in that file's folder and the visitor chose to edit it; otherwise a new file.
 */
function shareTarget(prepared) {
  const path = state.sourcePath;
  const sameFolder = path && P.nameKey(path.split('/').slice(0, 3).join('/')) === P.nameKey(P.expectedFolder(prepared.song));
  $('share-target').hidden = !sameFolder;
  const edit = sameFolder && document.querySelector('input[name="target"]:checked').value === 'edit';
  return edit ? path : null;
}

function renderShare() {
  $('share-unheard').hidden = !unheard();
  $('share-unheard-text').textContent = state.watched
    ? '对着视频制作时，时间只匹配这个视频里的版本（尤其是现场录像）。建议在制作说明里写明版本或场次。'
    : '这份应援还没有对着音频或视频校对过，时间可能有出入。建议写进制作说明，方便使用的人在映场里微调偏移。';
  const choice = shareChoice();
  $('share-referenced').hidden = choice.kind !== 'referenced';
  const author = $('share-author').value.trim();
  const original = chart().credits;
  const published = !!chart().submittedBy;
  const prepared = published ? chart() : E.prepareForSharing(chart(), author, choice);
  // A submitter can publish a credited work. Carry all its existing authors, links and sources.
  if (!published) {
    if (original.authors.length) prepared.credits.authors = original.authors;
    if (choice.kind === 'referenced') {
      const missing = (original.sources || []).filter(source => source.kind !== 'self' && source.url !== choice.link);
      prepared.credits.sources.push(...missing);
    } else if (original.permission === 'original') {
      prepared.credits.sources = original.sources;
    }
  }
  const outcome = E.shareOutcome(prepared, lyricTexts(), $('share-confirm').checked);
  $('share-confirm-row').hidden = outcome.kind !== 'unchecked' && !$('share-confirm').checked;
  let message = '', mode = null;
  if (outcome.kind === 'blocked') message = '还不能分享：' + outcome.issues.slice(0, 3).map(M.issueMessage).join(' ');
  else if (outcome.kind === 'unchecked') message = '没有加载带时间的歌词，无法核对文件里有没有歌词原文。确认没有后勾选上面的选项。';
  else if (outcome.kind === 'noteOnly') { message = '参考了别人的版本、又不确定原作者是否同意时，只能分享来源说明（作者和链接），不能分享时间轴。'; mode = 'note'; }
  else if (outcome.kind === 'file') {
    mode = 'file';
    message = published ? '分享会保留原文件的全部作者、来源和使用条件。'
      : choice.kind === 'referenced'
      ? '可以分享：会保留你和原作者的署名与链接。投稿时请在 Pull Request 里附上原作者同意的说明。'
      : '可以分享：自己听写的应援投稿到 CheerBook 默认以 CC BY 4.0 授权。';
  }
  if ($('share-outcome').textContent !== message) $('share-outcome').textContent = message;
  $('share-download').textContent = mode === 'note' ? '下载来源说明' : '下载分享文件';
  $('share-download').disabled = !mode;
  $('share-submit').disabled = mode !== 'file';
  const editing = shareTarget(prepared);
  $('share-github').disabled = mode !== 'file';
  $('share-submit').textContent = editing ? '免账号提交修改…' : '免账号投稿…';
  return { prepared, outcome, mode, author, editing };
}

async function submitShareOnGitHub() {
  const { prepared, outcome, mode, author, editing } = renderShare();
  if (mode !== 'file') return;
  const content = outcome.text;
  if (editing) {
    // GitHub's edit page cannot be prefilled, so the new text goes to the clipboard (or a download).
    let copied = false;
    try { await navigator.clipboard.writeText(content); copied = true; } catch { download(fileName(prepared.song, ' (分享)'), content); }
    window.open(`${REPO}/edit/main/${editing.split('/').map(encodeURIComponent).join('/')}`, '_blank', 'noopener');
    markExported();
    status(`${copied ? '修改后的内容已复制到剪贴板' : '已下载修改后的文件'}，并打开了 GitHub 上原文件的编辑页面：全选、粘贴后按页面提示提交。修改已有文件需要原作者或维护者批准，由维护者合并。`, true);
    $('share-dialog').close();
    return;
  }
  const folder = P.expectedFolder(prepared.song);
  const name = `${folder}/${P.folderName(author) || '应援'}.cheer.json`;
  const base = `${REPO}/new/main?filename=${encodeURIComponent(name)}`;
  const full = `${base}&value=${encodeURIComponent(content)}`;
  markExported();
  if (full.length <= 7500) {
    window.open(full, '_blank', 'noopener');
    status('已打开 GitHub 的新建文件页面（内容已填好）。登录后按页面提示提交 Pull Request。', true);
  } else {
    let copied = false;
    try { await navigator.clipboard.writeText(content); copied = true; } catch { download(fileName(prepared.song, ' (分享)'), content); }
    window.open(base, '_blank', 'noopener');
    status(copied ? '文件较大，内容已复制到剪贴板：在打开的 GitHub 页面里粘贴，然后提交 Pull Request。' : '文件较大，已下载分享文件：在打开的 GitHub 页面里粘贴文件内容，然后提交 Pull Request。', true);
  }
  $('share-dialog').close();
}

// ---------------------------------------------------------------------------------------------
// Tap tempo and reaction calibration.

function syncTapButton() {
  $('tap-tempo').textContent = state.taps && state.taps.length ? `继续敲（${state.taps.length} / 8）` : '跟拍 8 下估 BPM';
}

function tapTempo() {
  const playing = transport.ready && !transport.paused;
  // With audio the taps go with the music, so they need it playing; only the silent clock counts taps on their own.
  if (!playing && (hasAudio() || transport.kind === 'video')) { state.taps = null; syncTapButton(); status('边播放边跟着鼓点按 T（或点“跟拍 8 下估 BPM”），连按 8 下。', true); return; }
  if (!playing && !(duration() > 0)) { status('先填写歌曲时长或选择本地音频，再跟拍。', true); return; }
  // Without playback the taps are timed on the wall clock: they give the tempo, not where a bar starts.
  const now = performance.now() / 1000;
  if (state.taps && (state.wallTaps === playing || (!playing && now - state.taps[state.taps.length - 1] > 3))) state.taps = null;
  state.taps = state.taps || [];
  state.wallTaps = !playing;
  // Taps along with playback land late by the listener's reaction time, as the sticks do.
  state.taps.push(playing ? position() - state.ed.compensation : now);
  if (state.taps.length < 8) { syncTapButton(); status(playing ? `跟拍 ${state.taps.length} / 8` : `跟着心里的节奏，连点按钮或按 T 键 8 下（${state.taps.length} / 8）。`, true); return; }
  const found = S.gridFromTaps(state.taps);
  state.taps = null;
  syncTapButton();
  if (!found) { status('跟拍不太稳，没能估出速度，再试一次。', true); return; }
  if (playing) {
    // The taps replace a grid typed in for this recording.
    if (typedForThisAudio()) rememberManualGrid(null);
    setGrid(found, `节拍：${Math.round(found.bpm)} BPM · 跟拍`);
    status(`已按跟拍对齐：${Math.round(found.bpm)} BPM。`, true);
    return;
  }
  const first = lyricLines()[0];
  const grid = S.gridFromBPM(Math.round(found.bpm * 10) / 10, first ? Math.min(first.start, duration()) : 0, duration());
  if (!grid) { status('跟拍不太稳，没能估出速度，再试一次。', true); return; }
  rememberManualGrid(grid);
  setGrid(grid, `节拍：${bpmText(grid)} BPM · 跟拍`);
  status(`已按跟拍设为 ${bpmText(grid)} BPM。小节线暂时对在${first ? '第一句歌词' : ' 0:00'}，可以在“BPM 与起拍偏移…”里改。`, true);
}

async function calibrate() {
  const Context = window.AudioContext || window.webkitAudioContext;
  const context = new Context();
  const beat = 0.6, count = 8, startAt = context.currentTime + 0.8;
  const pulses = [];
  for (let i = 0; i < count; i++) {
    const at = startAt + i * beat;
    pulses.push(at);
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = i % 4 === 0 ? 1320 : 880;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.4, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
    osc.connect(gain).connect(context.destination);
    osc.start(at);
    osc.stop(at + 0.1);
  }
  const taps = [];
  const button = $('calibrate');
  const note = $('calibrate-result');
  state.calibrating = true;
  const label = button.textContent;
  button.textContent = '嘀！按这里';
  note.textContent = '听到“嘀”就按一下空格或这个按钮（共 8 下）…';
  const onTap = event => { if (event.type === 'keydown' && event.key !== ' ') return; event.preventDefault(); taps.push(context.currentTime); };
  window.addEventListener('keydown', onTap, true);
  button.addEventListener('pointerdown', onTap);
  await new Promise(resolve => setTimeout(resolve, (0.8 + count * beat + 0.6) * 1000));
  window.removeEventListener('keydown', onTap, true);
  button.removeEventListener('pointerdown', onTap);
  context.close();
  state.calibrating = false;
  button.textContent = label;
  const reaction = E.calibrationReaction(taps, pulses);
  if (reaction === null || reaction === undefined) { note.textContent = '没测出来：按得太少或差得太多，再试一次。'; return; }
  state.ed.compensation = E.clampedCompensation(reaction);
  $('compensation').value = String(Math.round(state.ed.compensation * 1000) / 1000);
  note.textContent = `你的反应大约慢 ${Math.round(reaction * 1000)} 毫秒，已设为补偿。`;
  saveDraft();
}

// ---------------------------------------------------------------------------------------------
// Keyboard: only while focus is not in a text field or dialog (shortcuts never steal typing).
// Space and Delete act on the editor only from the page itself, a timeline row or a cheer tag, so
// buttons, checkboxes and other controls keep their own keys.

const editorSurface = target => target === document.body || target === document.documentElement || !!target.closest('.row, .tag, .timeline');

window.addEventListener('keydown', event => {
  if (!state.ed || typingTarget(event.target) || event.altKey) return;
  const mod = event.metaKey || event.ctrlKey;
  const watching = root.dataset.mode === 'watch';
  if (mod && event.code === 'KeyZ') { if (watching) return; event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
  if (mod) return;
  const { key, code } = event;
  if (code === 'Space') { if (editorSurface(event.target)) { event.preventDefault(); togglePlay(); } return; }
  if (key === 'ArrowLeft' || key === 'ArrowRight') { if (event.target.closest('input, select')) return; event.preventDefault(); seek(position() + (key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 5)); return; }
  if (key === 'Escape') {
    if (state.held.size) { dropHeld('已取消正在记录的这一下。'); return; }
    state.selected = null; renderTimeline(); renderSelected(); return;
  }
  if (watching) return;
  if ((key === 'Delete' || key === 'Backspace') && state.selected !== null && editorSurface(event.target)) {
    event.preventDefault(); state.ed.removeEvent(state.selected); state.selected = null; status('已删除这一条（可以撤销）。', true); changed(); return;
  }
  if (code === 'KeyT' && !event.repeat) { event.preventDefault(); tapTempo(); return; }
  const stick = stickForCode(code);
  if (stick) { event.preventDefault(); if (!event.repeat) press(stick, { code }); }
});

// A hold ends on the keyup of the same physical key, wherever focus has moved meanwhile.
window.addEventListener('keyup', event => {
  if (!state.ed) return;
  for (const held of [...state.held.values()]) {
    if (held.code === event.code) { event.preventDefault(); release(held.stick); }
  }
});
window.addEventListener('blur', () => dropHeld('窗口失去焦点，已取消正在记录的这一下。'));
document.addEventListener('visibilitychange', () => { if (document.hidden) dropHeld('页面被切到后台，已取消正在记录的这一下。'); });

function stickForCode(code) {
  return stickKeys().find(stick => stick.codes.includes(code)) || null;
}

function undo() { if (state.ed.canUndo) { state.ed.undo(); state.selected = null; status('已撤销。', true); changed(); } }
function redo() { if (state.ed.canRedo) { state.ed.redo(); state.selected = null; status('已重做。', true); changed(); } }

// ---------------------------------------------------------------------------------------------
// Rendering everything that depends on the chart.

function renderAll({ panel = true } = {}) {
  if (!state.ed) return;
  syncSongFields();
  renderMembers();
  renderSticks();
  renderTimeline();
  if (panel) renderSelected();
  renderIssues();
  renderLibrary();
  $('undo').disabled = !state.ed.canUndo;
  $('redo').disabled = !state.ed.canRedo;
}

// ---------------------------------------------------------------------------------------------
// Wiring.

function wire() {
  $('pick-audio').addEventListener('click', pickAudio);
  $('audio-file').addEventListener('change', e => { loadAudio(e.target.files[0]); e.target.value = ''; });
  $('play').addEventListener('click', togglePlay);
  $('seek').addEventListener('input', e => seek(Number(e.target.value)));
  $('rate').addEventListener('change', e => { transport.setRate(Number(e.target.value) || 1); click.reset(); });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('suggest').addEventListener('click', computeSuggestions);
  $('grid-double').addEventListener('click', () => adjustGrid('double'));
  $('grid-half').addEventListener('click', () => adjustGrid('half'));
  $('grid-shift').addEventListener('click', () => adjustGrid('shift'));
  $('grid-set').addEventListener('click', openGridDialog);
  $('grid-here').addEventListener('click', gridAnchorHere);
  $('grid-auto').addEventListener('click', restoreAutoGrid);
  $('grid-dialog').addEventListener('close', () => { if ($('grid-dialog').returnValue === 'apply') applyGridDialog(); });
  $('save-local').addEventListener('click', saveLocal);
  $('toggle-mode').addEventListener('click', () => setMode(root.dataset.mode !== 'watch'));
  $('source-silent').addEventListener('click', () => dropAudio());
  $('notice-audio').addEventListener('click', pickAudio);
  $('notice-video').addEventListener('click', openVideoDialog);
  $('notice-external').addEventListener('click', startExternal);
  $('open-video').addEventListener('click', openVideoDialog);
  $('video-link').addEventListener('input', renderVideoDialog);
  $('video-link').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); loadFromDialog(); } });
  $('video-load').addEventListener('click', loadFromDialog);
  $('video-external').addEventListener('click', () => { $('video-dialog').close('external'); startExternal(); });
  $('video-offer-load').addEventListener('click', () => { const offer = state.videoOffer; if (offer) loadVideo(offer.link, offer.link.platform === 'youtube' ? { offset: offer.offset, marked: offer.marked } : { start: offer.start }); });
  $('video-offer-skip').addEventListener('click', () => { state.videoOffer = null; renderVideoOffer(); });
  $('video-close').addEventListener('click', () => closeVideo());
  $('video-change').addEventListener('click', openVideoDialog);
  $('video-retry').addEventListener('click', () => { if (state.video && state.video.link) loadVideo(state.video.link); });
  $('video-to-external').addEventListener('click', startExternal);
  $('video-mark-start').addEventListener('click', markStart);
  $('video-mark-earlier').addEventListener('click', () => nudgeStart(-0.1));
  $('video-mark-later').addEventListener('click', () => nudgeStart(0.1));
  $('video-mark-again').addEventListener('click', unmarkStart);
  $('video-mark-end').addEventListener('click', markEnd);
  $('manual-earlier').addEventListener('click', () => manualNudge(0.1));
  $('manual-later').addEventListener('click', () => manualNudge(-0.1));
  $('manual-reset').addEventListener('click', manualReset);
  $('notice-close').addEventListener('click', () => { state.notice = null; syncSource(); });
  $('metronome').addEventListener('change', e => click.enable(e.target.checked));
  for (const node of document.querySelectorAll('[data-start]')) {
    node.addEventListener('click', () => {
      if (node.dataset.start === 'audio') pickAudio();
      else if (node.dataset.start === 'video') openVideoDialog();
      else if (node.dataset.start === 'lyrics') openLyrics();
      else $('song-duration').focus();
    });
  }
  $('song-duration').addEventListener('change', e => {
    if (hasAudio()) return;
    const text = e.target.value.trim();
    const shown = chart().song.duration ? formatClock(chart().song.duration) : '';
    if (text === shown) return;
    const seconds = E.parseDuration(text);
    // "3.45" reads as 3.45 seconds; no song is that short, so it is taken as a slip for 3:45.
    if (seconds === null || seconds < 10) { status('请按 分:秒 填写，例如 3:45。', true); e.target.value = shown; return; }
    updateSong({ duration: seconds }, 'song:duration');
    status(`歌曲时长设为 ${formatClock(seconds)}。可以点“播放”无声计时，或在“歌词…”里加载歌词。`, true);
  });
  for (const [id, key] of [['song-title', 'title'], ['song-artist', 'artist'], ['song-album', 'album'], ['song-isrc', 'isrc'], ['song-amid', 'appleMusicID']]) {
    const apply = e => updateSong({ [key]: e.target.value.trim() ? e.target.value : '' }, 'song:' + key);
    $(id).addEventListener('input', e => { if (!e.isComposing) apply(e); });
    $(id).addEventListener('compositionend', apply);
  }
  $('add-member').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('member-name').value.trim();
    if (!name) return;
    state.ed.addMember(name, $('member-color').value.toUpperCase());
    $('member-name').value = '';
    changed();
  });
  // Dialogs: the cancel buttons only close, so Enter in a field never submits "取消".
  for (const button of document.querySelectorAll('dialog button[data-close]')) button.addEventListener('click', () => button.closest('dialog').close('cancel'));
  // Lyrics.
  $('open-lyrics').addEventListener('click', openLyrics);
  $('lyrics-file-button').addEventListener('click', () => $('lyrics-file').click());
  $('lyrics-file').addEventListener('change', async e => { const file = e.target.files[0]; if (file) $('lyrics-text').value = await file.text(); e.target.value = ''; });
  $('lyrics-online').addEventListener('click', lookupLyrics);
  $('lyrics-dialog').addEventListener('close', () => {
    if (state.lyricsLookup) state.lyricsLookup.abort();
    if ($('lyrics-dialog').returnValue === 'apply') applyLyrics($('lyrics-text').value);
  });
  // Import.
  $('open-import').addEventListener('click', () => $('cheer-file').click());
  $('cheer-file').addEventListener('change', async e => { const file = e.target.files[0]; if (file) importCheer(new Uint8Array(await file.arrayBuffer()), `“${file.name}”`); e.target.value = ''; });
  // More.
  $('open-more').addEventListener('click', () => { syncSongFields(); $('more-dialog').showModal(); });
  $('compensation').addEventListener('change', e => { state.ed.compensation = E.clampedCompensation(Number(e.target.value)); e.target.value = String(state.ed.compensation); saveDraft(); });
  $('offset').addEventListener('change', e => {
    const value = Math.max(-10, Math.min(10, Number(e.target.value) || 0));
    state.ed.edit(draft => { draft.offset = value; }, 'offset');
    changed();
  });
  $('calibrate').addEventListener('click', () => { if (!state.calibrating) calibrate(); });
  for (const [id, key] of [['show-original', 'original'], ['show-kana', 'kana'], ['show-romaji', 'romaji']]) {
    $(id).checked = state.display[key];
    $(id).addEventListener('change', e => {
      const next = { ...state.display, [key]: e.target.checked };
      if (!next.original && !next.kana && !next.romaji) { e.target.checked = true; status('至少要显示一种：原文、平假名或罗马音。', true); return; }
      state.display = next;
      storage.set(DISPLAY_KEY, next);
      frame(true);
    });
  }
  // A manual scroll of the lyric list (wheel, touch, keys, the scroll bar) holds it for a while.
  const box = lyricsBox();
  box.addEventListener('wheel', noteManualScroll, { passive: true });
  box.addEventListener('touchstart', noteManualScroll, { passive: true });
  box.addEventListener('pointerdown', event => { if (event.target === box) noteManualScroll(); });
  box.addEventListener('keydown', event => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) noteManualScroll(); });
  // The room above and below the lines (CSS) follows the list's height, set at once and on resize.
  const measureLyrics = () => box.style.setProperty('--lyrics-h', box.clientHeight + 'px');
  measureLyrics();
  new ResizeObserver(measureLyrics).observe(box);
  window.addEventListener('resize', measureLyrics);
  $('tap-tempo').addEventListener('click', tapTempo);
  $('grid-open').addEventListener('click', () => { $('more-dialog').close(); openGridDialog(); });
  $('sort-events').addEventListener('click', () => { state.ed.sortEvents(); state.selected = null; changed(); });
  $('new-chart').addEventListener('click', () => {
    if (hasWorkToLose() && !confirm('新建空白应援会替换当前草稿（还没有保存到本机）。上一份草稿会留一份备份。继续？')) return;
    backUpDraft();
    state.dirty = false;
    state.sourcePath = null;
    state.sourceSha256 = null;
    state.heard = hasAudio();
    state.watched = false;
    state.notice = null;
    closeVideo({ quiet: true });
    state.videoOffer = null;
    renderVideoOffer();
    useChart(newChart({ title: chart().song.title, artist: chart().song.artist, duration: duration() }));
    $('more-dialog').close();
    status('已新建空白应援。', true);
  });
  $('open-draft').addEventListener('click', () => { resetDraftLink(); $('draft-dialog').showModal(); });
  $('draft-dialog').addEventListener('close', resetDraftLink);
  $('draft-copy').addEventListener('click', openDraftInLiveglow);
  $('draft-launch').addEventListener('click', event => {
    if (!draftSnapshot || draftSnapshot !== chart()) { event.preventDefault(); resetDraftLink(); }
  });
  // Share.
  const submission = setupSubmission($, () => {
    const { mode, outcome, editing } = renderShare();
    if (mode !== 'file') throw new Error('请先完成上方的文件与来源检查。');
    if (editing && !state.sourceSha256) throw new Error('这份旧草稿缺少原文件版本。请先保存草稿，用 GitHub 对照原文提交修改，或从社区重新打开原文件。');
    return { chart: outcome.text, ...(editing ? { target: { path: editing, sha256: state.sourceSha256 } } : {}) };
  });
  $('open-share').addEventListener('click', () => {
    $('share-confirm').checked = false;
    const credits = chart().credits;
    const source = E.shareOrigin(credits);
    const author = $('share-author');
    author.value = credits.authors.map(entry => entry.name).join('、');
    author.readOnly = credits.authors.length > 0;
    const published = !!chart().submittedBy;
    for (const field of document.querySelectorAll('#share-dialog input[name="origin"], #share-dialog input[name="consent"], #share-link')) {
      field.disabled = published;
    }
    document.querySelector(`input[name="origin"][value="${source.kind === 'selfMade' ? 'self' : 'referenced'}"]`).checked = true;
    $('share-link').value = source.link || '';
    $('share-note').value = credits.note || '';
    document.querySelector(`input[name="consent"][value="${source.consented ? 'yes' : 'unsure'}"]`).checked = true;
    renderShare();
    $('share-dialog').showModal();
  });
  for (const input of document.querySelectorAll('#share-dialog input')) input.addEventListener('input', renderShare);
  const setNote = text => {
    state.ed.edit(draft => {
      if (text.trim()) draft.credits.note = text;
      else delete draft.credits.note;
    }, 'credits:note');
    changed({ panel: false });
    renderShare();
  };
  $('share-note').addEventListener('input', e => { if (!e.isComposing) setNote(e.target.value); });
  $('share-note').addEventListener('compositionend', e => setNote(e.target.value));
  $('share-note-fill').addEventListener('click', () => {
    const note = state.watched ? WATCHED_NOTE : UNHEARD_NOTE;
    $('share-note').value = note;
    setNote(note);
    $('share-note').focus();
  });
  $('share-download').addEventListener('click', () => {
    const { prepared, outcome, mode } = renderShare();
    if (mode === 'file') { download(fileName(prepared.song, ' (分享)'), outcome.text); markExported(); status('已下载分享文件。', true); }
    else if (mode === 'note') { download(fileName(prepared.song, ' (来源说明)').replace(/\.cheer\.json$/, '.txt'), outcome.note, 'text/plain;charset=utf-8'); status('已下载来源说明。', true); }
  });
  $('share-github').addEventListener('click', submitShareOnGitHub);
  $('share-submit').addEventListener('click', () => {
    const { mode, author } = renderShare();
    if (mode === 'file') submission.open(chart().credits.authors.length ? '' : author);
  });
  $('share-dialog').addEventListener('close', submission.close);
  window.addEventListener('beforeunload', event => {
    if (saveDraft.pending()) saveDraft.flush();
    if (state.ed && hasWorkToLose()) { event.preventDefault(); event.returnValue = ''; }
  });
  const dock = document.querySelector('.ed-dock');
  const measure = () => root.style.setProperty('--dock-h', dock.offsetHeight + 'px');
  new ResizeObserver(measure).observe(dock);
  measure();
}

/** The draft from this browser, if it has the shape of a chart; null otherwise (never throws). */
function readDraft() {
  const draft = storage.get(DRAFT_KEY);
  if (!draft || typeof draft !== 'object') return null;
  const c = draft.chart;
  // A draft may not pass the format check yet (no duration before audio is chosen, a cheer still
  // being typed), so only its shape is checked here; the live check reports the rest.
  const shaped = c && typeof c === 'object' && c.song && typeof c.song === 'object' && c.credits && typeof c.credits === 'object' &&
    Array.isArray(c.events) && c.events.every(event => event && typeof event === 'object') && (c.members === undefined || Array.isArray(c.members));
  return shaped ? draft : null;
}

async function start() {
  wire();
  const fetchJSON = async url => {
    try {
      const reply = await fetch(url);
      return reply.ok ? await reply.json() : null;
    } catch { return null; }
  };
  const [library, artists] = await Promise.all([fetchJSON('/spec/mix-library.json'), fetchJSON('/mix/artists.json')]);
  state.library = library && typeof library === 'object' ? library : { entries: [], sources: {} };
  state.artistMixes = artists && Array.isArray(artists.mixes) ? artists.mixes : [];
  const draft = readDraft();
  try {
    useChart(draft ? { ...draft.chart, members: draft.chart.members || [] } : newChart(), { compensation: draft ? E.clampedCompensation(draft.compensation) : undefined, quiet: true });
  } catch {
    useChart(newChart(), { quiet: true });
    status('上次的草稿读不出来，已新建空白应援。', true);
  }
  state.dirty = !!(draft && draft.dirty);
  // A draft from before this was recorded is not asked about how it was made.
  state.heard = draft ? draft.heard !== false : false;
  state.watched = !!(draft && draft.watched === true);
  state.member = draft && typeof draft.member === 'string' && chart().members.some(member => member.id === draft.member) ? draft.member : null;
  state.sourcePath = draft && typeof draft.sourcePath === 'string' && draft.sourcePath.startsWith(P.LIBRARY_DIR + '/') ? draft.sourcePath : null;
  state.sourceSha256 = draft && /^[a-f0-9]{64}$/.test(draft.sourceSha256) ? draft.sourceSha256 : null;
  const typed = draft && draft.grid;
  state.manualGrid = typed && typeof typed === 'object' && typeof typed.audioName === 'string' && Number.isFinite(typed.duration) && typed.duration > 0 &&
    S.gridFromBPM(typed.bpm, typed.anchor, typed.duration) ? { bpm: typed.bpm, anchor: typed.anchor, audioName: typed.audioName, duration: typed.duration } : null;
  if (draft && typeof draft.lyricsText === 'string' && draft.lyricsText) { state.lyricsText = draft.lyricsText; applyLyrics(draft.lyricsText, { restoring: true }); state.dirty = !!draft.dirty; }
  if (draft && chart().events.length) status(`已恢复上次的草稿（${chart().events.length} 条应援）。${draft.audioName ? `重新选择音频“${draft.audioName}”即可继续。` : '可以点“播放”无声计时，或选择本地音频。'}`);
  else status('选择本地音频，或不用音频：填上时长、加载歌词就能开始。音频只在你的浏览器里播放，不会上传。');
  // A link from the library opens that file once; the address is then cleaned so a reload does
  // not open it again over the visitor's edits.
  const wanted = new URLSearchParams(location.search).get('cheer');
  if (wanted !== null) history.replaceState(null, '', location.pathname);
  if (wanted && /^\/cheers\/[^?#\\]+\.cheer\.json$/.test(wanted) && !wanted.split('/').includes('..')) {
    try {
      const reply = await fetch(wanted, { credentials: 'omit' });
      // The repository path, for "提交修改": decoded, and only plain names between the slashes.
      const path = decodeURIComponent(wanted.slice(1));
      const plainPath = path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[\\?#]/.test(part));
      if (reply.ok) {
        const bytes = new Uint8Array(await reply.arrayBuffer());
        // Keep the revision actually opened, including after closing and restoring this draft.
        const digest = crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : null;
        const sha256 = digest ? [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') : null;
        // "在网页中播放": it opens ready to watch, on the silent clock until audio is chosen.
        if (importCheer(bytes, '社区库里的这份应援', { path: plainPath ? path : null, sha256 }) && !hasAudio()) {
          state.notice = 'community';
          setMode(true);
        }
      } else status('没能读取社区库里的这份应援。', true);
    } catch { status('没能读取社区库里的这份应援。', true); }
  }
  check.flush();
  syncSource();
  renderAll();
  if (!state.videoOffer) offerVideo();
  frame(true);
}

start();
