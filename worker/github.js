import { createHash, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { reject } from './common.js';

const API = 'https://api.github.com';
const REPO = '/repos/alexpsz/cheerbook';
const hex = /^[a-f\d]{40}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function github(fetcher, token) {
  return async (path, body, accepted = []) => {
    const result = await fetcher(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'User-Agent': 'CheerBook-Submissions', 'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (accepted.includes(result.status)) return { status: result.status };
    if (!result.ok) reject(502, 'GitHub 暂时无法处理投稿，请稍后再试。');
    return { status: result.status, data: await result.json() };
  };
}

async function installationToken(env, fetcher) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64url({ iss: env.GITHUB_APP_ID, iat: now - 60, exp: now + 480 });
  const signature = sign('RSA-SHA256', Buffer.from(payload), env.GITHUB_PRIVATE_KEY).toString('base64url');
  const call = github(fetcher, payload + '.' + signature);
  const { data } = await call('/app/installations/' + env.GITHUB_INSTALLATION_ID + '/access_tokens', {
    repositories: ['cheerbook'], permissions: { contents: 'write', pull_requests: 'write' },
  });
  if (typeof data?.token !== 'string' || !data.token) reject(503, 'GitHub App 安装尚未就绪。');
  return data.token;
}

const prURL = number => 'https://github.com/alexpsz/cheerbook/pull/' + number;
const validNumber = n => Number.isSafeInteger(n) && n > 0;

// A submission has a stable branch. Create the commit before the ref, so interruption cannot
// leave a live empty branch. A retry can recover the ref and PR without rewriting either.
export async function openPull(sub, lyricStatus, env, fetcher) {
  const token = await installationToken(env, fetcher);
  const call = github(fetcher, token);
  const id = sha256(JSON.stringify([sub.path, sub.expected, sub.content]));
  const branch = 'submission/' + id;
  const list = REPO + '/pulls?state=all&base=main&head=' + encodeURIComponent('alexpsz:' + branch);
  async function existingPR() {
    const { data } = await call(list);
    if (!Array.isArray(data)) reject(502, '读取投稿记录失败，请稍后再试。');
    const found = data.find(pr => pr.head?.repo?.full_name === 'alexpsz/cheerbook' &&
      pr.head.ref === branch && pr.base?.ref === 'main' && validNumber(pr.number));
    return found ? prURL(found.number) : null;
  }
  const old = await existingPR();
  if (old) return old;
  const { data: base } = await call(REPO + '/branches/main');
  const parent = base?.commit?.sha, baseTree = base?.commit?.commit?.tree?.sha;
  if (!hex.test(parent) || !hex.test(baseTree)) reject(502, '无法确定投稿基准版本。');
  const file = await call(REPO + '/contents/' + sub.path.split('/').map(encodeURIComponent).join('/') + '?ref=' + parent,
    undefined, [404]);
  if (sub.expected) {
    if (file.status === 404 || file.data?.type !== 'file' || file.data.encoding !== 'base64' ||
        typeof file.data.content !== 'string' || sha256(Buffer.from(file.data.content, 'base64')) !== sub.expected) {
      reject(409, '原文件已有变化，请重新从社区打开最新版本再提交修改。');
    }
  } else if (file.status !== 404) {
    reject(409, '同名文件已经存在。如需修改，请从社区打开该文件并选择「修改原文件」。');
  }
  const change = [{ path: sub.path, mode: '100644', type: 'blob', content: sub.content }];
  const treeOn = async sha => (await call(REPO + '/git/trees', { base_tree: sha, tree: change })).data;
  const tree = await treeOn(baseTree);
  if (!hex.test(tree?.sha) || tree.sha === baseTree) reject(409, '文件与当前版本相同，无需再次提交。');
  const { data: commit } = await call(REPO + '/git/commits', {
    message: 'CheerBook: submit a community timeline', tree: tree.sha, parents: [parent],
  });
  if (!hex.test(commit?.sha)) reject(502, '未能准备投稿提交。');
  const reference = await call(REPO + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha }, [409, 422]);
  if (reference.status !== 201) {
    const retry = await existingPR();
    if (retry) return retry;
    // A previous request may have created the ref but not the PR. Only reuse a verified
    // single-file change, with the exact regular-file tree originally built from this base.
    const { data: ref } = await call(REPO + '/git/ref/heads/' + branch);
    if (!hex.test(ref?.object?.sha)) reject(409, '已有投稿分支无法核对，请联系维护者。');
    const { data: existing } = await call(REPO + '/git/commits/' + ref.object.sha);
    if (existing?.parents?.length !== 1 || !hex.test(existing.parents[0].sha)) reject(409, '无法核对已有投稿分支。');
    let expectedTree = tree.sha;
    if (existing.parents[0].sha !== parent) {
      // main may have advanced while an earlier request was interrupted. Its branch is reusable
      // only if the original commit added exactly our change on top of its own parent.
      const originalParent = existing.parents[0].sha;
      const { data: ancestry } = await call(REPO + '/compare/' + originalParent + '...' + parent + '?per_page=1');
      if (ancestry.merge_base_commit?.sha !== originalParent) reject(409, '已有投稿分支的基准不在主分支历史中。');
      const { data: original } = await call(REPO + '/git/commits/' + originalParent);
      if (!hex.test(original?.tree?.sha)) reject(409, '无法核对投稿基准。');
      expectedTree = (await treeOn(original.tree.sha)).sha;
    }
    if (!hex.test(expectedTree) || existing?.tree?.sha !== expectedTree) reject(409, '已有投稿分支内容不同，请联系维护者。');
  }
  const draft = lyricStatus === 'unchecked';
  const title = sub.expected ? '修改应援时间轴（免账号投稿）' : '新增应援时间轴（免账号投稿）';
  const body = [
    '这份时间轴由网页制作页代为提交。投稿者自报的公开资料仅用于署名和联系。',
    '', '公开昵称', '', '    ' + sub.submittedBy.name,
    ...(sub.submittedBy.url ? ['', '公开联系方式', '', '    ' + sub.submittedBy.url] : []),
    '', '文件路径', '', '    ' + sub.path.replace(/[\r\n]/g, ' '),
    '', '投稿者已确认内容与分享授权，并同意公开这些信息。',
    draft ? '缺少足够的录音参考歌词，本 PR 为草稿。请维护者人工核对后处理。' :
      '歌词结构及可比对文字已按社区规则检查。',
  ].join('\n');
  const result = await call(REPO + '/pulls', { head: branch, base: 'main', title, body, draft }, [422]);
  if (validNumber(result.data?.number)) return prURL(result.data.number);
  const concurrent = await existingPR();
  if (concurrent) return concurrent;
  reject(502, 'GitHub 未能创建投稿审核页，请稍后重试。');
}
