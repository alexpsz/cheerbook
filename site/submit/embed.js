'use strict';
// The page Liveglow embeds to submit a chart without leaving the app (/submit/). It shows only the
// challenge: the form is the app's own. The app hands over the chart and the public fields through
// one message handler that answers (window.webkit.messageHandlers.cheerbookSubmission), so nothing
// is evaluated in this page from outside, and the page posts to its own origin exactly as the
// editor's form does (site/editor/submission.js). The service checks the chart again in full.
//
// To the host:   { type: 'state', state, message }   state: loading | challenge | verified | unavailable | sending
//                { type: 'payload' }                  answered once, when the person confirms in the app, with
//                                                     { chart, nickname, contact, rightsConfirmed: true }
//                { type: 'result', url }              the pull request that was opened
//                { type: 'failure', message }         nothing was opened, or it cannot be told
// A challenge token is spent by one attempt. To try again the host reloads this page.
const endpoint = '/api/submissions';
const challengeURL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const receipt = /^https:\/\/github\.com\/alexpsz\/cheerbook\/pull\/[1-9]\d*$/;

function challengeAPI() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => { clearTimeout(timer); script.remove(); reject(new Error('challenge')); };
    const timer = setTimeout(fail, 15000);
    script.src = challengeURL;
    script.async = true;
    script.onload = () => { clearTimeout(timer); if (window.turnstile) resolve(window.turnstile); else fail(); };
    script.onerror = fail;
    document.head.append(script);
  });
}

async function embed(bridge, container) {
  // A message the host does not answer must never stop the page.
  const tell = message => { try { Promise.resolve(bridge.postMessage(message)).catch(() => {}); } catch { /* the host is gone */ } };
  const state = (name, message) => tell({ type: 'state', state: name, message });
  let token = '', api, siteKey;
  state('loading', '正在加载人机验证…');
  try {
    const response = await fetch(endpoint + '/config', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const config = response.ok && await response.json();
    if (!config || typeof config.siteKey !== 'string' || !config.siteKey) throw new Error('config');
    siteKey = config.siteKey;
    api = await challengeAPI();
  } catch {
    state('unavailable', '免账号投稿暂时不可用。可以重试，或先存储文件。');
    return;
  }
  const lost = text => { token = ''; state('unavailable', text); };
  state('challenge', '请完成人机验证。');
  let widget;
  try {
    widget = api.render(container, {
      sitekey: siteKey, action: 'submit_chart', 'refresh-expired': 'manual', retry: 'never',
      callback(value) { token = value; state('verified', '已完成人机验证。'); },
      'expired-callback': () => lost('验证已过期，请重新验证。'),
      'timeout-callback': () => lost('验证已超时，请重新验证。'),
      'error-callback': () => { lost('人机验证失败，请重新验证。'); return true; },
    });
  } catch {
    state('unavailable', '人机验证没有显示出来，请重新验证。');
    return;
  }

  let payload;
  try { payload = await bridge.postMessage({ type: 'payload' }); }
  catch { return; } // The panel was closed.
  const valid = payload && typeof payload === 'object' && typeof payload.chart === 'string' && payload.chart &&
    typeof payload.nickname === 'string' && payload.nickname.trim() && payload.rightsConfirmed === true &&
    (payload.contact === undefined || typeof payload.contact === 'string');
  if (!valid) { tell({ type: 'failure', message: '投稿内容不完整，请重新填写后再试。' }); return; }
  if (!token) { tell({ type: 'failure', message: '验证已过期，请重新验证后再投稿。' }); return; }
  const body = JSON.stringify({
    chart: payload.chart, nickname: payload.nickname.trim(), contact: (payload.contact || '').trim(), token, rightsConfirmed: true,
  });
  token = '';
  try { api.remove(widget); } catch { /* The spent check is gone either way. */ }
  state('sending', '正在创建投稿记录…');
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(45000), redirect: 'error', credentials: 'omit',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === 'string' && result.error.trim() ? result.error : '投稿失败，请稍后重试。');
    if (typeof result?.url !== 'string' || !receipt.test(result.url)) throw new Error('未收到可核对的投稿记录链接，请稍后重试。');
    tell({ type: 'result', url: result.url });
  } catch (error) {
    // Only an error raised above with the service's own words is a known refusal; a network
    // failure, a timeout or an unreadable answer leaves the outcome unknown.
    const unknown = !error || error.name !== 'Error';
    tell({ type: 'failure', message: unknown ? '暂时无法确认投稿结果，作品仍在本机。请重新验证后重试。' : error.message });
  }
}

const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cheerbookSubmission;
if (bridge && typeof bridge.postMessage === 'function') embed(bridge, document.getElementById('challenge'));
else document.getElementById('standalone').hidden = false;
