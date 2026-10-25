// CheerBook "制作 MIX" page (C-011): propose a generic MIX for the built-in library, or contribute
// an artist MIX. Every rule, path, template and the file text come from lib/mixes.js (bundled as
// /editor/lib.js); this file only wires them to the form. Nothing leaves the browser by itself: the
// page reads this site's MIX library and, with ?mix=, one artist MIX file of this site, and opens
// GitHub only when asked.
import lib from '/editor/lib.js';
import { h, clear, debounce, download, storage } from '/editor/dom.js';

const { cheer, mixes: X, paths: P, editor: E } = lib;

const REPO = 'https://github.com/alexpsz/cheerbook';
const DRAFT_KEY = 'cheerbook.mixform.draft.v1';
const URL_LIMIT = 7500;
const LICENSE_NAMES = { 'CC0-1.0': 'CC0', 'CC-BY-4.0': 'CC BY 4.0', 'CC-BY-SA-4.0': 'CC BY-SA 4.0' };
// The groups problems are shown next to (`data-group` in mix.html); a problem's field names one.
const GROUP_TITLES = {
  artist: '艺人', songs: '指定歌曲', name: '名称', kind: '种类', text: '口号', readings: '逐词读音', romaji: '整句罗马音', id: '编号',
  bars: '小节数', positions: '常见位置', note: '说明', readingNote: '读音说明', sources: '核对来源', retrieved: '读取日期', credits: '署名与来源',
};
const GROUPS = Object.keys(GROUP_TITLES);

const $ = id => document.getElementById(id);
const root = $('mixform');
const form = $('mf-form');

const isString = value => typeof value === 'string';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = value => (isString(value) ? value : '');
const strings = value => (Array.isArray(value) ? value.map(str) : []);
const blank = value => cheer.isBlank(str(value));
const clean = value => cheer.trimmed(str(value));
const licenseName = id => LICENSE_NAMES[id] || id;
const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

/** Today in the visitor's time zone, YYYY-MM-DD. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

let state = null;
const env = {
  library: null, libraryFailed: false, saved: null, current: null, previewKey: '', summaryKey: '', announced: null, readingNoteShown: false,
  // Problems show beside a group once it has been left or changed, or beside every group after a
  // file is opened or the visitor downloads; the summary always lists them all.
  touched: new Set(), showAll: false,
};

// ---------------------------------------------------------------------------------------------
// The form's state. One object holds both kinds' fields, so switching kinds loses nothing.

const COMMON = ['id', 'idEdited', 'name', 'kind', 'text', 'romaji', 'barsMin', 'barsMax', 'positions', 'note', 'readingNote', 'words', 'readings', 'readingsOn'];
const PROPOSAL_ONLY = ['sources', 'retrieved'];
const ARTIST_ONLY = ['artist', 'songs', 'authors', 'permission', 'license', 'creditSources', 'creditNote'];

/** The form's fields from a file's content (either format); a value of the wrong type reads as empty. */
function fromValue(value) {
  const credits = isObject(value.credits) ? value.credits : {};
  const readings = isObject(value.readings) ? value.readings : {};
  const words = X.chantWords(clean(value.text));
  const align = list => { const values = strings(list); return words.map((_, i) => values[i] ?? ''); };
  const bars = Array.isArray(value.bars) ? value.bars : [];
  const number = n => (Number.isFinite(n) ? String(n) : '');
  return {
    type: value.format === X.ARTIST_FORMAT ? 'artist' : 'proposal',
    id: str(value.id), idEdited: !blank(value.id),
    name: str(value.name), kind: value.kind === 'mix' || value.kind === 'call' ? value.kind : '',
    text: str(value.text), romaji: str(value.romaji),
    barsMin: number(bars[0]), barsMax: number(bars[1]),
    positions: Array.isArray(value.positions) ? [...new Set(value.positions.filter(position => X.POSITIONS.includes(position)))] : [],
    note: str(value.note), readingNote: str(value.readingNote),
    words, readings: { kana: align(readings.kana), romaji: align(readings.romaji) },
    readingsOn: { kana: Array.isArray(readings.kana), romaji: Array.isArray(readings.romaji) },
    sources: strings(value.sources), retrieved: str(value.retrieved),
    artist: str(value.artist), songs: strings(value.songs),
    authors: Array.isArray(credits.authors) ? credits.authors.map(author => ({ name: str(author?.name), url: str(author?.url) })) : [],
    permission: X.SHAREABLE.includes(credits.permission) ? credits.permission : '',
    license: P.LICENSES.includes(credits.license) ? credits.license : '',
    creditSources: Array.isArray(credits.sources) ? credits.sources.filter(isObject).map(source => ({ ...source })) : [],
    creditNote: str(credits.note),
    editPath: null,
  };
}

const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));

/** Rows the form always shows: two source pages, one author. */
function normalize(s) {
  while (s.sources.length < 2) s.sources.push('');
  if (!s.authors.length) s.authors.push({ name: '', url: '' });
  return s;
}

/** An empty form of `type`, from lib/mixes.js's templates; both readings columns start on. */
function blankState(type = 'proposal', artist = '') {
  const proposal = fromValue(X.newProposal());
  const artistMix = fromValue(X.newArtistMix(artist));
  return normalize({
    ...proposal, ...pick(artistMix, ARTIST_ONLY),
    type, idEdited: false, retrieved: today(), readingsOn: { kana: true, romaji: true }, editPath: null,
  });
}

/** The form for a file: its own kind's fields, the other kind's left empty. */
function stateFromFile(value) {
  const read = fromValue(value);
  const own = read.type === 'artist' ? ARTIST_ONLY : PROPOSAL_ONLY;
  const s = { ...blankState(read.type), ...pick(read, COMMON), ...pick(read, own), type: read.type };
  if (read.type === 'proposal') s.readingsOn = { kana: true, romaji: true };
  if (read.type === 'proposal' && blank(s.retrieved)) s.retrieved = today();
  return normalize(s);
}

