/* Настройки → «Модели и промпты»: роль → модель по профилям, роль → промпт, библиотека
   промптов, модели и фокус агентов ревью. Бэкенд — bindings.py (/api/bindings,
   /api/prompts) и review_api.py (/api/review/agents).

   Роли и привязки промптов пишутся в config.toml точечно (комментарии сохраняются) и
   применяются воркерами после перезапуска консилиума; тексты промптов — файлы
   prompts/*.md, применяются со следующего вызова модели. Утилиты ($, esc, api, post,
   toast) — из index.html. */
"use strict";

const BND = { data: null, review: null, promptName: "", dirty: false };
const PROFILE_RU = { fast: "fast (триаж)", deep: "deep", hybrid: "hybrid (облачный арбитр)", cloud: "cloud" };

function bndModelSelect(attrs, current, includeEmpty) {
  const m = BND.data.models;
  const names = new Set(m.local.map((x) => x.name).concat(m.cloud));
  return `<select ${attrs}>${includeEmpty ? `<option value="">— модель профиля —</option>` : ""}
    ${m.local.map((x) => `<option value="${esc(x.name)}" ${x.name === current ? "selected" : ""}>${esc(x.name)}${x.large ? " · L" : ""}</option>`).join("")}
    ${m.cloud.map((x) => `<option value="${esc(x)}" ${x === current ? "selected" : ""}>☁ ${esc(x)}</option>`).join("")}
    ${current && !names.has(current) ? `<option value="${esc(current)}" selected>${esc(current)} (не установлена)</option>` : ""}
  </select>`;
}

