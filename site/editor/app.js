// CheerBook web editor: plays a local audio file, shows lyrics as a scroll, records cheers with
// hold-to-record sticks and keys, inserts built-in MIX, analyses the beat in a worker, suggests MIX
// for lyric gaps, and checks the file as it changes. The rules are the shared modules in lib/
// (bundled as /editor/lib.js); this file only wires them to the page. Audio and lyrics never leave
// the browser, except that "在线查找" sends the song's title, artist and length to lrclib.net.
import lib from '/editor/lib.js';
import { h, clear, formatTime, formatClock, debounce, download, storage, typingTarget } from '/editor/dom.js';

const { cheer, editor: E, suggest: S, lyrics: L, messages: M, paths: P, lyricsview: V, mixes: MX } = lib;

const DRAFT_KEY = 'cheerbook.editor.draft.v1';
const REPO = 'https://github.com/alexpsz/cheerbook';
const BAND_LEAD = 5;
const $ = id => document.getElementById(id);
const root = $('editor');
const audio = new Audio();
audio.preload = 'auto';

const state = {
  ed: null,
  library: null,
  // Every artist MIX on the site (/mix/artists.json); the ones for this song come first in the MIX list.
  artistMixes: null,
  // The repository path of the community file this chart was opened from, so it can be edited in place.
  sourcePath: null,
  audioURL: null,
  audioName: '',
  lyrics: null,
  lyricsText: '',
  grid: null,
  gridNote: '',
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
};
const DRAFT_BACKUP_KEY = 'cheerbook.editor.draft.backup.v1';
const DISPLAY_KEY = 'cheerbook.editor.display.v1';
state.display = (() => {
  const saved = storage.get(DISPLAY_KEY) || {};
  const display = { original: saved.original !== false, kana: saved.kana === true, romaji: saved.romaji === true };
  return display.original || display.kana || display.romaji ? display : { original: true, kana: false, romaji: false };
})();

// ---------------------------------------------------------------------------------------------
// Time: the audio plays in playback time; a cheer file is in cheer time (playback + offset).

const position = () => audio.currentTime || 0;
const chart = () => state.ed.chart;
const cheerTime = pos => pos + (chart().offset || 0);
const playbackTime = time => time - (chart().offset || 0);
const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : chart().song.duration || 0);
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
    audioName: state.audioName, member: state.member, sourcePath: state.sourcePath, savedAt: new Date().toISOString(),
  });
  if (!ok && !state.storageWarned) {
    state.storageWarned = true;
    status('草稿没能保存在这个浏览器里（存储已满或被禁用）。请记得“保存到本机”。', true);
  }
}, 400);

/** After any change to the chart: re-check, re-render and remember the draft. */
function changed({ save = true, panel = true } = {}) {
  if (save) state.dirty = true;
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
  if (state.audioURL) URL.revokeObjectURL(state.audioURL);
  state.audioURL = URL.createObjectURL(file);
  state.audioName = file.name;
  audio.src = state.audioURL;
  audio.playbackRate = Number($('rate').value) || 1;
  status(`已载入“${file.name}”，正在读取时长与节拍…`);
  const meta = await new Promise(resolve => {
    const done = () => { audio.removeEventListener('loadedmetadata', done); audio.removeEventListener('error', fail); resolve(true); };
    const fail = () => { audio.removeEventListener('loadedmetadata', done); audio.removeEventListener('error', fail); resolve(false); };
    audio.addEventListener('loadedmetadata', done);
    audio.addEventListener('error', fail);
  });
  if (!meta) { status('这个文件无法在浏览器里播放。请换成 MP3、AAC / M4A、FLAC、WAV 或 Ogg 文件。', true); return; }
  root.dataset.ready = 'true';
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
  for (const id of ['play', 'seek']) $(id).disabled = false;
  $('seek').max = String(audio.duration);
  renderAll();
  analyseBeat(file);
}

/** "Artist - Title.mp3" → both; otherwise the file name is the title. */
function guessSong(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, '').trim();
  const parts = base.split(/\s+[-–—]\s+/);
  return parts.length === 2 ? { artist: parts[0].trim(), title: parts[1].trim() } : { title: base };
}

