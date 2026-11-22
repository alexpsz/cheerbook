#!/usr/bin/env node
'use strict';
// All commands take argument arrays; only this default-branch program runs with the status
// token. The exact PR head and the verified identities on GitHub bind approval to a revision.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { autoMergeDecision, contributorOf, isContributionPath, readContributors } = require('../lib/contributors');

function policy({ pull, files, base, owners, pending, approvals, maintainer }) {
  if (pull.draft !== false || pull.base.ref !== 'main' || pull.base.sha !== base) return false;
  if (approvals.has(maintainer)) return true;
  if (!Array.isArray(files) || files.length !== pull.changed_files || !files.length) return false;
  if (autoMergeDecision({ files, changedFiles: pull.changed_files, draft: false,
    headSha: pull.head.sha, checkedSha: pull.head.sha, baseSha: base, expectedBase: base }).merge) return true;
  if (!Array.isArray(pending) || !files.some(file => file.status !== 'added')) return false;
  return files.every(file => {
    const path = file.status === 'renamed' ? file.previous_filename : file.filename;
    if (!isContributionPath(file.filename) || file.filename.split('/').length !== 4 || !isContributionPath(path)) return false;
    if (file.status === 'added') return true;
    if (!['renamed', 'modified', 'removed'].includes(file.status) || pending.includes(path)) return false;
    const owner = contributorOf(owners, path);
    return owner && !owner.login.endsWith('[bot]') && approvals.has(owner.id);
  });
}

function matchingApprovals(comments, head) {
  const ids = new Set();
  for (const comment of comments) {
    if (comment?.lastEditedAt === null && comment.isMinimized === false &&
        comment.author?.__typename === 'User' && Number.isSafeInteger(comment.author.databaseId) &&
        comment.body?.trimEnd() === '/cheerbook approve ' + head) ids.add(comment.author.databaseId);
  }
  return ids;
}

function run() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number ?? event.issue?.number;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!Number.isSafeInteger(number) || number < 1 || repo !== event.repository.full_name) throw Error('无效投稿事件');
  const cmd = (name, args) => execFileSync(name, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const api = (path, ...args) => JSON.parse(cmd('gh', ['api', 'repos/' + repo + '/' + path, ...args]));
  const pull = api('pulls/' + number);
  if (pull.state !== 'open' || pull.base.ref !== 'main') return;
  const head = pull.head.sha, base = cmd('git', ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base)) throw Error('无效投稿提交');
  const publish = state => api('statuses/' + head, '--method', 'POST', '-f', 'state=' + state,
    '-f', 'context=cheerbook/review-policy', '-f', 'description=' + (state === 'success' ? '投稿符合审核要求' : '等待原作者或维护者核准本次提交'));
  publish('pending');
  const { files } = api('compare/' + base + '...' + head);
  if (autoMergeDecision({ files, changedFiles: pull.changed_files, draft: pull.draft,
    headSha: head, checkedSha: head, baseSha: pull.base.sha, expectedBase: base }).merge) {
    publish('success');
    return;
  }
  const owners = readContributors(fs.readFileSync('contributors.json', 'utf8'));
  const pending = JSON.parse(cmd(process.execPath, ['tools/record-contributors.js', '--after', base, '--pending']));
  // Only the numeric ID of the repository owner is privileged here (single-maintainer project).
  const maintainer = event.repository.owner.id;
  // GraphQL distinguishes comments that were never edited, including an edit in their creation second.
  const query = `query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
    repository(owner:$owner, name:$repo) { pullRequest(number:$number) {
      comments(first:100, after:$endCursor) {
        nodes { author { __typename ... on User { databaseId } } body lastEditedAt isMinimized }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }`;
  const pages = JSON.parse(cmd('gh', ['api', 'graphql', '--paginate', '--slurp', '-f', 'query=' + query,
    '-F', 'number=' + number, '-f', 'owner=' + event.repository.owner.login, '-f', 'repo=' + event.repository.name]));
  const comments = pages.flatMap(page => page.data.repository.pullRequest.comments.nodes);
  const approvals = matchingApprovals(comments, head);
  const passed = policy({ pull, files, base, owners, pending, approvals, maintainer });
  if (passed) publish('success');
  console.log(passed ? '投稿审核条件已满足。' : '等待原作者或维护者核准本次提交。');
}

if (require.main === module) run();
module.exports = { policy, matchingApprovals };