/** A saved draft back into a form; anything unexpected is left at its empty value. */
function fromDraft(saved) {
  if (!isObject(saved) || saved.version !== 1 || !isObject(saved.form)) return null;
  const f = saved.form;
  const s = blankState(f.type === 'artist' ? 'artist' : 'proposal');
  for (const key of ['id', 'name', 'text', 'romaji', 'barsMin', 'barsMax', 'note', 'readingNote', 'retrieved', 'artist', 'creditNote']) if (isString(f[key])) s[key] = f[key];
  s.idEdited = f.idEdited === true;
  if (['mix', 'call', ''].includes(f.kind)) s.kind = f.kind;
  if (Array.isArray(f.positions)) s.positions = [...new Set(f.positions.filter(position => X.POSITIONS.includes(position)))];
  s.words = X.chantWords(clean(s.text));
  const readings = isObject(f.readings) ? f.readings : {};
  const align = list => { const values = strings(list); return s.words.map((_, i) => values[i] ?? ''); };
  s.readings = { kana: align(readings.kana), romaji: align(readings.romaji) };
  if (isObject(f.readingsOn)) s.readingsOn = { kana: f.readingsOn.kana !== false, romaji: f.readingsOn.romaji !== false };
  if (Array.isArray(f.sources)) s.sources = strings(f.sources);
  if (Array.isArray(f.songs)) s.songs = strings(f.songs);
  if (Array.isArray(f.authors)) s.authors = f.authors.filter(isObject).map(author => ({ name: str(author.name), url: str(author.url) }));
  if (X.SHAREABLE.includes(f.permission) || f.permission === '') s.permission = f.permission;
  if (P.LICENSES.includes(f.license) || f.license === '') s.license = f.license;
  if (Array.isArray(f.creditSources)) s.creditSources = f.creditSources.filter(isObject).map(source => ({ ...source }));
  if (isString(f.editPath) && f.editPath.startsWith(X.ARTISTS_DIR + '/') && f.editPath.endsWith(X.SUFFIX)) s.editPath = f.editPath;
  return normalize(s);
}

/** True when the form holds something the visitor wrote (an artist alone does not count). */
function hasContent(s) {
  const any = list => list.some(item => !blank(item));
  return [s.name, s.text, s.romaji, s.note, s.readingNote, s.creditNote].some(item => !blank(item)) ||
    (s.idEdited && !blank(s.id)) || any(s.readings.kana) || any(s.readings.romaji) || any(s.sources) || any(s.songs) ||
    s.authors.some(author => !blank(author.name) || !blank(author.url)) ||
    s.creditSources.some(source => !blank(source.url) || !blank(source.title));
}

const readingsOn = s => (s.type === 'proposal' ? { kana: true, romaji: true } : s.readingsOn);

// The one credits source the form edits: the first that is not the author's own ('self').
const linkIndex = s => s.creditSources.findIndex(source => source.kind !== 'self');
const hasSourceContent = source => !blank(source.url) || !blank(source.title);

// ---------------------------------------------------------------------------------------------
// The file: built from the form, checked and written by lib/mixes.js.

