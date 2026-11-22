'use strict';
// Historical author records support manual review. Auto-merge classifies the complete
// change set independently of the identity that opened the pull request.
// Pure: no Node APIs, so it can be bundled for the browser.

const FORMAT = 'cheerbook-contributors';
const VERSION = 1;
// Where contributions live (CONTRIBUTING.md §3); no file outside these is ever recorded.
const CONTRIBUTION_AREAS = Object.freeze([
  Object.freeze({ folder: 'cheers/', extension: '.cheer.json' }),
  Object.freeze({ folder: 'mix/artists/', extension: '.mix.json' }),
]);
// A commit id: SHA-1, or SHA-256 for repositories that use it.
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// GitHub logins are letters, digits and hyphens; apps end in "[bot]". This is a little looser than
// GitHub so that an unusual old account never breaks the record, but it never lets through spaces,
// slashes or markup.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/;
// Control characters and backslashes, which no file in the library may have in its path.
const UNSAFE_PATH = /[\x00-\x1F\x7F\\]/;
const MAX_PATH = 1000;
// Line breaks that JSON.stringify leaves as they are: NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR.
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'gu');

/** Text from a pull request or the repository inside a log line: quoted, line breaks escaped. */
const quote = value => JSON.stringify(String(value)).replace(LINE_BREAKS, c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAccountId = id => Number.isSafeInteger(id) && id > 0;
const isCommit = value => typeof value === 'string' && SHA.test(value);

/** `{ id, login }` of a GitHub account: a positive whole-number id and a login. */
function isAccount(user) {
  return isObject(user) && isAccountId(user.id) && typeof user.login === 'string' && LOGIN.test(user.login);
}

/** True for a file under cheers/ ending in .cheer.json or under mix/artists/ ending in .mix.json. */
function isContributionPath(file) {
  if (typeof file !== 'string' || file.length > MAX_PATH || UNSAFE_PATH.test(file)) return false;
  if (file.split('/').some(part => part === '' || part === '.' || part === '..')) return false;
  return CONTRIBUTION_AREAS.some(({ folder, extension }) =>
    file.startsWith(folder) && file.endsWith(extension) && file.length > folder.length + extension.length);
}

function invalid(message) {
  return Object.assign(new Error(`contributors.json ${message}`), { code: 'invalidContributors' });
}

/**
 * Throws a clear error unless `model` is a contributors model:
 * `{ format, version, recordedThrough?, files: { <path>: { id, login } } }`. `recordedThrough` is
 * the commit on main whose changes the records include (tools/record-contributors.js continues
 * from it, so a run that failed or was cancelled is caught up by the next one).
 */
function checkModel(model) {
  if (!isObject(model)) throw invalid('须为 JSON 对象。');
  for (const key of Object.keys(model)) {
    if (key !== 'format' && key !== 'version' && key !== 'recordedThrough' && key !== 'files') throw invalid(`有未知的字段 ${quote(key)}。`);
  }
  if (model.format !== FORMAT || model.version !== VERSION) throw invalid(`的 format 须为 ${quote(FORMAT)}，version 须为 ${VERSION}。`);
  if (model.recordedThrough !== undefined && !isCommit(model.recordedThrough)) throw invalid('的 recordedThrough 须为完整的提交编号。');
  if (!isObject(model.files)) throw invalid('缺少 files 对象。');
  for (const [file, record] of Object.entries(model.files)) {
    if (!isContributionPath(file)) throw invalid(`中的 ${quote(file)} 不是 cheers/ 下的 .cheer.json 或 mix/artists/ 下的 .mix.json 文件。`);
    if (!isObject(record) || Object.keys(record).some(key => key !== 'id' && key !== 'login') || !isAccount(record)) {
      throw invalid(`中 ${quote(file)} 的记录须为 { "id": GitHub 账号的数字编号, "login": 账号名 }。`);
    }
  }
  return model;
}

/** A model whose `files` holds `entries` ([path, record] pairs) in path order. */
function build(entries, recordedThrough) {
  const files = {};
  for (const [file, record] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    files[file] = { id: record.id, login: record.login };
  }
  return recordedThrough === undefined ? { format: FORMAT, version: VERSION, files } : { format: FORMAT, version: VERSION, recordedThrough, files };
}

/** A model with no records, for a repository that has no contributors.json yet. */
function emptyContributors() {
  return build([]);
}

/**
 * Reads the text of contributors.json. Pass null or undefined when the file does not exist: that
 * is an empty model. Throws an error with code `invalidContributors` for anything else that is not
 * a valid model, so a damaged file stops the tools rather than being read as "nobody".
 */
function readContributors(text) {
  if (text === null || text === undefined) return emptyContributors();
  if (typeof text !== 'string') throw invalid('须为文本。');
  let model;
  try {
    model = JSON.parse(text);
  } catch {
    throw invalid('不是有效的 JSON。');
  }
  checkModel(model);
  return build(Object.entries(model.files), model.recordedThrough);
}

/** The text of contributors.json: fixed key order, files in path order, 2-space JSON, a final newline. */
function serializeContributors(model) {
  checkModel(model);
  return JSON.stringify(build(Object.entries(model.files), model.recordedThrough), null, 2) + '\n';
}

/** The record `{ id, login }` for a repository path, or null. */
function contributorOf(model, file) {
  return isObject(model) && isObject(model.files) && Object.hasOwn(model.files, file) ? model.files[file] : null;
}

/**
 * Applies the changes of one merged commit, `[{ status: 'added'|'modified'|'removed'|'renamed',
 * path, previousPath? }]`, contributed by `user` (`{ id, login }`). An added contribution file is
 * credited to `user` unless it already has a record; a removed file loses its record; a renamed
 * file keeps its record under the new path (a rename never creates one, and a rename out of the
 * contribution folders drops it). The record tool reports only exact renames (same content) as
 * renames; a file moved and changed in one commit counts as removed and added. Returns
 * `{ model, actions }` without changing `model`; each action is
 * `{ action: 'add'|'remove'|'move', path, from?, id, login }`. `user` is needed only when there is a
 * file to credit.
 */
function recordChanges(model, changes, user) {
  checkModel(model);
  if (!Array.isArray(changes)) throw new TypeError('changes 须为数组。');
  const files = new Map(Object.entries(model.files));
  const actions = [];
  for (const change of changes) {
    const { status, path: file, previousPath } = isObject(change) ? change : {};
    if (status === 'added') {
      if (!isContributionPath(file) || files.has(file)) continue;
      if (!isAccount(user)) throw new TypeError(`无法记录 ${quote(file)} 的投稿者：账号须为 { id: 数字编号, login: 账号名 }。`);
      if (user.login.endsWith('[bot]')) continue;
      files.set(file, { id: user.id, login: user.login });
      actions.push({ action: 'add', path: file, id: user.id, login: user.login });
    } else if (status === 'removed') {
      const record = files.get(file);
      if (!record) continue;
      files.delete(file);
      actions.push({ action: 'remove', path: file, id: record.id, login: record.login });
    } else if (status === 'renamed') {
      const record = files.get(previousPath);
      if (!record) continue;
      files.delete(previousPath);
      if (isContributionPath(file) && !files.has(file)) {
        files.set(file, record);
        actions.push({ action: 'move', from: previousPath, path: file, id: record.id, login: record.login });
      } else {
        actions.push({ action: 'remove', path: previousPath, id: record.id, login: record.login });
      }
    } else if (status !== 'modified') {
      throw new TypeError(`未知的修改类型 ${quote(status)}。`);
    }
  }
  return { model: build(files, model.recordedThrough), actions };
}

/**
 * Drops the records of files for which `exists(path)` is false. Returns `{ model, actions }` like
 * recordChanges.
 */
function dropMissing(model, exists) {
  checkModel(model);
  const kept = [], actions = [];
  for (const [file, record] of Object.entries(model.files)) {
    if (exists(file)) kept.push([file, record]);
    else actions.push({ action: 'remove', path: file, id: record.id, login: record.login });
  }
  return { model: build(kept, model.recordedThrough), actions };
}

/**
 * The pull request a commit on `branch` came from, given the response of
 * GET /repos/{owner}/{repo}/commits/{sha}/pulls: `{ number, user: { id, login } }` when the commit
 * is the merge commit of exactly one pull request merged into `branch` that was opened by the owner
 * of the repository it came from (a contributor's own fork); otherwise null. Anyone can open a pull
 * request from someone else's public branch, and GitHub marks it merged when that branch reaches
 * main, so such a pull request proves nothing about who wrote the files. A null commit is credited
 * to whoever pushed it, or to nobody, which can only take automatic merging away from a
 * contributor, never give it to someone else.
 */
function mergedPullRequest(sha, pulls, branch) {
  if (!Array.isArray(pulls)) return null;
  const exact = pulls.filter(pull => isObject(pull) && pull.merged_at && pull.merge_commit_sha === sha &&
    isObject(pull.base) && pull.base.ref === branch && isAccount(pull.user) && Number.isSafeInteger(pull.number) && pull.number > 0 &&
    isObject(pull.head) && isObject(pull.head.repo) && isObject(pull.head.repo.owner) && pull.head.repo.owner.id === pull.user.id);
  return exact.length === 1 ? { number: exact[0].number, user: { id: exact[0].user.id, login: exact[0].user.login } } : null;
}

/**
 * The open pull request into `branch` whose newest commit is `headSha`, from the list
 * GET /repos/{owner}/{repo}/pulls?state=open returns: `{ number, reason }`, with number null when
 * there is none or more than one. `run`, the workflow_run object of the check, ties the pull request
 * to the repository and branch the check ran for, when given.
 */
function pullRequestForHead(pulls, headSha, branch, run) {
  if (!isCommit(headSha)) return { number: null, reason: '检查对应的提交编号格式不对，不自动合并。' };
  const sameSource = pull => run === undefined || (isObject(run) && isObject(run.head_repository) && isObject(pull.head.repo) &&
    Number.isSafeInteger(run.head_repository.id) && pull.head.repo.id === run.head_repository.id &&
    typeof run.head_branch === 'string' && pull.head.ref === run.head_branch);
  const matches = (Array.isArray(pulls) ? pulls : []).filter(pull => isObject(pull) && pull.state === 'open' &&
    isObject(pull.head) && pull.head.sha === headSha && isObject(pull.base) && pull.base.ref === branch && sameSource(pull));
  if (matches.length === 0) return { number: null, reason: '没有打开的、以这个提交为最新提交的 Pull Request（可能已有新的提交，或已关闭、已合并），不自动合并。' };
  if (matches.length > 1) return { number: null, reason: `有 ${matches.length} 个打开的 Pull Request 以这个提交为最新提交，无法确定是哪一个，不自动合并。` };
  const { number } = matches[0];
  if (!Number.isSafeInteger(number) || number <= 0) return { number: null, reason: 'Pull Request 编号格式不对，不自动合并。' };
  return { number, reason: `检查通过的提交是 Pull Request #${number} 的最新提交。` };
}

/** GitHub's changed-file list is capped. Only a complete list of first-time additions
 * can proceed to the git tree and community checks in the trusted merge job. */
function autoMergeDecision({ files, changedFiles, draft, headSha, checkedSha, baseSha, expectedBase } = {}) {
  const no = reason => ({ merge: false, reason });
  if (draft !== false) return no('草稿须先标记为可审核。');
  if (!isCommit(headSha) || headSha !== checkedSha) return no('最新提交与通过检查的提交不同。');
  if (!isCommit(baseSha) || baseSha !== expectedBase) return no('默认分支已更新，须按新的基准检查。');
  if (!Array.isArray(files) || !Number.isSafeInteger(changedFiles) || changedFiles < 1 || files.length !== changedFiles)
    return no('无法核对完整的文件列表。');
  const names = new Set();
  for (const file of files) {
    if (!isObject(file) || file.status !== 'added' || file.previous_filename !== undefined ||
        !isContributionPath(file.filename) || file.filename.split('/').length !== 4 || names.has(file.filename))
      return no('仅新增应援时间轴或艺人专属 MIX 的投稿可自动合并。修改、改名、删除、通用 MIX 及其他改动请人工审核。');
    names.add(file.filename);
  }
  return { merge: true, reason: `仅新增 ${names.size} 个投稿文件，继续核对实际合并内容。` };
}

module.exports = {
  FORMAT, VERSION, CONTRIBUTION_AREAS, quote, isAccount, isContributionPath, emptyContributors, readContributors,
  serializeContributors, contributorOf, recordChanges, dropMissing, mergedPullRequest, pullRequestForHead, autoMergeDecision,
};
