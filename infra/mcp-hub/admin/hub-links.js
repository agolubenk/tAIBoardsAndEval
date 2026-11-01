// Ссылки hr-helper-хаба в админке 1mcp (/admin/servers): у каждого сервера — «инструменты ↗»
// (его страница с инструментами) и ссылки на собственный UI сервиса, всё в новой вкладке.
// Встраивается mcp-hub.sh (patch_admin) в index.html админки; ссылки — /admin/assets/hub-links.json.
//
// Своих data-атрибутов у строк 1mcp нет, а переход на сервер — по клику, не через <a href>,
// поэтому две независимые точки входа: ссылки рядом с текстом, совпадающим с именем сервера
// (best effort — зависит от вёрстки 1mcp), и плавающая панель «Ссылки хаба», которая от вёрстки
// не зависит вовсе.
(function () {
  'use strict';

  var MARK = 'data-hub-links';
  var links = null;

  function onServersPage() {
    return location.pathname.indexOf('/admin/servers') === 0;
  }

  function anchor(href, text, title) {
    var a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    a.title = title;
    a.setAttribute(MARK, 'link');
    a.style.cssText = 'margin-left:8px;font-size:12px;white-space:nowrap;text-decoration:none;color:#4dabf7';
    // Строка сервера сама реагирует на клик (переход внутри SPA) — ссылка не должна её задевать.
    a.addEventListener('click', function (e) { e.stopPropagation(); });
    return a;
  }

  function toolsHref(name) {
    return '/admin/servers/' + encodeURIComponent(name);
  }

  function linksFor(name, withTools) {
    var box = document.createElement('span');
    box.setAttribute(MARK, 'box');
    if (withTools) box.appendChild(anchor(toolsHref(name), 'инструменты ↗', 'Инструменты ' + name + ' в новой вкладке'));
    (links[name] || []).forEach(function (l) {
      box.appendChild(anchor(l.url, l.label + ' ↗', l.url));
    });
    return box;
  }

  function decorateInline() {
    var current = decodeURIComponent(location.pathname.replace(/^\/admin\/servers\/?(?:(?:static|template)\/)?/, '').split('/')[0] || '');
    var nodes = document.querySelectorAll('#admin-root *');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.childElementCount || el.hasAttribute(MARK) || el.closest('[' + MARK + ']')) continue;
      var name = (el.textContent || '').trim();
      if (!Object.prototype.hasOwnProperty.call(links, name)) continue;
      // Теги серверов (git, docs, code…) рисуются бейджами — их не трогаем.
      if (el.closest('[class*="Badge"],[class*="Pill"],input,textarea,select,option')) continue;
      el.setAttribute(MARK, 'name');
      el.insertAdjacentElement('afterend', linksFor(name, name !== current));
    }
  }

  function panel() {
    var existing = document.getElementById('hub-links-panel');
    if (!onServersPage()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var root = document.createElement('div');
    root.id = 'hub-links-panel';
    root.setAttribute(MARK, 'panel');
    root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10000;font:13px system-ui,sans-serif;' +
      'background:#1f2329;color:#e9ecef;border:1px solid #3a3f47;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    var head = document.createElement('button');
    head.type = 'button';
    head.textContent = 'Ссылки хаба ▴';
    head.style.cssText = 'all:unset;cursor:pointer;display:block;padding:8px 12px;font-weight:600';
    var list = document.createElement('div');
    list.style.cssText = 'display:none;padding:0 12px 10px;max-height:60vh;overflow:auto';
    Object.keys(links).sort().forEach(function (name) {
      var row = document.createElement('div');
      row.style.cssText = 'padding:3px 0';
      var label = document.createElement('span');
      label.textContent = name;
      label.style.cssText = 'display:inline-block;min-width:130px';
      row.appendChild(label);
      row.appendChild(linksFor(name, true));
      list.appendChild(row);
    });
    head.addEventListener('click', function () {
      var open = list.style.display === 'none';
      list.style.display = open ? 'block' : 'none';
      head.textContent = 'Ссылки хаба ' + (open ? '▾' : '▴');
    });
    root.appendChild(head);
    root.appendChild(list);
    document.body.appendChild(root);
  }

  var scheduled = false;
  function refresh() {
    if (scheduled || !links) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      panel();
      if (onServersPage()) decorateInline();
    });
  }

  fetch('/admin/assets/hub-links.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (data) {
      links = data || {};
      refresh();
      new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
    })
    .catch(function () { /* без файла ссылок админка работает как обычно */ });
})();
