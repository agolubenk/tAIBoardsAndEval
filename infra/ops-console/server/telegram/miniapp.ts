/**
 * Страница ввода пароля бота (Telegram Mini App): открывается кнопкой «Ввести пароль» в чате.
 *
 * Отдельная лёгкая страница (~4 КБ), а не маршрут SPA: внутри Telegram на телефоне не нужно
 * качать весь бандл консоли ради одного поля. Личность — подпись initData (её даёт Telegram во
 * фрагменте адреса), cookie консоли не используется. Стороннего JS на странице с паролем нет:
 * telegram-web-app.js без версии нельзя закрепить SRI, поэтому тема берётся из
 * tgWebAppThemeParams, а ready/expand/close — напрямую через мост WebView (тот же протокол, что
 * у официального скрипта).
 */
export const MINI_APP_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Пароль бота</title>
<style>
  :root { color-scheme: light dark; --bg: var(--tg-theme-bg-color, #f7f8fa); --text: var(--tg-theme-text-color, #111827);
    --hint: var(--tg-theme-hint-color, #6b7280); --btn: var(--tg-theme-button-color, #2563eb); --btn-text: var(--tg-theme-button-text-color, #fff);
    --field: var(--tg-theme-secondary-bg-color, #eef0f4); --err: var(--tg-theme-destructive-text-color, #c52222); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 28px 18px calc(28px + env(safe-area-inset-bottom)); display: grid; gap: 12px; }
  h1 { margin: 0; font-size: 22px; }
  p { margin: 0; color: var(--hint); }
  label { display: grid; gap: 6px; font-weight: 600; margin-top: 8px; }
  input { font: inherit; padding: 13px 14px; border-radius: 12px; border: 1px solid transparent; background: var(--field); color: var(--text); }
  input:focus { outline: 2px solid var(--btn); outline-offset: 1px; }
  button { font: inherit; font-weight: 600; padding: 13px 16px; border: 0; border-radius: 12px; background: var(--btn); color: var(--btn-text); }
  button:disabled { opacity: .55; }
  .err { color: var(--err); }
  .ok { color: var(--text); }
</style>
</head>
<body>
<main>
  <h1 id="title">Пароль бота</h1>
  <p id="lead">Его выдаёт владелец консоли. Это не пароль от вашей учётки.</p>
  <form id="form" autocomplete="off">
    <label>Пароль <input id="pw" type="password" autocomplete="off" required autofocus></label>
    <p id="msg" role="alert"></p>
    <button id="btn" type="submit" style="width:100%;margin-top:14px">Подтвердить</button>
  </form>
</main>
<script>
(function () {
  var params = new URLSearchParams(location.hash.slice(1));
  var initData = params.get('tgWebAppData') || '';
  function postEvent(type) {
    try {
      if (window.TelegramWebviewProxy) window.TelegramWebviewProxy.postEvent(type, '{}');
      else if (window.external && 'notify' in window.external) window.external.notify(JSON.stringify({ eventType: type, eventData: {} }));
      else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: type, eventData: {} }), 'https://web.telegram.org');
    } catch (e) { /* вне Telegram — ничего */ }
  }
  try {
    var theme = JSON.parse(params.get('tgWebAppThemeParams') || '{}');
    Object.keys(theme).forEach(function (k) {
      if (/^#[0-9a-f]{3,8}$/i.test(theme[k])) document.documentElement.style.setProperty('--tg-theme-' + k.replace(/_/g, '-'), theme[k]);
    });
  } catch (e) { /* тема по умолчанию */ }
  postEvent('web_app_ready');
  postEvent('web_app_expand');
  var form = document.getElementById('form'), pw = document.getElementById('pw'), btn = document.getElementById('btn'), msg = document.getElementById('msg');
  if (!initData) {
    document.getElementById('lead').textContent = 'Откройте эту страницу кнопкой «Ввести пароль» в чате с ботом.';
    form.hidden = true;
    return;
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!pw.value) return;
    btn.disabled = true; msg.textContent = ''; msg.className = '';
    fetch('/api/telegram/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: initData, password: pw.value }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, message: 'Консоль недоступна (HTTP ' + r.status + ')' }; }); })
      .then(function (d) {
        if (d.ok) {
          document.getElementById('title').textContent = 'Готово';
          document.getElementById('lead').textContent = d.message;
          form.hidden = true;
          setTimeout(function () { postEvent('web_app_close'); }, 1600);
        } else {
          msg.textContent = d.message || d.error || 'Не получилось';
          msg.className = 'err';
          pw.value = '';
          pw.focus();
        }
      })
      .catch(function () { msg.textContent = 'Нет связи с консолью — пароль не отправлен, попробуйте ещё раз.'; msg.className = 'err'; })
      .finally(function () { btn.disabled = false; });
  });
})();
</script>
</body>
</html>`