function barNumber(text) {
  if (blank(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function cleanSource(source) {
  const out = {};
  for (const key of X.SOURCE_KEYS) {
    if (source[key] === undefined) continue;
    const value = isString(source[key]) ? clean(source[key]) : source[key];
    if (value !== '') out[key] = value;
  }
  return out;
}

function buildCredits(s) {
  const credits = {
    authors: s.authors.map(author => {
      const out = { name: clean(author.name) };
      if (!blank(author.url)) out.url = clean(author.url);
      return out;
    }),
  };
  if (s.permission) credits.permission = s.permission;
  if (s.permission === 'original') {
    if (s.license && s.license !== P.DEFAULT_LICENSE) credits.license = s.license;
  } else if (s.license) credits.license = s.license;
  const sources = s.creditSources.filter(hasSourceContent).filter(source => s.permission !== 'original' || source.kind === 'self').map(cleanSource);
  if (sources.length) credits.sources = sources;
  if (!blank(s.creditNote)) credits.note = clean(s.creditNote);
  return credits;
}

/** The file's content as the form describes it; optional fields left empty are omitted. */
function buildValue(s = state) {
  const proposal = s.type === 'proposal';
  const value = proposal ? { format: X.PROPOSAL_FORMAT, version: X.VERSION } : { format: X.ARTIST_FORMAT, version: X.VERSION, artist: clean(s.artist) };
  if (!proposal) {
    const songs = s.songs.map(clean).filter(song => song !== '');
    if (songs.length) value.songs = songs;
  }
  value.id = clean(s.id);
  value.name = clean(s.name);
  value.kind = s.kind;
  value.text = clean(s.text);
  if (proposal || !blank(s.romaji)) value.romaji = clean(s.romaji);
  value.bars = [barNumber(s.barsMin), barNumber(s.barsMax)];
  value.positions = [...s.positions];
  if (!blank(s.note)) value.note = clean(s.note);
  const on = readingsOn(s);
  if (on.kana || on.romaji) {
    value.readings = {};
    if (on.kana) value.readings.kana = s.readings.kana.map(clean);
    if (on.romaji) value.readings.romaji = s.readings.romaji.map(clean);
  }
  if (!blank(s.readingNote)) value.readingNote = clean(s.readingNote);
  if (proposal) {
    value.sources = s.sources.map(clean);
    value.retrieved = s.retrieved;
  } else value.credits = buildCredits(s);
  return value;
}

const serialize = (value, type = state.type) => (type === 'proposal' ? X.serializeProposal(value) : X.serializeArtistMix(value));

function problemsOf(value) {
  const library = env.library || undefined;
  return state.type === 'proposal' ? X.proposalProblems(value, { library, today: today() }) : X.artistMixProblems(value, { library });
}

/** Where the file goes, and whether it is the site file this form was opened from. */
function target(value) {
  const path = state.type === 'proposal' ? X.proposalPath(value.id) : X.artistMixPath(value.artist, value.id);
  const editing = state.type === 'artist' && state.editPath !== null && P.nameKey(path) === P.nameKey(state.editPath);
  return { path, editing };
}

const fileName = value => `${X.ID.test(value.id) ? value.id : 'mix'}${X.SUFFIX}`;

// ---------------------------------------------------------------------------------------------
// Rendering the form from the state.

function status(message) {
  $('mf-status').textContent = message;
}

function renderKindHint() {
  $('mf-kind-hint').textContent = `MIX 是一串口号，最多 ${cheer.TEXT_LIMIT.mix} 字；call 是跟着歌喊的短句，最多 ${cheer.TEXT_LIMIT.call} 字。`;
}

function renderTypeParts() {
  root.dataset.type = state.type;
  for (const radio of document.querySelectorAll('input[name="mf-type"]')) radio.checked = radio.value === state.type;
  $('mf-id-hint').textContent = state.type === 'proposal'
    ? '会成为文件名 mix/proposals/<编号>.mix.json，收录后写作 tradition:<编号>。按罗马音自动生成，可以改；只用小写英文字母、数字和 . _ -。清空后重新自动生成。'
    : '会成为文件名 <编号>.mix.json，放在艺人的文件夹里。按罗马音自动生成，可以改；只用小写英文字母、数字和 . _ -。清空后重新自动生成。';
  $('mf-reading-note-group').hidden = state.type === 'artist' && !env.readingNoteShown;
  renderEditing();
}

function renderEditing() {
  const note = $('mf-editing');
  // Only an artist MIX is edited in place; as a proposal it would be a new file.
  note.hidden = state.editPath === null || state.type !== 'artist';
  note.textContent = state.editPath === null ? '' : `正在修改网站上的 ${state.editPath}。`;
}

function listInput(list, i, value, props) {
  return h('input', { value, spellcheck: 'false', dataset: { list, index: String(i), ...props.dataset }, ...props.attributes });
}

function renderSongs(focus = null) {
  const list = clear($('mf-songs'));
  state.songs.forEach((song, i) => {
    list.append(h('li', { class: 'mf-line' },
      listInput('songs', i, song, { dataset: { hint: 'mf-songs-hint' }, attributes: { 'aria-label': `歌名 ${i + 1}` } }),
      h('button', { type: 'button', 'aria-label': `删除歌名 ${i + 1}`, onclick: () => removeRow('songs', i) }, '删除')));
  });
  $('mf-add-song').disabled = state.songs.length >= X.SONG_LIMIT;
  focusRow('mf-songs', focus, 'mf-add-song');
}

function renderSources(focus = null) {
  const list = clear($('mf-sources'));
  state.sources.forEach((url, i) => {
    list.append(h('li', { class: 'mf-line' },
      listInput('sources', i, url, { dataset: { hint: 'mf-sources-hint' }, attributes: { type: 'url', inputmode: 'url', placeholder: 'https://', 'aria-label': `核对网页 ${i + 1}` } }),
      h('button', { type: 'button', 'aria-label': `删除核对网页 ${i + 1}`, disabled: state.sources.length <= 2, onclick: () => removeRow('sources', i) }, '删除')));
  });
  $('mf-add-source').disabled = state.sources.length >= X.SOURCE_LIMIT;
  focusRow('mf-sources', focus, 'mf-add-source');
}

function renderAuthors(focus = null) {
  const list = clear($('mf-authors'));
  state.authors.forEach((author, i) => {
    list.append(h('li', { class: 'mf-line mf-author' },
      listInput('authors', i, author.name, { dataset: { part: 'name', hint: 'mf-authors-hint' }, attributes: { 'aria-label': `作者 ${i + 1} 的名字`, placeholder: '名字', autocomplete: 'nickname' } }),
      listInput('authors', i, author.url, { dataset: { part: 'url', hint: 'mf-authors-hint' }, attributes: { type: 'url', inputmode: 'url', 'aria-label': `作者 ${i + 1} 的链接（可选）`, placeholder: 'https://（可选）' } }),
      h('button', { type: 'button', 'aria-label': `删除作者 ${i + 1}`, disabled: state.authors.length <= 1, onclick: () => removeRow('authors', i) }, '删除')));
  });
  $('mf-add-author').disabled = state.authors.length >= P.AUTHOR_LIMIT;
  focusRow('mf-authors', focus, 'mf-add-author');
}

/** After a row is added or removed: focus the row's first field, or the add button when none is left. */
function focusRow(listID, index, fallback) {
  if (index === null) return;
  const rows = $(listID).children;
  const row = index >= 0 ? rows[Math.min(index, rows.length - 1)] : null;
  (row ? row.querySelector('input') : $(fallback)).focus();
}

const RENDER_LIST = { songs: renderSongs, sources: renderSources, authors: renderAuthors };

function addRow(list) {
  state[list].push(list === 'authors' ? { name: '', url: '' } : '');
  RENDER_LIST[list](state[list].length - 1);
  schedule();
}

function removeRow(list, i) {
  state[list].splice(i, 1);
  RENDER_LIST[list](Math.min(i, state[list].length - 1));
  schedule();
}

function renderLicense() {
  const select = $('mf-license');
  const permission = state.permission;
  const options = [];
  if (permission === 'consented') options.push(['', '不写（按原作者同意的条件）']);
  else if (permission !== 'original') options.push(['', '请选择']);
  const order = [P.DEFAULT_LICENSE, ...P.LICENSES.filter(id => id !== P.DEFAULT_LICENSE)];
  for (const id of order) options.push([id, licenseName(id) + (permission === 'original' && id === P.DEFAULT_LICENSE ? '（默认）' : '')]);
  const key = JSON.stringify(options);
  if (select.dataset.key !== key) {
    clear(select);
    for (const [value, label] of options) select.append(h('option', { value }, label));
    select.dataset.key = key;
  }
  select.value = permission === 'original' ? state.license || P.DEFAULT_LICENSE : state.license;
  $('mf-license-hint').textContent = {
    original: `投稿后按这个许可公开；默认 ${licenseName(P.DEFAULT_LICENSE)}（别人可以使用，需要署名）。`,
    'open-license': '你用到的原作所用的开放许可，必选。',
    consented: '原作者同意时约定了许可就选上；没有约定就不写。',
  }[permission] || '先选上面的一项。';
}

function renderCredits() {
  for (const radio of form.querySelectorAll('input[name="mf-permission"]')) radio.checked = radio.value === state.permission;
  renderLicense();
  const original = state.permission === 'original';
  $('mf-source-row').hidden = original || !state.permission;
  const index = linkIndex(state);
  const link = $('mf-source-link');
  const url = index >= 0 ? str(state.creditSources[index].url) : '';
  if (link.value !== url && document.activeElement !== link) link.value = url;
  $('mf-source-hint').textContent = state.permission === 'consented'
    ? '原作的网页。投稿时请在 Pull Request 的说明里写明原作者同意转载（例如附上对方同意的帖子链接）。'
    : '能看到原作和它的许可的网页。';
  const others = state.creditSources.filter((source, i) => hasSourceContent(source) && (original ? source.kind !== 'self' : i !== index)).length;
  const extra = $('mf-extra-sources');
  extra.hidden = others === 0;
  extra.textContent = original
    ? `选“自己创作”时不写别人的来源：已有的 ${others} 个来源不会写进文件。`
    : `导入的文件里另有 ${others} 个来源，会原样保留。`;
}

/** The readings table: one row per word, a column for each kind of reading that is on. */
function renderReadings() {
  const body = $('mf-readings');
  const on = readingsOn(state);
  const active = document.activeElement;
  const focus = body.contains(active) ? { row: active.dataset.row, column: active.dataset.column, start: active.selectionStart, end: active.selectionEnd } : null;
  clear(body);
  const any = on.kana || on.romaji;
  $('mf-use-kana').checked = state.readingsOn.kana;
  $('mf-use-romaji').checked = state.readingsOn.romaji;
  $('mf-readings-empty').hidden = state.words.length > 0 || !any;
  $('mf-readings-off').hidden = any;
  $('mf-readings-wrap').hidden = !state.words.length || !any;
  for (const cell of root.querySelectorAll('th[data-column]')) cell.hidden = !on[cell.dataset.column];
  const titles = { kana: '平假名', romaji: '罗马音' };
  state.words.forEach((word, i) => {
    const cell = column => (on[column] ? h('td', {}, h('input', {
      value: state.readings[column][i] ?? '', lang: column === 'kana' ? 'ja' : 'ja-Latn', spellcheck: 'false',
      'aria-label': `第 ${i + 1} 个词“${word}”的${titles[column]}`, dataset: { row: String(i), column, hint: 'mf-readings-hint' },
    })) : null);
    body.append(h('tr', {}, h('th', { scope: 'row', lang: 'ja' }, h('span', { class: 'mf-word' }, word)), cell('kana'), cell('romaji')));
  });
  if (focus) {
    const input = body.querySelector(`input[data-row="${focus.row}"][data-column="${focus.column}"]`);
    if (input) {
      input.focus();
      try { input.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
    }
  }
}

/** Puts the whole state into the form, after loading a draft, a file or a blank form. */
function fillForm() {
  env.readingNoteShown = !blank(state.readingNote);
  renderTypeParts();
  for (const input of form.querySelectorAll('[data-bind]')) {
    input.value = state[input.dataset.bind] ?? '';
    // A date or number field drops a value it cannot show; the state follows what is shown.
    if (input.type === 'date' || input.type === 'number') state[input.dataset.bind] = input.value;
  }
  for (const radio of form.querySelectorAll('input[name="mf-kind"]')) radio.checked = radio.value === state.kind;
  for (const box of form.querySelectorAll('input[name="mf-positions"]')) box.checked = state.positions.includes(box.value);
  $('mf-credit-note').value = state.creditNote;
  $('mf-source-link').value = '';
  renderKindHint();
  renderSongs();
  renderSources();
  renderAuthors();
  renderCredits();
  renderReadings();
  renderEditing();
  env.previewKey = '';
  env.summaryKey = '';
}

// ---------------------------------------------------------------------------------------------
// Live checking, preview and file text.

/** New words keep their readings: by position while the count is the same, else by equal word. */
function realign(oldWords, newWords, readings) {
  const sameCount = oldWords.length === newWords.length;
  const used = new Set();
  const from = newWords.map((word, i) => {
    const j = sameCount ? i : oldWords.findIndex((old, k) => old === word && !used.has(k));
    if (j >= 0) used.add(j);
    return j;
  });
  const take = list => from.map(j => (j >= 0 ? list[j] ?? '' : ''));
  return { kana: take(readings.kana), romaji: take(readings.romaji) };
}

function syncWords() {
  const words = X.chantWords(clean(state.text));
  if (sameList(words, state.words)) return;
  state.readings = realign(state.words, words, state.readings);
  state.words = words;
  renderReadings();
}

function autoID() {
  if (state.idEdited) return;
  const on = readingsOn(state);
  const romaji = !blank(state.romaji) ? clean(state.romaji) : on.romaji ? state.readings.romaji.map(clean).filter(Boolean).join(' ') : '';
  const id = X.suggestedID(romaji);
  if (id !== state.id) state.id = id;
  if ($('mf-id').value !== id) $('mf-id').value = id;
}

function groupOf(field) {
  const top = str(field).split(/[.[]/)[0];
  return GROUPS.includes(top) ? top : null;
}

const textual = control => control.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="file"])');

/** The controls a group's problems point at, so only those are marked invalid. */
function invalidControls(name, list, group) {
  const controls = [...group.querySelectorAll('input:not([type="file"]), select, textarea')];
  const texts = controls.filter(textual);
  const empty = texts.filter(control => blank(control.value));
  switch (name) {
    case 'readings': case 'songs': return empty.length ? empty : texts;
    case 'sources': {
      const bad = texts.filter(control => !cheer.isWebURL(clean(control.value)));
      return bad.length ? bad : texts;
    }
    case 'credits': {
      const fields = new Set(list.map(problem => problem.field.replace(/\[\d+\].*$/, '')));
      const out = [];
      if (fields.has('credits.authors')) {
        const names = [...$('mf-authors').querySelectorAll('input[data-part="name"]')].filter(control => blank(control.value));
        const urls = [...$('mf-authors').querySelectorAll('input[data-part="url"]')].filter(control => !blank(control.value) && !cheer.isWebURL(clean(control.value)));
        out.push(...(names.length || urls.length ? [...names, ...urls] : $('mf-authors').querySelectorAll('input')));
      }
      if (fields.has('credits.permission')) out.push(...form.querySelectorAll('input[name="mf-permission"]'));
      if (fields.has('credits.license')) out.push($('mf-license'));
      if (fields.has('credits.sources')) out.push($('mf-source-link'));
      if (fields.has('credits.note')) out.push($('mf-credit-note'));
      return out.length ? out : controls;
    }
    default: return controls;
  }
}

function renderFieldProblems(problems) {
  const byGroup = new Map();
  for (const problem of problems) {
    const group = groupOf(problem.field);
    if (!group || !(env.showAll || env.touched.has(group))) continue;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(problem);
  }
  for (const group of root.querySelectorAll('[data-group]')) {
    const name = group.dataset.group;
    const list = byGroup.get(name) || [];
    const box = $('mf-err-' + name);
    const key = JSON.stringify(list.map(problem => problem.message));
    if (box.dataset.key !== key) {
      clear(box);
      for (const problem of list) box.append(h('p', {}, problem.message));
      box.hidden = !list.length;
      box.dataset.key = key;
    }
    const bad = new Set(list.length ? invalidControls(name, list, group) : []);
    for (const control of group.querySelectorAll('input:not([type="file"]), select, textarea')) {
      const described = [control.dataset.hint, list.length ? box.id : ''].filter(Boolean).join(' ');
      if ((control.getAttribute('aria-describedby') || '') !== described) {
        if (described) control.setAttribute('aria-describedby', described);
        else control.removeAttribute('aria-describedby');
      }
      if (bad.has(control)) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    }
  }
}

function focusGroup(name) {
  if (!env.touched.has(name)) { env.touched.add(name); schedule.flush(); }
  const group = root.querySelector(`[data-group="${name}"]`);
  const control = group && (group.querySelector('[aria-invalid="true"]') ||
    [...group.querySelectorAll('input:not([type="file"]), select, textarea, button')].find(item => item.offsetParent !== null));
  (control || (name === 'readings' ? $('mf-text') : null))?.focus();
}

function renderSummary(problems) {
  const notice = env.libraryFailed ? '没能读取内置 MIX 库，所以没有检查是否与库里的口号或编号重复。' : env.library ? '' : '正在读取内置 MIX 库…';
  const key = JSON.stringify([problems.map(problem => problem.message), notice]);
  if (key === env.summaryKey) return;
  env.summaryKey = key;
  const box = clear($('mf-summary'));
  box.classList.toggle('ok', problems.length === 0);
  if (!problems.length) box.append(h('p', { class: 'mf-summary-title' }, '没有发现问题，可以下载或投稿。'));
  else {
    box.append(h('p', { class: 'mf-summary-title' }, `还有 ${problems.length} 个问题`),
      h('ul', {}, problems.map(problem => {
        const group = groupOf(problem.field);
        return h('li', {}, problem.message, group ? h('button', { type: 'button', class: 'mf-jump', 'aria-label': `转到“${GROUP_TITLES[group]}”`, onclick: () => focusGroup(group) }, '转到') : null);
      })));
  }
  if (notice) box.append(h('p', { class: 'mf-hint' }, notice));
}

// The count is announced through one polite live region, once typing pauses, and only when it changes.
const announce = debounce(text => {
  if (text === env.announced) return;
  env.announced = text;
  $('mf-live').textContent = text;
}, 1200);

/** Text with name slots shown as a placeholder (the editor fills them with the member's name). */
function slotted(text) {
  const tokens = cheer.parseSlots(text);
  if (!tokens) return [text];
  return tokens.map(token => (Object.hasOwn(token, 'literal') ? token.literal : h('span', { class: 'mf-slot' }, token.name === null ? '成员名' : token.name)));
}

function renderPreview(value) {
  const key = JSON.stringify([state.type, value.name, value.kind, value.text, value.romaji, value.readings, value.bars, value.positions, value.note, value.artist, value.songs]);
  if (key === env.previewKey) return;
  env.previewKey = key;
  const box = clear($('mf-preview'));
  const words = X.chantWords(value.text);
  const kind = value.kind === 'call' ? 'call' : 'mix';
  box.append(h('div', { class: 'mf-preview-head' },
    h('span', { class: 'mf-preview-name', lang: 'ja' }, value.name || '（还没有名称）'),
    h('span', { class: 'badge' }, kind === 'call' ? 'CALL' : 'MIX')));
  const band = h('div', { class: 'band mf-band', role: 'group', 'aria-label': '应援条预览' });
  if (words.length) {
    const readings = value.readings || {};
    const fits = list => (Array.isArray(list) && list.length === words.length ? list : null);
    const kana = fits(readings.kana), romaji = fits(readings.romaji);
    band.append(h('span', { class: 'item' },
      h('span', { class: 'kind meta' }, E.eventLabel(kind)),
      words.map((word, i) => h('span', { class: 'w on' },
        kana ? h('span', { class: 'kana', lang: 'ja' }, slotted(kana[i])) : null,
        h('span', { class: 'orig', lang: 'ja' }, slotted(word)),
        romaji ? h('span', { class: 'romaji', lang: 'ja-Latn' }, slotted(romaji[i])) : null))));
  } else band.append(h('span', { class: 'idle' }, '填好口号后，这里显示应援条上的样子。'));
  box.append(band);
  if (value.romaji) box.append(h('p', { class: 'mf-preview-romaji', lang: 'ja-Latn' }, slotted(value.romaji)));
  const facts = [];
  const [low, high] = value.bars;
  if (Number.isInteger(low) && Number.isInteger(high)) facts.push(['长度', low === high ? `约 ${low} 小节` : `约 ${low}–${high} 小节`]);
  facts.push(['常见位置', value.positions.length ? value.positions.map(position => X.POSITION_TITLES[position]).join('、') : '不参与推荐']);
  if (value.note) facts.push(['说明', value.note]);
  if (state.type === 'artist') {
    const artist = value.artist || '（还没有艺人）';
    facts.push(['适用', value.songs ? `${artist}：${value.songs.join('、')}` : `${artist} 的所有歌`]);
  }
  box.append(h('dl', { class: 'facts mf-facts' }, facts.flatMap(([term, detail]) => [h('dt', {}, term), h('dd', {}, detail)])));
}

function renderActions(value, problems) {
  const { path, editing } = target(value);
  const submit = $('mf-submit');
  const label = editing ? '提交修改' : '投稿到 GitHub';
  if (submit.textContent !== label) submit.textContent = label;
  submit.disabled = problems.length > 0;
  let note;
  if (problems.length) note = `还有 ${problems.length} 个问题，改好后才能投稿。下载的文件可以留着以后再改。`;
  else if (editing) note = `会复制文件内容，并打开 GitHub 上 ${state.editPath} 的编辑页：全选原内容、粘贴，再提议修改。修改自己投稿的文件，检查通过后自动合并；修改别人的文件要等维护者审核。`;
  else {
    note = `会打开 GitHub 的新建文件页，文件名 ${path}，内容已填好；登录后提交 Pull Request，由维护者审核。`;
    if (state.editPath !== null) note += `这会成为一个新文件；原来的 ${state.editPath} 会保留，除非你另外删除它。`;
  }
  if (!problems.length && state.type === 'artist' && state.permission === 'consented') note += '记得在 Pull Request 的说明里写明原作者同意转载。';
  if ($('mf-submit-note').textContent !== note) $('mf-submit-note').textContent = note;
}

function saveDraft() {
  storage.set(DRAFT_KEY, { version: 1, form: state, saved: env.saved });
}

function refresh() {
  syncWords();
  autoID();
  const value = buildValue();
  const problems = problemsOf(value);
  const text = serialize(value);
  env.current = { value, problems, text };
  renderFieldProblems(problems);
  renderSummary(problems);
  renderPreview(value);
  if ($('mf-file').value !== text) $('mf-file').value = text;
  renderActions(value, problems);
  const count = problems.length ? `还有 ${problems.length} 个问题` : '没有发现问题';
  if (env.announced === null) env.announced = count;
  else announce(count);
  saveDraft();
}

const schedule = debounce(refresh, 150);
const isDirty = () => hasContent(state) && env.current !== null && env.current.text !== env.saved;

// ---------------------------------------------------------------------------------------------
// Editing.

function touch(event) {
  const group = event.target instanceof Element ? event.target.closest('[data-group]') : null;
  if (!group || env.touched.has(group.dataset.group)) return;
  env.touched.add(group.dataset.group);
  schedule();
}

function onEdit(event) {
  const t = event.target;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
  if (event.type === 'change') touch(event);
  if (t.dataset.bind) {
    state[t.dataset.bind] = t.value;
    if (t.dataset.bind === 'id') {
      // Typing takes the id over; leaving it empty hands it back to the suggestion.
      if (event.type === 'input') state.idEdited = true;
      else if (blank(t.value)) state.idEdited = false;
    }
  } else if (t.dataset.list) {
    const i = Number(t.dataset.index);
    if (t.dataset.list === 'authors') state.authors[i] = { ...state.authors[i], [t.dataset.part]: t.value };
    else state[t.dataset.list][i] = t.value;
  } else if (t.dataset.row !== undefined && t.dataset.column) {
    state.readings[t.dataset.column][Number(t.dataset.row)] = t.value;
  } else if (t.name === 'mf-kind') {
    state.kind = t.value;
  } else if (t.name === 'mf-positions') {
    state.positions = state.positions.filter(position => position !== t.value);
    if (t.checked) state.positions.push(t.value);
  } else if (t.id === 'mf-use-kana' || t.id === 'mf-use-romaji') {
    state.readingsOn = { ...state.readingsOn, [t.id === 'mf-use-kana' ? 'kana' : 'romaji']: t.checked };
    renderReadings();
  } else if (t.name === 'mf-permission') {
    state.permission = t.value;
    renderCredits();
  } else if (t.id === 'mf-license') {
    state.license = state.permission === 'original' && t.value === P.DEFAULT_LICENSE ? '' : t.value;
  } else if (t.id === 'mf-source-link') {
    const index = linkIndex(state);
    if (index >= 0) state.creditSources[index] = { ...state.creditSources[index], url: t.value };
    else state.creditSources.push({ kind: 'other', url: t.value });
  } else if (t.id === 'mf-credit-note') {
    state.creditNote = t.value;
  } else return;
  schedule();
}

function setType(type) {
  if (type === state.type) return;
  state.type = type;
  env.readingNoteShown = !blank(state.readingNote);
  normalize(state);
  renderTypeParts();
  renderCredits();
  renderReadings();
  schedule.flush();
}

// ---------------------------------------------------------------------------------------------
// Opening files: a local import, or an artist MIX of this site (?mix=).

/** Fields of the file the form could not take, so the visitor knows they are gone. */
function dropped(raw, built) {
  const out = Object.keys(raw).filter(key => built[key] === undefined);
  if (isObject(raw.credits) && isObject(built.credits)) {
    for (const key of Object.keys(raw.credits)) {
      const implied = key === 'license' && raw.credits.license === P.DEFAULT_LICENSE && built.credits.permission === 'original';
      if (built.credits[key] === undefined && !implied) out.push('credits.' + key);
    }
  }
  return out;
}

/** Replaces the form with a file's content; returns a note about anything that did not carry over. */
function useFile(value, editPath = null) {
  state = stateFromFile(value);
  state.editPath = editPath;
  env.showAll = true;
  fillForm();
  schedule.flush();
  env.saved = env.current.text;
  saveDraft();
  const notes = [];
  const lost = dropped(value, env.current.value);
  if (lost.length) notes.push(`这些字段是空的或不认识，已略去：${lost.join('、')}。`);
  const words = X.chantWords(clean(value.text)).length;
  const readings = isObject(value.readings) ? value.readings : {};
  if ([readings.kana, readings.romaji].some(list => Array.isArray(list) && list.length !== words)) notes.push('读音的个数与口号的词数不同，已按词对齐，请核对。');
  return notes.join('');
}

const FORMAT_HINT = `format 须为 "${X.PROPOSAL_FORMAT}"（通用 MIX 提议）或 "${X.ARTIST_FORMAT}"（艺人专属 MIX）`;

async function importFile(file) {
  // Only the first bytes past the limit are read: readFile refuses the file by its size anyway.
  const bytes = new Uint8Array(await file.slice(0, X.MAX_BYTES + 1).arrayBuffer());
  const result = X.readFile(bytes);
  if (result.problems) { status(`无法打开 ${file.name}：${result.problems.map(problem => problem.message).join(' ')}`); return; }
  const value = result.value;
  if (!isObject(value) || (value.format !== X.PROPOSAL_FORMAT && value.format !== X.ARTIST_FORMAT)) { status(`无法打开 ${file.name}：${FORMAT_HINT}。`); return; }
  schedule.flush();
  if (isDirty() && !confirm('导入会替换当前填写的内容（还没有下载或投稿）。继续？')) return;
  const note = useFile(value);
  status(`已打开 ${file.name}（${value.format === X.ARTIST_FORMAT ? '艺人专属 MIX' : '通用 MIX 提议'}）。${note}`);
}

/**
 * `?mix=`: a same-origin path under /mix/artists/ ending in .mix.json, or null. The URL parser
 * resolves plain dot segments; encoded ones ("..%2F") and backslashes are refused after decoding.
 * Names may hold ".." inside a segment (an id like "a..b" is valid), so only whole segments count.
 */
function siteFile(param) {
  let url, decoded;
  try {
    url = new URL(param, location.href);
    decoded = decodeURIComponent(url.pathname);
  } catch { return null; }
  if (url.origin !== location.origin) return null;
  if (!decoded.startsWith('/' + X.ARTISTS_DIR + '/') || !decoded.endsWith(X.SUFFIX)) return null;
  const raw = (() => { try { return decodeURIComponent(param); } catch { return ''; } })();
  const dotted = text => text.split(/[/\\]/).some(part => part === '.' || part === '..');
  if (!raw || dotted(raw) || dotted(decoded) || decoded.includes('\\') || decoded.includes('//')) return null;
  return { fetchPath: url.pathname, repoPath: decoded.slice(1) };
}

async function openSiteFile(param) {
  const file = siteFile(param);
  if (!file) { status('链接里的 mix 参数不是本站 /mix/artists/ 下的 .mix.json 文件，没有打开。'); return; }
  let result;
  try {
    const reply = await fetch(file.fetchPath);
    if (!reply.ok) { status(reply.status === 404 ? `网站上没有 ${file.repoPath}（可能已改名或下架）。` : `没能读取 ${file.repoPath}（服务器返回 ${reply.status}）。`); return; }
    result = X.readFile(new Uint8Array(await reply.arrayBuffer()));
  } catch {
    status(`没能读取 ${file.repoPath}，请检查网络后刷新。`);
    return;
  }
  if (result.problems) { status(`无法打开 ${file.repoPath}：${result.problems.map(problem => problem.message).join(' ')}`); return; }
  if (!isObject(result.value) || result.value.format !== X.ARTIST_FORMAT) { status(`${file.repoPath} 不是艺人专属 MIX 文件，没有打开。`); return; }
  const next = stateFromFile(result.value);
  if (hasContent(state) && serialize(buildValue(state), state.type) !== serialize(buildValue(next), next.type) &&
      !confirm(`打开网站上的 ${file.repoPath} 会替换这个浏览器里的草稿。继续？`)) {
    status('没有打开网站上的文件，继续编辑草稿。');
    return;
  }
  const note = useFile(result.value, file.repoPath);
  status(`已打开 ${file.repoPath}。改好后点“提交修改”。${note}`);
}

// ---------------------------------------------------------------------------------------------
// Download and submit.

function downloadFile() {
  env.showAll = true;
  schedule.flush();
  const { value, problems, text } = env.current;
  download(fileName(value), text);
  env.saved = text;
  saveDraft();
  status(problems.length ? `已下载 ${fileName(value)}；文件还有 ${problems.length} 个问题，投稿前要改好。` : `已下载 ${fileName(value)}。`);
}

async function submitFile() {
  env.showAll = true;
  schedule.flush();
  const { value, problems, text } = env.current;
  if (problems.length) return;
  const { path, editing } = target(value);
  let copied = false;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); copied = true; } catch { download(fileName(value), text); }
  };
  if (editing) {
    await copy();
    window.open(`${REPO}/edit/main/${state.editPath.split('/').map(encodeURIComponent).join('/')}`, '_blank', 'noopener');
    status((copied ? '内容已复制到剪贴板，并打开了 GitHub 上这份文件的编辑页' : '没能复制到剪贴板，已下载文件，并打开了 GitHub 上这份文件的编辑页（把下载文件的内容粘贴进去）') +
      '：全选原内容、粘贴，再提议修改（Propose changes）。修改自己投稿的文件，检查通过后自动合并；修改别人的文件要等维护者审核。');
  } else {
    const base = `${REPO}/new/main?filename=${encodeURIComponent(path)}`;
    const full = `${base}&value=${encodeURIComponent(text)}`;
    if (full.length <= URL_LIMIT) {
      window.open(full, '_blank', 'noopener');
      status('已打开 GitHub 的新建文件页（文件名和内容已填好）。登录后按页面提示提交 Pull Request。');
    } else {
      await copy();
      window.open(base, '_blank', 'noopener');
      status(copied ? '文件较长，内容已复制到剪贴板：在打开的 GitHub 页面里粘贴，然后提交 Pull Request。' : '文件较长，已下载文件：在打开的 GitHub 页面里粘贴文件内容，然后提交 Pull Request。');
    }
  }
  env.saved = text;
  saveDraft();
}

