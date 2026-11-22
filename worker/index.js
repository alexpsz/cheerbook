import { compareLyrics, submission } from './chart.js';
import { openPull } from './github.js';
import { boundedText, reject, SubmissionError } from './common.js';

const ORIGIN = 'https://cheerbook.kozueginko.com';
const ROUTE = '/api/submissions';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const reply = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

function configured(env) {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET && env.GITHUB_PRIVATE_KEY &&
    /^\d+$/.test(env.GITHUB_APP_ID) && /^\d+$/.test(env.GITHUB_INSTALLATION_ID) && env.SUBMISSION_RATE_LIMITER?.limit);
}

async function verify(input, env, ip, fetcher) {
  if (typeof input.token !== 'string' || !input.token || input.token.length > 2048) reject(403, '请完成人机验证后再投稿。');
  const response = await fetcher(SITEVERIFY, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: input.token, remoteip: ip }),
  });
  if (!response.ok) reject(503, '人机验证服务暂时不可用，请稍后再试。');
  const result = await response.json();
  if (result.success !== true || result.hostname !== 'cheerbook.kozueginko.com' || result.action !== 'submit_chart') {
    reject(403, '人机验证未通过或已过期，请重新验证。');
  }
}

export async function handle(request, env, fetcher = fetch) {
  try {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || ![ROUTE, ROUTE + '/config'].includes(url.pathname)) reject(404, '找不到此接口。');
    const config = url.pathname.endsWith('/config');
    if (request.method !== (config ? 'GET' : 'POST')) reject(405, '请求方式不正确。');
    if (!configured(env)) reject(503, '免账号投稿尚未配置好，你可以保存文件或自行提 PR。');
    if (config) return reply({ siteKey: env.TURNSTILE_SITE_KEY });
    if (request.headers.get('origin') !== ORIGIN) reject(403, '请从 CheerBook 制作页投稿。');
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') reject(415, '请提交 JSON 格式的投稿。');
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) reject(403, '无法验证请求来源，请通过正式站点重试。');
    const result = await env.SUBMISSION_RATE_LIMITER.limit({ key: ip });
    if (result?.success !== true) reject(429, '投稿次数过多，请一分钟后再试。');
    // The chart is JSON text inside another JSON object. Allow for escaping, with a second cap
    // on the decoded chart and the actual final file.
    let input;
    try { input = JSON.parse(await boundedText(request, 2 * 512 * 1024 + 12 * 1024)); }
    catch (error) {
      if (error instanceof SubmissionError) throw error;
      reject(400, '投稿内容不是有效的 UTF-8 JSON。');
    }
    if (!input || Array.isArray(input) || typeof input !== 'object') reject(400, '投稿内容缺少必要字段。');
    await verify(input, env, ip, fetcher);
    const sub = submission(input);
    const status = await compareLyrics(sub.chart, fetcher);
    return reply({ url: await openPull(sub, status, env, fetcher) }, 201);
  } catch (error) {
    // Upstream exceptions can contain request details. No chart, token, IP or key enters logs.
    return error instanceof SubmissionError ? reply({ error: error.message }, error.status) :
      reply({ error: '投稿服务暂时不可用。草稿还在，请稍后重试。' }, 503);
  }
}
export default { fetch: (request, env) => handle(request, env) };