async function analyseBeat(file) {
  const run = ++state.analysisRun;
  setGrid(state.grid && state.grid.source === 'taps' ? state.grid : null, '节拍：正在分析…');
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
    if (!found) { setGrid(state.grid, '节拍：没找到稳定的节拍，可以在“更多”里跟拍 8 下。'); status('已载入音频。没找到稳定的节拍：MIX 会插到当前位置，推荐只标出空位。', true); return; }
    if (state.grid && state.grid.source === 'taps') { setGrid(state.grid, `节拍：已按跟拍（自动分析为 ${Math.round(found.bpm)} BPM）`); return; }
    const level = found.confidence >= 0.66 ? '高' : found.confidence >= 0.4 ? '中' : '低';
    const doubtful = found.confidence < 0.4 || (found.downbeatConfidence ?? 1) < 0.5;
    setGrid(S.makeGrid(found.beat, found.anchor, 'beatMap'), `节拍：${Math.round(found.bpm)} BPM · 自动分析（把握${level}）`);
    status(`已载入音频，节拍 ${Math.round(found.bpm)} BPM。${lyricLines().length ? '可以边听边点了。' : '可以加载歌词，然后边听边点。'}`);
    if (doubtful) status('自动分析的节拍把握不大：播放时看节拍点是否跟上鼓点，不对可以用 ×2、÷2、移一拍调整，或跟拍 8 下。', true);
  } catch (error) {
    if (run !== state.analysisRun) return;
    setGrid(state.grid, '节拍：分析失败（' + error.message + '），可以在“更多”里跟拍 8 下。');
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

function setGrid(grid, note) {
  state.grid = grid;
  state.gridNote = note;
  $('grid-status').textContent = note;
  for (const id of ['grid-double', 'grid-half', 'grid-shift']) $(id).hidden = !grid;
  $('mix-hint').textContent = grid ? '点一下插入到当前位置，对齐到下一拍。' : '点一下插入到当前位置。';
  state.suggestions = null;
  $('suggest').textContent = '✦ 推荐';
  renderTimeline();
}

// ---------------------------------------------------------------------------------------------
// Playback controls and the frame loop.

/** Manual corrections for the usual estimator slips: double / half tempo, bar line a beat off. */
function adjustGrid(kind) {
  const grid = state.grid;
  if (!grid) return;
  const beat = kind === 'double' ? grid.beat / 2 : kind === 'half' ? grid.beat * 2 : grid.beat;
  if (60 / beat < 40 || 60 / beat > 320) return;
  const anchor = kind === 'shift' ? grid.anchor + grid.beat : grid.anchor;
  const next = S.makeGrid(beat, anchor, grid.source);
  setGrid(next, `节拍：${Math.round(next.bpm)} BPM · 已手动调整`);
  status(kind === 'shift' ? '小节线已移后一拍。' : `已改为 ${Math.round(next.bpm)} BPM。`, true);
}

function togglePlay() {
  if (!state.audioURL) { pickAudio(); return; }
  if (audio.paused) audio.play().catch(() => status('浏览器没有允许播放，请再点一次播放。', true));
  else audio.pause();
}

function seek(to) {
  if (!state.audioURL) return;
  follow.manualAt = -Infinity;
  audio.currentTime = Math.min(Math.max(0, to), duration());
  frame(true);
}

// One animation loop at most, running only while the audio plays; everything else draws a single
// frame with `frame()`.
let rafId = 0;
function loop() {
  rafId = 0;
  frame();
  if (!audio.paused) rafId = requestAnimationFrame(loop);
}
function startLoop() { if (!rafId && !audio.paused) rafId = requestAnimationFrame(loop); }

function frame(force = false, { reposition = true } = {}) {
  const pos = position();
  $('clock').textContent = `${formatTime(pos)} / ${formatClock(duration())}`;
  if (!$('seek').matches(':active')) $('seek').value = String(pos);
  renderBand(pos);
  renderBeatDot(pos);
  syncFocus(pos, { force, reposition });
  updateFill(pos);
  if (state.held.size) renderHeldTags(pos);
}

audio.addEventListener('play', () => { $('play').textContent = '暂停'; frame(true); startLoop(); });
audio.addEventListener('pause', () => { $('play').textContent = '播放'; frame(true); });
audio.addEventListener('ended', () => { $('play').textContent = '播放'; });
audio.addEventListener('seeked', () => frame(true));

/** A dot that lights on each beat (brighter on bar lines), to check the grid by ear and eye. */
function renderBeatDot(pos) {
  const dot = $('beat-dot');
  const grid = state.grid;
  if (!grid || audio.paused) { dot.dataset.on = 'off'; return; }
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
  if (!state.audioURL) { status('先选择本地音频，再边听边点。', true); return; }
  const pos = position();
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
  const singers = singersByLine();
  rows.forEach((row, i) => {
    const tags = h('div', { class: 'tags' },
      row.events.map(item => eventTag(item)),
      row.ghosts.map(ghost => ghostTag(ghost)));
    const body = row.kind === 'line'
      ? h('div', { class: 'body' }, lineText(row.line), tags)
      : h('div', { class: 'body' }, row.kind === 'gap' ? h('div', { class: 'text' }, gapLabel(row)) : null, tags);
    const bars = h('span', { class: 'singers', 'aria-hidden': 'true' },
      (row.kind === 'line' ? singers.get(row.lineIndex) || [] : []).map(color => h('i', { style: { '--member': color } })));
    const label = row.kind === 'line' ? `${formatTime(row.start)} ${row.line.text}` : gapLabel(row);
    list.append(h('li', { class: `row ${row.kind}`, dataset: { row: String(i) }, tabindex: '-1', 'aria-label': label,
      onclick: event => { if (!event.target.closest('.tag')) { follow.manualAt = -Infinity; seek(row.start); } } },
    h('span', { class: 'time' }, formatTime(row.start)), bars, body));
  });
  if (box) box.scrollTop = keep;
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
  const animated = !force && !reducedMotion() && !audio.paused && Math.abs(target - box.scrollTop) < box.clientHeight * 2;
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
  const key = JSON.stringify([view, !!state.audioURL, state.display]);
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
    const kana = show.kana && item.kana && item.kana.length === words.length ? item.kana : null;
    const romaji = show.romaji && item.romaji && item.romaji.length === words.length ? item.romaji : null;
    // A cheer without readings still shows its words when only readings were chosen.
    const original = show.original || (!kana && !romaji);
    band.append(h('span', { class: 'item', style: color ? { '--member': color } : undefined },
      h('span', { class: 'kind meta' }, item.label),
      words.map((word, i) => h('span', { class: 'w' + (item.activeWord !== null && i <= item.activeWord ? ' on' : '') },
        kana ? h('span', { class: 'kana', lang: 'ja' }, kana[i]) : null,
        original ? h('span', { class: 'orig', lang: 'ja' }, word) : null,
        romaji ? h('span', { class: 'romaji', lang: 'ja-Latn' }, romaji[i]) : null))));
  }
  if (view.upcoming) {
    band.append(h('span', { class: 'next' }, '下一条：', view.upcoming.title || view.upcoming.text || ''),
      view.countdown !== null ? h('span', { class: 'count' }, view.imminent ? String(view.countdown) : `${view.countdown} 秒后`) : null);
  }
  if (!band.childNodes.length) band.append(h('span', { class: 'idle' }, state.audioURL ? '这里会显示正在进行的应援和下一条。' : '选择本地音频后开始。'));
}