// ---------------------------------------------------------------------------------------------
// Start.

function wire() {
  const positions = $('mf-positions');
  for (const position of X.POSITIONS) {
    positions.append(h('label', {}, h('input', { type: 'checkbox', name: 'mf-positions', value: position, dataset: { hint: 'mf-positions-hint' } }), ' ' + X.POSITION_TITLES[position]));
  }
  // The hints a control is always described by; problems are added to them while there are any.
  for (const control of form.querySelectorAll('[aria-describedby]')) control.dataset.hint = control.getAttribute('aria-describedby');
  form.addEventListener('input', onEdit);
  form.addEventListener('change', onEdit);
  form.addEventListener('focusout', touch);
  form.addEventListener('submit', event => event.preventDefault());
  for (const radio of document.querySelectorAll('input[name="mf-type"]')) radio.addEventListener('change', () => { if (radio.checked) setType(radio.value); });
  $('mf-add-song').addEventListener('click', () => addRow('songs'));
  $('mf-add-source').addEventListener('click', () => addRow('sources'));
  $('mf-add-author').addEventListener('click', () => addRow('authors'));
  $('mf-import').addEventListener('click', () => $('mf-import-file').click());
  $('mf-import-file').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) importFile(file).catch(() => status(`没能读取 ${file.name}。`));
  });
  $('mf-reset').addEventListener('click', () => {
    schedule.flush();
    if (hasContent(state) && !confirm('清空所有填写的内容，重新开始？（已下载的文件不受影响）')) return;
    state = blankState(state.type);
    env.saved = null;
    env.touched.clear();
    env.showAll = false;
    fillForm();
    schedule.flush();
    status('已清空。');
    $(state.type === 'artist' ? 'mf-artist' : 'mf-name').focus();
  });
  $('mf-download').addEventListener('click', downloadFile);
  $('mf-submit').addEventListener('click', () => { submitFile().catch(() => status('没能打开 GitHub，请稍后再试。')); });
  addEventListener('pagehide', () => { if (schedule.pending()) schedule.flush(); });
}