async function renderBindings(root) {
  [BND.data, BND.review] = await Promise.all([api("/api/bindings"), api("/api/review/state")]);
  const d = BND.data;
  const roleRows = d.roles.map((role) => `<tr><td class="mono"><b>${esc(role)}</b></td>${
    Object.keys(d.profiles).map((p) => d.profiles[p][role] !== undefined
      ? `<td>${bndModelSelect(`data-bprofile="${p}" data-brole="${esc(role)}" data-orig="${esc(d.profiles[p][role])}"`, d.profiles[p][role])}</td>`
      : `<td class="faint">—</td>`).join("")}</tr>`).join("");
  const promptNames = d.prompts.filter((p) => p.exists).map((p) => p.name);
  const slotRows = d.prompt_slots.map((s) => `<tr><td><b>${esc(s.label)}</b><div class="faint mono">${esc(s.slot)}</div></td>
    <td><select data-bslot="${esc(s.slot)}" data-orig="${esc(s.prompt)}">${promptNames.map((n) =>
      `<option ${n === s.prompt ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></td>
    <td><button class="act" data-bedit="${esc(s.prompt)}" title="Открыть промпт в редакторе">✎</button></td></tr>`).join("");
  const agentRows = (BND.review.agents || []).map((a) => `<tr data-ragent="${esc(a.key)}">
    <td><b>${esc(a.label)}</b><div class="faint mono">${esc(a.key)} · ${esc(a.kind)}</div></td>
    <td>${bndModelSelect(`data-rfield="model"`, a.model || "", true)}</td>
    <td style="min-width:320px"><textarea data-rfield="focus" rows="2">${esc(a.focus || "")}</textarea></td>
    <td><input type="checkbox" data-rfield="enabled" ${a.enabled === false ? "" : "checked"}></td>
    <td><input type="checkbox" data-rfield="can_block" ${a.can_block ? "checked" : ""}></td></tr>`).join("");
  const promptList = d.prompts.map((p) => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--line)">
    <a href="#" data-bedit="${esc(p.name)}" style="flex:1" class="mono">${esc(p.name)}</a>
    ${p.is_default ? `<span class="tag">встроенный</span>` : `<span class="faint mono">${esc(p.sha)}</span>`}
    ${p.used_by.length ? `<span class="tag ok" title="${esc(p.used_by.join(", "))}">в работе</span>` : ""}
    <span class="faint">${esc(p.label || "")}</span></div>`).join("");

  root.innerHTML = `
    <div class="card" style="margin-bottom:12px;border-color:var(--warn-bd)" id="bnd-restart" ${BND.dirty ? "" : "hidden"}>
      <div class="row"><span>Привязки сохранены в <span class="mono">${esc(d.config_path)}</span>. Воркеры применят их после перезапуска.</span>
        <span class="spacer"></span><button class="act accent" id="bnd-restart-btn">Перезапустить консилиум</button></div></div>
    <div class="card" style="margin-bottom:12px"><h3>Роли консилиума → модели (по профилям)</h3>
      <div class="sub" style="margin-bottom:8px">Профиль — состав прогона. «L» — тяжёлая модель: грузится по одной, только если хватает памяти.
        Модель тяжелее порога считается L, даже если не вписана в <span class="mono">[models.large]</span>.</div>
      <div class="tablewrap"><table><thead><tr><th>Роль</th>${Object.keys(d.profiles).map((p) => `<th>${esc(PROFILE_RU[p] || p)}</th>`).join("")}</tr></thead>
        <tbody>${roleRows}</tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="act accent" id="bnd-save-roles">Сохранить модели ролей</button></div></div>
    <div class="split" style="margin-bottom:12px">
      <div class="card"><h3>Роли консилиума → промпты</h3>
        <div class="tablewrap"><table><thead><tr><th>Слот</th><th>Промпт</th><th></th></tr></thead><tbody>${slotRows}</tbody></table></div>
        <div class="row" style="margin-top:8px"><button class="act accent" id="bnd-save-slots">Сохранить привязки промптов</button></div>
        <h3 style="margin-top:14px">Библиотека промптов</h3>${promptList}
        <div class="row" style="margin-top:8px"><input type="text" id="bnd-new-name" placeholder="имя-нового-промпта"><button class="act" id="bnd-new">+ Новый из открытого</button></div></div>
      <div class="card"><h3 id="bnd-ed-title">Промпт</h3>
        <div class="sub" id="bnd-ed-sub">выберите промпт слева</div>
        <textarea id="bnd-ed-text" rows="22" style="font-family:var(--mono);font-size:12px" disabled></textarea>
        <div class="row" style="margin-top:8px"><button class="act accent" id="bnd-ed-save" disabled>Сохранить промпт</button>
          <button class="act" id="bnd-ed-reset" hidden>Вернуть встроенный текст</button>
          <span class="sub">Применяется со следующего вызова модели; файл под git.</span></div></div></div>
    <div class="card"><h3>Агенты ревью → модели и промпты (фокус роли)</h3>
      <div class="sub" style="margin-bottom:8px">Пустая модель — модель профиля ревью. Тонкие параметры (temperature, num_ctx…) — вкладка «Ревью» → «Агенты».
        Общие системные промпты ревью (<span class="mono">review.*</span>) — в библиотеке слева.</div>
      <div class="tablewrap"><table><thead><tr><th>Агент</th><th>Модель</th><th>Фокус (промпт роли)</th><th>Вкл</th><th>Вето</th></tr></thead>
        <tbody>${agentRows}</tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="act accent" id="bnd-save-agents">Сохранить агентов</button></div></div>`;

  root.querySelector("#bnd-restart-btn").onclick = async () => {
    try { await post("/api/ops", { name: "council_restart" }); toast("перезапуск консилиума запущен"); BND.dirty = false;
      root.querySelector("#bnd-restart").hidden = true; } catch (e) { toast(e.message, true); }
  };
  root.querySelector("#bnd-save-roles").onclick = () => bndSaveChanged(root, "[data-brole]", (el) =>
    ({ kind: "role", profile: el.dataset.bprofile, role: el.dataset.brole, model: el.value }));
  root.querySelector("#bnd-save-slots").onclick = () => bndSaveChanged(root, "[data-bslot]", (el) =>
    ({ kind: "prompt", slot: el.dataset.bslot, prompt: el.value }));
  root.querySelectorAll("[data-bedit]").forEach((el) => {
    el.onclick = (e) => { e.preventDefault(); bndOpenPrompt(root, el.dataset.bedit); };
  });
  root.querySelector("#bnd-ed-save").onclick = () => bndSavePrompt(root, BND.promptName, false);
  root.querySelector("#bnd-ed-reset").onclick = async () => {
    const p = await api(`/api/prompts/${encodeURIComponent(BND.promptName)}`);
    root.querySelector("#bnd-ed-text").value = p.default || "";
    toast("встроенный текст подставлен — сохраните, чтобы применить");
  };
  root.querySelector("#bnd-new").onclick = () => {
    const name = root.querySelector("#bnd-new-name").value.trim();
    if (!name) { toast("укажите имя нового промпта", true); return; }
    bndSavePrompt(root, name, true);
  };
  root.querySelector("#bnd-save-agents").onclick = () => bndSaveAgents(root);
  if (BND.promptName) bndOpenPrompt(root, BND.promptName);
}

async function bndSaveChanged(root, selector, toBody) {
  const changed = [...root.querySelectorAll(selector)].filter((el) => el.value !== el.dataset.orig);
  if (!changed.length) { toast("изменений нет"); return; }
  let ok = 0;
  for (const el of changed) {
    try {
      const r = await post("/api/bindings", toBody(el));
      if (r.ok === false) throw new Error(r.error);
      el.dataset.orig = el.value; ok++;
    } catch (e) { toast(e.message, true); }
  }
  if (ok) { BND.dirty = true; root.querySelector("#bnd-restart").hidden = false; toast(`сохранено: ${ok}`); }
}

async function bndOpenPrompt(root, name) {
  const p = await api(`/api/prompts/${encodeURIComponent(name)}`);
  BND.promptName = name;
  root.querySelector("#bnd-ed-title").textContent = `Промпт: ${name}`;
  const used = (BND.data.prompts.find((x) => x.name === name) || {}).used_by || [];
  root.querySelector("#bnd-ed-sub").textContent = (p.is_default ? "встроенный текст — при сохранении появится файл prompts/" + name + ".md"
    : `prompts/${name}.md · sha ${p.sha}`) + (used.length ? ` · используют: ${used.join(", ")}` : "");
  const ta = root.querySelector("#bnd-ed-text");
  ta.value = p.text || ""; ta.disabled = false;
  root.querySelector("#bnd-ed-save").disabled = false;
  root.querySelector("#bnd-ed-reset").hidden = !p.default;
}

async function bndSavePrompt(root, name, createOnly) {
  const text = root.querySelector("#bnd-ed-text").value;
  try {
    const r = await post("/api/prompts", { name, text, create_only: createOnly });
    if (r.ok === false) throw new Error(r.error);
    toast(`промпт ${r.name} сохранён (${r.sha})`);
    BND.promptName = r.name;
    await renderBindings(root);
  } catch (e) { toast(e.message, true); }
}

async function bndSaveAgents(root) {
  const byKey = Object.fromEntries((BND.review.agents || []).map((a) => [a.key, a]));
  let ok = 0, failed = 0;
  for (const tr of root.querySelectorAll("[data-ragent]")) {
    const a = byKey[tr.dataset.ragent];
    const model = tr.querySelector("[data-rfield=model]").value;
    const focus = tr.querySelector("[data-rfield=focus]").value;
    const enabled = tr.querySelector("[data-rfield=enabled]").checked;
    const canBlock = tr.querySelector("[data-rfield=can_block]").checked;
    if (model === (a.model || "") && focus === (a.focus || "") && enabled === (a.enabled !== false)
        && canBlock === !!a.can_block) continue;
    try {
      await post("/api/review/agents", { key: a.key, spec: { label: a.label, kind: a.kind, focus, model,
        params: a.params || {}, can_block: canBlock, enabled, triggers: a.triggers || {} } });
      ok++;
    } catch (e) { failed++; toast(`${a.key}: ${e.message}`, true); }
  }
  if (!ok && !failed) { toast("изменений нет"); return; }
  if (ok) toast(`агентов сохранено: ${ok} — применяется со следующего ревью`);
  await renderBindings(root);
}