// ---------------------------------------------------------------------------------------------
// Selection and the side panel's editor for one cheer.

function select(index) {
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
  if (!state.audioURL) { status('先选择本地音频，MIX 会插入到当前播放位置。', true); return; }
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
  if (!duration()) { status('先选择本地音频。', true); return; }
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
  $('song-duration').textContent = song.duration ? `时长 ${formatClock(song.duration)}` : '';
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
  $('lyrics-dialog').returnValue = '';
  $('lyrics-dialog').showModal();
}

function applyLyrics(text) {
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
  state.suggestions = null;
  changed();
  const count = state.lyrics ? state.lyrics.lines.length : 0;
  status(count ? `已加载 ${count} 行歌词${lyricLines().length ? '' : '（没有时间，只能显示）'}。` : '已清除歌词。', true);
}

async function lookupLyrics() {
  const song = chart().song;
  if (!song.title || !song.artist) { $('lyrics-result').textContent = '先填写歌名和艺人。'; return; }
  // As Liveglow does: no album in the exact lookup (catalogues name albums differently), then a
  // search by title with the same matching rule as cheer files (spec §8).
  const query = { title: song.title, artist: song.artist, duration: duration() || song.duration };
  $('lyrics-result').textContent = '正在查找…';
  if (state.lyricsLookup) state.lyricsLookup.abort();
  const lookup = new AbortController();
  state.lyricsLookup = lookup;
  const before = $('lyrics-text').value;
  const options = { referrerPolicy: 'no-referrer', signal: lookup.signal, credentials: 'omit' };
  try {
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
function importCheer(bytes, source, { path = null } = {}) {
  const result = cheer.parse(bytes, { sharedFile: false });
  if (!result.valid) { status(`无法打开${source}：${result.errors.slice(0, 2).map(M.issueMessage).join(' ')}`, true); return false; }
  if (state.ed && hasWorkToLose() && !confirm('打开这份应援会替换当前草稿（还没有保存到本机）。上一份草稿会留一份备份。继续？')) return false;
  backUpDraft();
  state.sourcePath = path;
  useChart(result.chart);
  state.dirty = false;
  saveDraft();
  const song = chart().song;
  const playing = { title: song.title, artist: song.artist, duration: audio.duration };
  const mismatch = state.audioURL && audio.duration && !cheer.matchSong({ title: song.title, artist: song.artist, duration: song.duration }, playing);
  const notes = result.warnings.length ? ' ' + result.warnings.map(M.issueMessage).join(' ') : '';
  status(`已打开${source}（${chart().events.length} 条应援）。${mismatch ? '注意：时长和当前音频对不上，可能不是同一个录音版本。' : ''}${notes}`, true);
  return true;
}

function fileName(song, suffix = '') {
  const base = P.folderName([song.artist, song.title].filter(Boolean).join(' - ') || '应援');
  return `${base}${suffix}.cheer.json`;
}

function saveLocal() {
  download(fileName(chart().song), E.serialize(chart()));
  markExported();
  status('已保存到本机下载文件夹。这份文件可以在映场里“导入…”。', true);
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
  const choice = shareChoice();
  $('share-referenced').hidden = choice.kind !== 'referenced';
  const author = $('share-author').value.trim();
  const prepared = E.prepareForSharing(chart(), author, choice);
  const outcome = E.shareOutcome(prepared, lyricTexts(), $('share-confirm').checked);
  $('share-confirm-row').hidden = outcome.kind !== 'unchecked' && !$('share-confirm').checked;
  let message = '', mode = null;
  if (outcome.kind === 'blocked') message = '还不能分享：' + outcome.issues.slice(0, 3).map(M.issueMessage).join(' ');
  else if (outcome.kind === 'unchecked') message = '没有加载带时间的歌词，无法核对文件里有没有歌词原文。确认没有后勾选上面的选项。';
  else if (outcome.kind === 'noteOnly') { message = '参考了别人的版本、又不确定原作者是否同意时，只能分享来源说明（作者和链接），不能分享时间轴。'; mode = 'note'; }
  else if (outcome.kind === 'file') {
    mode = 'file';
    message = choice.kind === 'referenced'
      ? '可以分享：会保留你和原作者的署名与链接。投稿时请在 Pull Request 里附上原作者同意的说明。'
      : '可以分享：自己听写的应援投稿到 CheerBook 默认以 CC BY 4.0 授权。';
  }
  if ($('share-outcome').textContent !== message) $('share-outcome').textContent = message;
  $('share-download').textContent = mode === 'note' ? '下载来源说明' : '下载分享文件';
  $('share-download').disabled = !mode;
  $('share-submit').disabled = mode !== 'file';
  const editing = shareTarget(prepared);
  $('share-submit').textContent = editing ? '提交修改…' : '投稿到 CheerBook…';
  return { prepared, outcome, mode, author, editing };
}

async function submitShare() {
  const { prepared, outcome, mode, author, editing } = renderShare();
  if (mode !== 'file') return;
  const content = outcome.text;
  if (editing) {
    // GitHub's edit page cannot be prefilled, so the new text goes to the clipboard (or a download).
    let copied = false;
    try { await navigator.clipboard.writeText(content); copied = true; } catch { download(fileName(prepared.song, ' (分享)'), content); }
    window.open(`${REPO}/edit/main/${editing.split('/').map(encodeURIComponent).join('/')}`, '_blank', 'noopener');
    markExported();
    status(`${copied ? '修改后的内容已复制到剪贴板' : '已下载修改后的文件'}，并打开了 GitHub 上原文件的编辑页面：全选、粘贴后按页面提示提交。改自己投稿的文件，检查通过后自动上线；改别人的文件要等维护者审核。`, true);
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

function tapTempo() {
  if (!state.audioURL || audio.paused) { status('边播放边跟着鼓点按 T（或点“跟拍 8 下”），连按 8 下。', true); return; }
  state.taps = state.taps || [];
  // Taps land late by the listener's reaction time, as the sticks do.
  state.taps.push(position() - state.ed.compensation);
  if (state.taps.length < 8) { status(`跟拍 ${state.taps.length} / 8`, true); return; }
  const grid = S.gridFromTaps(state.taps);
  state.taps = null;
  if (!grid) { status('跟拍不太稳，没能估出速度，再试一次。', true); return; }
  setGrid(grid, `节拍：${Math.round(grid.bpm)} BPM · 跟拍`);
  status(`已按跟拍对齐：${Math.round(grid.bpm)} BPM。`, true);
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
  if (mod && event.code === 'KeyZ') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
  if (mod) return;
  const { key, code } = event;
  if (code === 'Space') { if (editorSurface(event.target)) { event.preventDefault(); togglePlay(); } return; }
  if (key === 'ArrowLeft' || key === 'ArrowRight') { if (event.target.closest('input, select')) return; event.preventDefault(); seek(position() + (key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 5)); return; }
  if (key === 'Escape') {
    if (state.held.size) { dropHeld('已取消正在记录的这一下。'); return; }
    state.selected = null; renderTimeline(); renderSelected(); return;
  }
  if ((key === 'Delete' || key === 'Backspace') && state.selected !== null && editorSurface(event.target)) {
    event.preventDefault(); state.ed.removeEvent(state.selected); state.selected = null; status('已删除这一条（可以撤销）。', true); changed(); return;
  }
  if (root.dataset.mode === 'watch') return;
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
  $('rate').addEventListener('change', e => { audio.playbackRate = Number(e.target.value) || 1; });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('suggest').addEventListener('click', computeSuggestions);
  $('grid-double').addEventListener('click', () => adjustGrid('double'));
  $('grid-half').addEventListener('click', () => adjustGrid('half'));
  $('grid-shift').addEventListener('click', () => adjustGrid('shift'));
  $('save-local').addEventListener('click', saveLocal);
  $('toggle-mode').addEventListener('click', () => {
    const watching = root.dataset.mode !== 'watch';
    dropHeld('已取消正在记录的这一下。');
    root.dataset.mode = watching ? 'watch' : 'edit';
    $('toggle-mode').setAttribute('aria-pressed', String(watching));
    $('toggle-mode').textContent = watching ? '回到编辑' : '观看模式';
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
  $('tap-tempo').addEventListener('click', () => { $('more-dialog').close(); tapTempo(); });
  $('sort-events').addEventListener('click', () => { state.ed.sortEvents(); state.selected = null; changed(); });
  $('new-chart').addEventListener('click', () => {
    if (hasWorkToLose() && !confirm('新建空白应援会替换当前草稿（还没有保存到本机）。上一份草稿会留一份备份。继续？')) return;
    backUpDraft();
    state.dirty = false;
    state.sourcePath = null;
    useChart(newChart({ title: chart().song.title, artist: chart().song.artist, duration: duration() }));
    $('more-dialog').close();
    status('已新建空白应援。', true);
  });
  // Share.
  $('open-share').addEventListener('click', () => { $('share-confirm').checked = false; renderShare(); $('share-dialog').showModal(); });
  for (const input of document.querySelectorAll('#share-dialog input')) input.addEventListener('input', renderShare);
  $('share-download').addEventListener('click', () => {
    const { prepared, outcome, mode } = renderShare();
    if (mode === 'file') { download(fileName(prepared.song, ' (分享)'), outcome.text); markExported(); status('已下载分享文件。', true); }
    else if (mode === 'note') { download(fileName(prepared.song, ' (来源说明)').replace(/\.cheer\.json$/, '.txt'), outcome.note, 'text/plain;charset=utf-8'); status('已下载来源说明。', true); }
  });
  $('share-submit').addEventListener('click', submitShare);
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
  state.member = draft && typeof draft.member === 'string' && chart().members.some(member => member.id === draft.member) ? draft.member : null;
  state.sourcePath = draft && typeof draft.sourcePath === 'string' && draft.sourcePath.startsWith(P.LIBRARY_DIR + '/') ? draft.sourcePath : null;
  if (draft && typeof draft.lyricsText === 'string' && draft.lyricsText) { state.lyricsText = draft.lyricsText; applyLyrics(draft.lyricsText); state.dirty = !!draft.dirty; }
  if (draft && chart().events.length) status(`已恢复上次的草稿（${chart().events.length} 条应援）。重新选择音频“${draft.audioName || ''}”即可继续。`);
  else status('选择本地音频开始。音频只在你的浏览器里播放，不会上传。');
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
      if (reply.ok) importCheer(new Uint8Array(await reply.arrayBuffer()), '社区库里的这份应援', { path: plainPath ? path : null });
      else status('没能读取社区库里的这份应援。', true);
    } catch { status('没能读取社区库里的这份应援。', true); }
  }
  check.flush();
  renderAll();
  frame(true);
}

start();
