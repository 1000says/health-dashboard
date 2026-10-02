/*
 * [DASH-PAGES-001] GitHub Pages 版ダッシュボードのシム。
 *
 * GAS 版の dashboard_scripts.html は google.script.run.withSuccessHandler(..).withFailureHandler(..)[name](args)
 * でサーバを呼ぶ。ここではその呼び出し方をそのまま受け、GAS の JSON API（doPost action=api）へ fetch で送る。
 * 認証は Google Identity Services の ID トークン（GAS 側で tokeninfo 検証 → ALLOWED_EMAILS と照合）。
 *
 * - トークンは sessionStorage に置く（タブを閉じれば消える）。期限の 60 秒前から無効として扱う。
 * - ログイン前に呼ばれた API は待たせ、ログイン後に順に送る。
 * - unauthenticated が返ったらトークンを捨てて再ログインを求め、1 回だけ送り直す。
 */
(function () {
  'use strict';

  var cfg = window.DASH_PAGES_CONFIG || {};
  // ダッシュボード本体が Pages 上かを知る印（アクセス権限欄を案内に切り替える）
  window.DASH_HOST = 'pages';
  var TOKEN_KEY = 'dashIdToken';
  var EXP_MARGIN_SEC = 60;
  var queue = [];          // ログイン待ちの呼び出し
  var gisReady = false;
  var gisInitialized = false;

  // ---------------------------------------------------------------- token
  function decodeClaims(token) {
    try {
      var part = String(token).split('.')[1];
      var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      return null;
    }
  }

  function readToken() {
    var t = null;
    try { t = sessionStorage.getItem(TOKEN_KEY); } catch (e) { t = null; }
    if (!t) t = window.__dashIdToken || null;
    if (!t) return null;
    var c = decodeClaims(t);
    if (!c || !c.exp || (c.exp - EXP_MARGIN_SEC) * 1000 <= Date.now()) { clearToken(); return null; }
    return t;
  }

  function saveToken(t) {
    window.__dashIdToken = t;
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) { /* 保存できなくてもメモリで続ける */ }
  }

  function clearToken() {
    window.__dashIdToken = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* noop */ }
  }

  function showEmail(token) {
    var c = token ? decodeClaims(token) : null;
    var el = document.getElementById('dash-user-email');
    if (el) el.textContent = (c && c.email) ? c.email : '';
  }

  // ---------------------------------------------------------------- login panel
  function gate() { return document.getElementById('pages-gate'); }

  function setGateMessage(msg, isError) {
    var el = document.getElementById('pages-gate-msg');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('pages-gate-msg--error', !!isError);
  }

  // ログイン画面の背後（Tab で移れてはいけない要素）。開いている間は inert にする（uiux U3-1）
  var BEHIND = ['.dash-header', '.dash-main', '.dash-footer', '.dash-bottomnav'];
  function setBehindInert(on) {
    if (!document.querySelectorAll) return;
    BEHIND.forEach(function (sel) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
        if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
        else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
      });
    });
  }

  function openGate(msg, isError) {
    var g = gate();
    if (!g) return;
    var wasHidden = g.hidden;
    g.hidden = false;
    document.documentElement.classList.add('pages-locked');
    setBehindInert(true);
    setGateMessage(msg || '', isError);
    renderButton();
    if (wasHidden) {
      var panel = document.getElementById('pages-gate-panel');
      if (panel && panel.focus) panel.focus();
    }
  }

  function closeGate() {
    var g = gate();
    if (g) g.hidden = true;
    document.documentElement.classList.remove('pages-locked');
    setBehindInert(false);
  }

  function configMissing() {
    return !cfg.apiUrl || !cfg.clientId;
  }

  function initGis() {
    if (gisInitialized || !gisReady || configMissing()) return;
    var gid = window.google && window.google.accounts && window.google.accounts.id;
    if (!gid) return;
    gid.initialize({
      client_id: cfg.clientId,
      callback: onCredential,
      auto_select: true,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true
    });
    gisInitialized = true;
  }

  function renderButton() {
    var host = document.getElementById('pages-gate-button');
    if (!host) return;
    if (configMissing()) {
      setGateMessage('接続先が未設定です。web/pages-config.json に apiUrl と clientId を入れて再ビルドしてください。', true);
      return;
    }
    initGis();
    if (!gisInitialized) return; // GIS 読込後に onGisLoad から呼び直す
    while (host.firstChild) host.removeChild(host.firstChild);
    window.google.accounts.id.renderButton(host, {
      type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ja'
    });
  }

  function onCredential(resp) {
    if (!resp || !resp.credential) { openGate('ログインできませんでした。もう一度お試しください。', true); return; }
    saveToken(resp.credential);
    showEmail(resp.credential);
    closeGate();
    flushQueue();
  }

  window.__dashOnGisLoad = function () {
    gisReady = true;
    ensureScriptShim();
    initGis();
    var g = gate();
    if (g && !g.hidden) renderButton();
    if (!readToken() && gisInitialized) {
      // 以前にこのページへ同意したアカウントなら、ボタンを押さずに戻れる（FedCM の自動選択）。
      try { window.google.accounts.id.prompt(); } catch (e) { /* ボタンで続ける */ }
    }
  };

  // ---------------------------------------------------------------- transport
  function post(fn, args, token) {
    return fetch(cfg.apiUrl, {
      method: 'POST',
      // text/plain＝CORS の単純リクエスト（GAS は OPTIONS を受けられない）
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'api', idToken: token, fn: fn, args: args || {} }),
      redirect: 'follow',
      credentials: 'omit'
    }).then(function (res) {
      if (!res.ok) throw new Error('サーバ応答 ' + res.status);
      return res.json();
    });
  }

  // Pages の API が受け付けない関数（src/dash_api.js の DASH_API_PAGES_EXCLUDED_ と同じ一覧）。
  // アクセス権限の変更はオーナー権限で通すと乗っ取りに使えるため、GAS 版の画面（本人の権限）で行う。
  var EXCLUDED = ['api_accessGetSettings', 'api_accessAddEmail', 'api_accessRemoveEmail'];
  var EXCLUDED_MSG = 'アクセス権限の確認と変更は、GAS 版のダッシュボード（設定 › アクセス権限）で行います。';
  // 一時的な不調（検証先に届かない・混雑）は再ログインで直らないので、ログイン画面を出さない
  var TRANSIENT = ['verify_unavailable', 'rate_limited'];

  function send(job) {
    if (EXCLUDED.indexOf(job.fn) >= 0) { job.ng({ message: EXCLUDED_MSG }); return; }
    var token = readToken();
    if (!token) { queue.push(job); openGate(); return; }
    post(job.fn, job.args, token).then(function (body) {
      if (body && body.ok === true) { job.ok(body.result); return; }
      var err = (body && body.error) || 'unknown';
      if (err === 'unauthenticated' && TRANSIENT.indexOf(body.reason) >= 0) {
        job.ng({ message: 'ログインの確認が混み合っています。少し待ってから再読み込みしてください。' });
        return;
      }
      if (err === 'unauthenticated' && !job.retried) {
        job.retried = true;
        clearToken();
        queue.push(job);
        openGate('ログインの有効期限が切れました。もう一度ログインしてください。');
        return;
      }
      if (err === 'forbidden') {
        var c = decodeClaims(token);
        clearToken();
        showEmail(null);
        openGate((c && c.email ? c.email : 'このアカウント') + ' には閲覧権限がありません。許可されたアカウントでログインしてください。', true);
        job.ng({ message: 'アクセス権限がありません。' });
        return;
      }
      if (err === 'disabled') { job.ng({ message: 'ダッシュボードは停止中です。' }); return; }
      job.ng({ message: 'サーバでエラーが起きました（' + err + '）。' });
    }, function (e) {
      job.ng({ message: '通信に失敗しました。接続を確認して再読み込みしてください。（' + (e && e.message ? e.message : e) + '）' });
    });
  }

  function flushQueue() {
    var jobs = queue.splice(0, queue.length);
    jobs.forEach(send);
  }

  /** google.script.run 互換の呼び出しを作る（呼ぶたびに新しいハンドラ束を返す）。 */
  function makeRunner(onOk, onNg) {
    var target = {
      withSuccessHandler: function (fn) { return makeRunner(fn, onNg); },
      withFailureHandler: function (fn) { return makeRunner(onOk, fn); }
    };
    return new Proxy(target, {
      get: function (t, name) {
        if (Object.prototype.hasOwnProperty.call(t, name)) return t[name];
        if (typeof name !== 'string' || name === 'then') return undefined;
        return function (args) {
          send({
            fn: name,
            args: args,
            ok: function (r) { if (onOk) onOk(r); },
            ng: function (e) { if (onNg) onNg(e); }
          });
        };
      }
    });
  }

  var scriptShim = {};
  Object.defineProperty(scriptShim, 'run', { get: function () { return makeRunner(null, null); } });

  /** GIS の読込が window.google を作り直しても google.script を失わないようにする。 */
  function ensureScriptShim() {
    window.google = window.google || {};
    if (window.google.script !== scriptShim) window.google.script = scriptShim;
  }
  ensureScriptShim();

  // ---------------------------------------------------------------- page wiring
  function wireLogout() {
    var a = document.getElementById('dash-logout');
    if (!a) return;
    a.removeAttribute('target');
    a.setAttribute('href', '#');
    a.setAttribute('title', 'このページからログアウトする');
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      clearToken();
      showEmail(null);
      // 自動選択だけ止める（同意は取り消さない＝次回は同じボタンで戻れる）
      try { window.google.accounts.id.disableAutoSelect(); } catch (e) { /* GIS 未読込でもトークンは消えている */ }
      openGate('ログアウトしました。');
    });
  }

  function boot() {
    wireLogout();
    var t = readToken();
    if (t) { showEmail(t); closeGate(); } else { openGate(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // テスト用（_verify_pages_build.js が __DASH_TEST__ を立てたときだけ内部関数を出す）
  if (window.__DASH_TEST__ === true) {
    window.__dashPagesShell = { decodeClaims: decodeClaims, readToken: readToken, saveToken: saveToken, queue: queue, flushQueue: flushQueue, EXCLUDED: EXCLUDED };
  }
})();