async function loadLibrary() {
  try {
    const reply = await fetch('/spec/mix-library.json');
    if (!reply.ok) throw new Error(String(reply.status));
    const library = await reply.json();
    if (!isObject(library) || !Array.isArray(library.entries)) throw new Error('not a library');
    env.library = library;
  } catch {
    env.libraryFailed = true;
  }
  schedule.flush();
}

async function start() {
  wire();
  const params = new URLSearchParams(location.search);
  const typeParam = params.get('type');
  const artistParam = params.get('artist');
  const mixParam = params.get('mix');
  if (typeParam !== null || artistParam !== null || mixParam !== null) {
    // The parameters are applied once; a reload continues from the draft.
    history.replaceState(history.state, '', location.pathname + location.hash);
  }
  const saved = storage.get(DRAFT_KEY);
  const draft = fromDraft(saved);
  env.saved = draft && isString(saved.saved) ? saved.saved : null;
  const type = typeParam === 'artist' || typeParam === 'proposal' ? typeParam : artistParam !== null ? 'artist' : null;
  const artist = artistParam !== null ? clean(artistParam) : '';
  let message = '';
  if (mixParam !== null || !draft || !hasContent(draft)) {
    state = mixParam === null || !draft ? blankState(type || (mixParam !== null ? 'artist' : draft ? draft.type : 'proposal'), artist) : draft;
    if (mixParam === null && draft && !artist && !blank(draft.artist)) state.artist = draft.artist;
  } else if (artist && cheer.normalizedName(artist) !== cheer.normalizedName(draft.artist)) {
    const current = draft.type === 'artist' && !blank(draft.artist) ? `“${clean(draft.artist)}”的专属 MIX` : '一条通用 MIX 提议';
    if (confirm(`链接要为“${artist}”做一条专属 MIX。当前草稿是${current}，要清空它重新开始吗？取消则继续编辑草稿。`)) {
      state = blankState('artist', artist);
      env.saved = null;
    } else {
      state = draft;
      message = '继续编辑这个浏览器里的草稿。';
    }
  } else {
    state = draft;
    if (type) state.type = type;
    message = '已恢复这个浏览器里的草稿。';
  }
  normalize(state);
  env.showAll = hasContent(state);
  fillForm();
  refresh();
  if (message) status(message);
  if (mixParam !== null) await openSiteFile(mixParam);
  root.dataset.ready = 'true';
  loadLibrary();
}

start();
