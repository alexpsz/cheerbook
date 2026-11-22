// The challenge is loaded only after the visitor chooses the accountless channel.
const endpoint = '/api/submissions';
const challengeURL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptReady;

function challengeAPI() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptReady) return scriptReady;
  scriptReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    function fail() {
      clearTimeout(timer);
      script.remove();
      scriptReady = null;
      reject(new Error('人机验证没有加载。请重试，或选择自行在 GitHub 提交。'));
    }
    const timer = setTimeout(fail, 15000);
    script.src = challengeURL;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    script.onerror = fail;
    document.head.append(script);
  });
  return scriptReady;
}

export function setupSubmission($, prepare) {
  const panel = $('submission-panel'), name = $('submission-name'), contact = $('submission-contact');
  const rights = $('submission-rights'), message = $('submission-status'), send = $('submission-send');
  const retry = $('submission-retry'), receipt = $('submission-receipt');
  let generation = 0, widget = null, api = null, token = '', sending = false, submitted = false;

  function update() {
    send.disabled = sending || submitted || !name.value.trim() || !rights.checked || !token;
  }

  function clearWidget() {
    generation++;
    token = '';
    if (widget !== null) api.remove(widget);
    widget = null;
    retry.hidden = true;
    update();
  }

  async function verify() {
    clearWidget();
    const attempt = generation;
    message.textContent = '正在加载人机验证…';
    try {
      const response = await fetch(endpoint + '/config', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const config = response.ok && await response.json();
      if (!config || typeof config.siteKey !== 'string' || !config.siteKey) throw new Error();
      if (attempt !== generation) return;
      api = await challengeAPI();
      if (attempt !== generation) return;
      function unavailable(text) {
        if (attempt !== generation || submitted || sending) return;
        token = '';
        message.textContent = text;
        retry.hidden = false;
        update();
      }
      message.textContent = '请完成人机验证。';
      widget = api.render($('submission-challenge'), {
        sitekey: config.siteKey, action: 'submit_chart', 'refresh-expired': 'manual', retry: 'never',
        callback(value) {
          if (attempt !== generation) return;
          token = value;
          retry.hidden = true;
          message.textContent = '已完成人机验证。';
          update();
        },
        'expired-callback': () => unavailable('验证已过期，请重新验证。'),
        'timeout-callback': () => unavailable('验证已超时，请重新验证。'),
        'error-callback': () => { unavailable('人机验证失败，请重新验证。'); return true; },
      });
    } catch {
      if (attempt !== generation) return;
      message.textContent = '免账号投稿暂时不可用。可以重试、下载文件，或自行在 GitHub 提交。';
      retry.hidden = false;
    }
  }

  function close() {
    clearWidget();
    sending = false;
    submitted = false;
    panel.hidden = true;
    receipt.hidden = true;
    receipt.removeAttribute('href');
    $('share-submit').setAttribute('aria-expanded', 'false');
    rights.checked = false;
  }

  function open(defaultName) {
    if (!panel.hidden) { $('submission-title').focus(); return; }
    panel.hidden = false;
    $('share-submit').setAttribute('aria-expanded', 'true');
    $('submission-title').focus();
    name.value = defaultName;
    contact.value = '';
    verify();
  }

  async function submit() {
    if (send.disabled) return;
    let payload;
    try { payload = prepare(); }
    catch (error) { message.textContent = error.message; return; }
    const nickname = name.value.trim(), address = contact.value.trim();
    if (!nickname || !rights.checked || !token) return;
    sending = true;
    receipt.hidden = true;
    receipt.removeAttribute('href');
    const body = JSON.stringify({ ...payload, nickname, contact: address, token, rightsConfirmed: true });
    clearWidget();
    const attempt = generation;
    const song = JSON.parse(payload.chart).song;
    const label = song ? song.artist + ' · ' + song.title : nickname;
    const entry = document.createElement('li');
    entry.textContent = label + '：正在投稿…';
    const history = $('submission-history');
    history.hidden = false;
    history.prepend(entry);
    message.textContent = '正在创建投稿记录…';
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(45000), redirect: 'error', credentials: 'omit',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : '投稿失败，请稍后重试。');
      if (typeof result?.url !== 'string' || !/^https:\/\/github\.com\/alexpsz\/cheerbook\/pull\/[1-9]\d*$/.test(result.url)) {
        throw new Error('未收到可核对的投稿记录链接，请稍后重试。');
      }
      const link = document.createElement('a');
      link.href = result.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '查看投稿 #' + result.url.split('/').pop();
      entry.replaceChildren(label + ' · ', link);
      if (attempt !== generation) return;
      submitted = true;
      receipt.href = result.url;
      receipt.hidden = false;
      message.textContent = '投稿已创建。请保存链接，随时查看检查与审核进度。';
    } catch (error) {
      const reason = error instanceof TypeError || error.name === 'TimeoutError' || error instanceof SyntaxError
        ? '暂时无法确认投稿结果，草稿仍可编辑。请重新验证后重试。' : error.message;
      entry.textContent = label + '：' + reason;
      if (attempt !== generation) return;
      message.textContent = reason;
      retry.hidden = false;
    } finally {
      if (attempt === generation) {
        sending = false;
        update();
      }
    }
  }

  for (const field of [name, contact, rights]) field.addEventListener('input', update);
  send.addEventListener('click', submit);
  retry.addEventListener('click', verify);
  return { open, close };
}
