"use strict";
// LPMC веб-интерфейс. Ванильный SPA: две зоны (задачи/админ), живые данные из API.
// API относительный (сайт живёт под /lpmc/, apache срезает префикс).

const API = "api";
async function api(path, method = "GET", body) {
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel) => document.querySelector(sel);

const S = {
  zone: "dialogs", taskView: "table", tasks: [], selId: null, full: null,
  adminScreen: "services", servicesTab: "allow", admin: {}, live: true,
  fOwner: "", fStatus: "", cardOpen: false, drawer: null, toasts: [],
};
function toast(text, kind) { const id = Math.random(); S.toasts.push({ id, text, kind }); render(); setTimeout(() => { S.toasts = S.toasts.filter((t) => t.id !== id); render(); }, 5000); }

const STATUS = { todo: "к выполнению", doing: "в работе", review: "на проверке", done: "готово" };
const SDOT = { todo: "var(--fg3)", doing: "var(--warn)", review: "var(--accent)", done: "var(--ok)" };
const prioChip = (p) => `<span class="chip ${p === "высокий" ? "hi" : ""}">${esc(p)}</span>`;
const statusChip = (s) => `<span class="chip ${s === "done" ? "ok" : s === "doing" ? "warn" : ""}">${esc(STATUS[s] || s)}</span>`;

// ---------- data ----------
async function loadTasks() { const r = await api("tasks"); S.tasks = r.tasks || []; }
async function openTask(id) { S.selId = id; S.full = await api(`tasks/${id}`); render(); }
async function refreshFull() { if (S.selId) S.full = await api(`tasks/${S.selId}`); }

// ---------- render ----------
function render() {
  const app = $("#app");
  const admin = S.zone === "admin";
  app.innerHTML = `<div class="app" data-zone="${admin ? "admin" : "dialogs"}">
    ${nav()}
    ${admin ? privBar() : ""}
    <div class="frame">${admin ? adminZone() : tasksZone()}</div>
  </div>
  ${S.cardOpen ? cardModal() : ""}
  ${S.drawer ? drawer() : ""}
  <div class="toasts">${S.toasts.map((t) => `<div class="toast ${t.kind === "err" ? "err" : ""}">${esc(t.text)}</div>`).join("")}</div>`;
  wire();
}

function nav() {
  return `<div class="nav">
    <div class="logo">LPMC<small>lina · pact · mita · cita</small></div>
    <div class="tabs">
      <div class="tab ${S.zone === "dialogs" ? "on" : ""}" data-act="zone" data-v="dialogs"><span class="n">01</span>Задачи</div>
      <div class="tab ${S.zone === "admin" ? "on" : ""}" data-act="zone" data-v="admin"><span class="n">02</span>Администрирование</div>
    </div>
    <div class="spacer"></div>
    <div class="live" data-act="live"><span class="dot ${S.live ? "" : "off"}"></span>${S.live ? "живой поток" : "поток на паузе"}</div>
  </div>`;
}
function privBar() {
  return `<div class="priv-bar">🔒 <b>привилегированный контур</b> · оператор · записи политики и custody проходят через PACT · <a data-act="zone" data-v="dialogs">выйти к задачам →</a></div>`;
}

// ---------- tasks zone ----------
function tasksZone() {
  const views = [["table", "Таблица"], ["kanban", "Канбан"], ["timeline", "Таймлайн"]];
  let list = S.tasks;
  if (S.fOwner) list = list.filter((t) => t.owner === S.fOwner);
  if (S.fStatus) list = list.filter((t) => t.status === S.fStatus);
  const owners = [...new Set(S.tasks.map((t) => t.owner))];
  const body = S.taskView === "kanban" ? kanban(list) : S.taskView === "timeline" ? timeline(list) : table(list);
  return `<div class="main">
    <div class="head">
      <h1>Задачи</h1>
      <div class="seg">${views.map(([k, l]) => `<button class="${S.taskView === k ? "on" : ""}" data-act="view" data-v="${k}">${l}</button>`).join("")}</div>
      <div class="spacer"></div>
      <button class="btn pri" data-act="newtask">+ Задача</button>
    </div>
    <div class="filters">
      <span>владелец</span>
      <select data-act="fowner"><option value="">все</option>${owners.map((o) => `<option ${S.fOwner === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>
      <span>статус</span>
      <select data-act="fstatus"><option value="">все</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${S.fStatus === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      ${(S.fOwner || S.fStatus) ? `<a data-act="resetf">сбросить</a>` : ""}
      <span class="count">${list.length} из ${S.tasks.length}</span>
    </div>
    <div class="body">${body}</div>
  </div>
  ${S.selId ? chat() : ""}`;
}

function table(list) {
  if (!list.length) return `<div class="empty">Задач нет. Нажмите «+ Задача».</div>`;
  return `<table class="tasks"><thead><tr>
    <th>задача</th><th>владелец</th><th>статус</th><th>приоритет</th><th>срок</th><th>диалог</th></tr></thead><tbody>
    ${list.map((t) => `<tr class="${S.selId === t.id ? "sel" : ""}" data-act="open" data-id="${t.id}">
      <td><div class="tt"><span class="sdot" style="background:${SDOT[t.status]}"></span>${esc(t.title)}</div></td>
      <td>${esc(t.owner)}</td><td>${statusChip(t.status)}</td><td>${prioChip(t.prio)}</td>
      <td class="mono">${t.due ? esc(t.due) : "—"}</td>
      <td class="mono" style="color:var(--fg3)">${t.dialog_id ? esc(t.dialog_id) : "—"}</td></tr>`).join("")}
  </tbody></table>`;
}
function kanban(list) {
  const cols = ["todo", "doing", "review", "done"];
  return `<div class="kanban">${cols.map((c) => `<div class="kcol"><h3>${STATUS[c]}</h3>
    ${list.filter((t) => t.status === c).map((t) => `<div class="kcard" data-act="open" data-id="${t.id}">
      <div class="kt">${esc(t.title)}</div>${prioChip(t.prio)}
      <div class="kmeta">${esc(t.owner)} · ${t.comments || 0} комм.
        <span class="kmove">
          <button data-act="move" data-id="${t.id}" data-dir="-1" onclick="event.stopPropagation()">←</button>
          <button data-act="move" data-id="${t.id}" data-dir="1" onclick="event.stopPropagation()">→</button>
        </span></div></div>`).join("") || `<div class="empty" style="padding:14px;font-size:12px">—</div>`}
  </div>`).join("")}</div>`;
}
function timeline(list) {
  const start = new Date("2026-08-21T00:00:00Z"); const days = 14;
  const head = Array.from({ length: days }, (_, i) => { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return d; });
  const col = (d) => `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
  const idx = (iso) => iso ? Math.round((new Date(iso + "T00:00:00Z") - start) / 86400000) : null;
  return `<table class="tasks"><thead><tr><th>задача</th>${head.map((d) => `<th style="text-align:center;color:${[0, 6].includes(d.getUTCDay()) ? "var(--fg3)" : ""}">${col(d)}</th>`).join("")}</tr></thead><tbody>
  ${list.map((t) => { const a = Math.max(0, idx(t.start) ?? 0); const b = Math.min(days - 1, idx(t.due) ?? a); return `<tr data-act="open" data-id="${t.id}"><td>${esc(t.title)}</td>
    ${head.map((_, i) => { const on = i >= a && i <= b; return `<td style="padding:4px 2px"><div style="height:14px;border-radius:4px;background:${on ? (t.status === "done" ? "var(--ok-soft)" : "var(--accent-soft)") : "transparent"};border:${on ? "1px solid var(--accent-line)" : "none"}"></div></td>`; }).join("")}</tr>`; }).join("")}
  </tbody></table>`;
}

// ---------- chat ----------
function chat() {
  const f = S.full; if (!f || !f.task) return "";
  const t = f.task, d = f.dialog || {};
  const handed = t.handed;
  const complete = d.f_objective && d.f_owner && d.f_dod;
  return `<div class="chat">
    <div class="chead">
      <div class="lbl">лина · диалог задачи ${d.id ? esc(d.id) : ""}</div>
      <h2>${esc(t.title)}</h2>
      <div class="chips">${statusChip(t.status)} ${prioChip(t.prio)} <span class="chip">${esc(t.owner)}</span> ${t.due ? `<span class="chip mono">${esc(t.due)}</span>` : ""}
        <span style="flex:1"></span><button class="btn sm" data-act="card">карточка ↗</button><button class="btn sm ghost" data-act="closechat">✕</button></div>
    </div>
    <div class="msgs" id="msgs">
      ${(f.messages || []).map(msg).join("")}
      ${d.status === "working" && !handed ? `<div class="working"></div>` : ""}
    </div>
    ${handed
      ? `<div class="handover done">✓ задача передана исполнителю · поля зафиксированы ${t.request_id ? "· " + esc(t.request_id) : ""}</div>`
      : `<div class="handover"><button class="btn pri" data-act="handover" ${complete ? "" : "disabled"} style="width:100%">Передать исполнителю →</button>
         <div class="note">Уйдёт текст задачи. ${complete ? "Обращение полное." : "Сначала заполните владельца и критерии приёмки."} После передачи поля меняет только диалог.</div></div>`}
    ${handed ? "" : `<div class="composer">
      <div class="quick">
        <button class="btn sm" data-act="q" data-t="срок +1 день">срок +1 день</button>
        <button class="btn sm" data-act="q" data-t="приоритет высокий">приоритет: высокий</button>
        <button class="btn sm" data-act="q" data-t="в работу">в работу</button>
      </div>
      <div class="crow"><input id="composer" placeholder='напишите: "срок 25.08", "владелец internal", "критерии …" или ответ на вопрос'>
        <button class="btn pri" data-act="send">Отправить</button></div>
    </div>`}
  </div>`;
}
function msg(m) {
  if (m.kind === "you") return `<div class="m you">${esc(m.text)}</div>`;
  if (m.kind === "reply") return `<div class="m reply">${esc(m.text)}${m.redelivered ? `<div class="answered">доставлено повторно — тот же ответ</div>` : ""}</div>`;
  if (m.kind === "note") return `<div class="m note">${esc(m.text)}</div>`;
  if (m.kind === "question") return `<div class="m question"><div class="qfield">поле: ${esc(m.field)}</div>${esc(m.text)}
    ${m.answered ? `<div class="answered">✓ поле заполнено: ${esc(m.answerText || "")}</div>`
      : `<div class="ans"><input data-answer placeholder="${esc(m.placeholder || "")}"><button class="btn sm pri" data-act="answer">Ответить</button></div>`}</div>`;
  if (m.kind === "result") return `<div class="m result"><b>${esc(m.title || "результат")}</b><div>${esc(m.text || "")}</div><div class="answered">проверен egress PACT</div></div>`;
  return `<div class="m note">${esc(m.text || m.kind)}</div>`;
}

// ---------- task card modal ----------
function cardModal() {
  const f = S.full; if (!f) return "";
  const t = f.task; const locked = t.handed;
  const owners = [...new Set(S.tasks.map((x) => x.owner)), "internal", "notion-demo"].filter((v, i, a) => a.indexOf(v) === i);
  return `<div class="overlay" data-act="closecard-bg"><div class="modal" onclick="event.stopPropagation()">
    <div class="field"><label>заголовок</label><input id="c_title" value="${esc(t.title)}" ${locked ? "disabled" : ""}></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field"><label>статус</label><select id="c_status" ${locked ? "disabled" : ""}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${t.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div class="field"><label>владелец</label><select id="c_owner" ${locked ? "disabled" : ""}>${owners.map((o) => `<option ${t.owner === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>
      <div class="field"><label>приоритет</label><select id="c_prio" ${locked ? "disabled" : ""}>${["высокий", "обычный", "низкий"].map((p) => `<option ${t.prio === p ? "selected" : ""}>${p}</option>`).join("")}</select></div>
      <div class="field"><label>срок</label><input type="date" id="c_due" value="${esc(t.due_date || "")}" ${locked ? "disabled" : ""}></div>
    </div>
    <div class="field"><label>критерии приёмки (DoD)</label><input id="c_dod" value="${esc(t.dod)}" ${locked ? "disabled" : ""}></div>
    <div class="field linabox"><label>текст задачи для Lina — ${locked ? "передано исполнителю" : "черновик"}</label><textarea readonly>${esc(t.lina_text)}</textarea></div>
    <div class="field"><label>комментарии</label>
      ${(f.comments || []).map((c) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${esc(c.author)}</b> <span style="color:var(--fg3)">${esc(new Date(c.at).toLocaleString("ru"))}</span><div>${esc(c.text)}</div></div>`).join("") || `<div style="color:var(--fg3)">пока нет</div>`}
      <div class="crow" style="margin-top:8px"><input id="c_comment" placeholder="добавить комментарий"><button class="btn sm" data-act="addcomment">+</button></div>
    </div>
    <div class="rowbtns">${locked ? "" : `<button class="btn pri" data-act="savecard">Сохранить</button>`}<button class="btn" data-act="closecard">Закрыть</button></div>
  </div></div>`;
}

// ---------- admin zone ----------
function adminZone() {
  const nav = [["services", "Сервисы и правила"], ["secrets", "Секреты"], ["approvals", "Подтверждения"], ["view", "Просмотр экрана"]];
  return `<div class="adm">
    <div class="adm-nav">${nav.map(([k, l]) => `<div class="ai ${S.adminScreen === k ? "on" : ""}" data-act="ascreen" data-v="${k}">${l}${k === "approvals" && S.admin.approvals?.approvals?.length ? `<span class="badge">${S.admin.approvals.approvals.length}</span>` : ""}</div>`).join("")}
      <div style="color:var(--fg3);font-size:11px;margin-top:14px;padding:0 11px">обзор · клиенты · сессии — далее</div>
    </div>
    <div class="adm-body">${adminBody()}</div>
  </div>`;
}
function adminBody() {
  const a = S.admin;
  if (S.adminScreen === "services") {
    const tabs = [["allow", "Разрешённые эндпоинты"], ["irr", "Необратимость"], ["rules", "Правила и capability"]];
    const s = a.services || {};
    let grid = "";
    if (S.servicesTab === "allow") grid = gridT(["владелец", "хост", "методы", "пути", "операция", "версия"], (s.allow || []).map((r) => [r.owner, r.host, (r.methods || []).join(","), (r.paths || []).join(",") || "—", r.op, "v" + r.version]));
    else if (S.servicesTab === "irr") grid = gridT(["хост", "операция", "классификация", "версия"], (s.irr || []).map((r) => [r.host, r.op, r.cls === "irreversible" ? `<span class="err">необратимо</span>` : "обратимо", "v" + r.version]));
    else grid = gridT(["отправитель", "владелец", "capabilities", "исполнитель", "лизинг", "approval"], (s.rules || []).map((r) => [r.sender, r.owner, (r.caps || []).join(","), r.exec, r.lease + " s", r.appr ? "требуется" : "нет"]));
    return `<h1>Сервисы и правила</h1><div class="sub">политика PACT · пустой перечень запрещает всё</div>
      <div style="display:flex;gap:8px;margin-bottom:14px"><div class="stabs">${tabs.map(([k, l]) => `<button class="btn sm ${S.servicesTab === k ? "pri" : ""}" data-act="stab" data-v="${k}">${l}</button>`).join("")}</div>
      <div class="spacer"></div>${S.servicesTab === "allow" ? `<button class="btn sm" data-act="wiz" data-v="endpoint">+ Разрешить эндпоинт</button>` : S.servicesTab === "rules" ? `<button class="btn sm" data-act="wiz" data-v="rule">+ Правило</button>` : `<button class="btn sm" data-act="wiz" data-v="irr">+ Необратимость</button>`}</div>${grid}`;
  }
  if (S.adminScreen === "secrets") {
    const s = a.secrets || {};
    return `<h1>Секреты</h1><div class="sub">custody PACT</div>
      <div class="safe">🔒 сейф · значения не показываются. Внесение значения — консолью <span class="mono">lpmc-admin</span> (мастер-ключ на веб не выносится).</div>
      ${gridT(["имя", "владелец", "назначение", "обновлён"], (s.secrets || []).map((r) => [r.name, r.owner, r.purpose, r.updated]))}`;
  }
  if (S.adminScreen === "approvals") {
    const s = a.approvals || {};
    return `<h1>Подтверждения</h1><div class="sub">доверенный путь · необратимые действия</div>
      ${(s.approvals || []).length ? gridT([" id", "хост", "операция", "состояние", "создано"], s.approvals.map((r) => [r.id, r.host, r.op, r.state, r.created])) : `<div class="empty">Ожидающих подтверждений нет.</div>`}
      <div class="sub" style="margin-top:12px">Решение по подтверждению — через доверенный путь <span class="mono">approvald</span> (одноразовая ссылка).</div>`;
  }
  if (S.adminScreen === "view") {
    const s = a.instances || {};
    return `<h1>Просмотр экрана</h1><div class="sub">human-view · MITA · капча/вход/MFA</div>
      ${gridT(["инстанс", "владелец", "хост", "состояние"], (s.instances || []).map((r) => [r.id, r.owner, r.host, r.state]))}
      <div class="sub" style="margin-top:12px">Выдача одноразовой ссылки просмотра — сервисом <span class="mono">lpmc-view</span> (30 мин TTL).</div>`;
  }
  return "";
}
function gridT(cols, rows) {
  return `<table class="grid"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? "k" : ""}">${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length}" style="color:var(--fg3)">пусто</td></tr>`}
  </tbody></table>`;
}

// ---------- drawers (wizards) ----------
function drawer() {
  const w = S.drawer;
  if (w === "endpoint") return `<div class="overlay" data-act="closedrawer-bg"><div class="drawer" onclick="event.stopPropagation()">
    <h1 class="grot">Разрешить эндпоинт</h1><div class="sub">строка allowlist PACT</div>
    <div class="field"><label>владелец (слаг или *)</label><input id="w_owner" value="internal"></div>
    <div class="field"><label>хост</label><input id="w_host" placeholder="api.example.com"></div>
    <div class="field"><label>методы (через запятую)</label><input id="w_methods" value="GET"></div>
    <div class="field"><label>префиксы путей (через запятую, пусто = любой)</label><input id="w_paths" placeholder="/v1/…"></div>
    <div class="field"><label>тип операции</label><select id="w_op"><option>auto</option><option>read</option><option>write</option><option>delete</option></select></div>
    <div class="rowbtns"><button class="btn pri" data-act="wsubmit" data-v="endpoint">Добавить</button><button class="btn" data-act="closedrawer">Отмена</button></div></div></div>`;
  if (w === "rule") return `<div class="overlay" data-act="closedrawer-bg"><div class="drawer" onclick="event.stopPropagation()">
    <h1 class="grot">Правило</h1><div class="sub">отправитель + владелец → полномочия</div>
    <div class="field"><label>отправитель (канал:идентификатор)</label><input id="w_sender" placeholder="web:andrey"></div>
    <div class="field"><label>владелец</label><input id="w_owner" value="internal"></div>
    <div class="field"><label>capabilities (через запятую)</label><input id="w_caps" placeholder="page.read, page.screenshot"></div>
    <div class="field"><label>исполнитель</label><select id="w_exec"><option>mita</option><option>cita</option></select></div>
    <div class="field"><label>лизинг, секунд</label><input id="w_lease" value="1800"></div>
    <div class="field"><label><input type="checkbox" id="w_appr"> требовать approval</label></div>
    <div class="rowbtns"><button class="btn pri" data-act="wsubmit" data-v="rule">Добавить</button><button class="btn" data-act="closedrawer">Отмена</button></div></div></div>`;
  if (w === "irr") return `<div class="overlay" data-act="closedrawer-bg"><div class="drawer" onclick="event.stopPropagation()">
    <h1 class="grot">Необратимость</h1><div class="sub">классификация операции</div>
    <div class="field"><label>хост</label><input id="w_host" placeholder="api.example.com"></div>
    <div class="field"><label>тип операции</label><select id="w_op"><option>write</option><option>delete</option><option>read</option></select></div>
    <div class="field"><label>классификация</label><select id="w_cls"><option>irreversible</option><option>reversible</option></select></div>
    <div class="rowbtns"><button class="btn pri" data-act="wsubmit" data-v="irr">Добавить</button><button class="btn" data-act="closedrawer">Отмена</button></div></div></div>`;
  return "";
}

// ---------- wiring ----------
async function loadAdmin(screen) {
  try {
    if (screen === "services") S.admin.services = await api("admin/services");
    if (screen === "secrets") S.admin.secrets = await api("admin/secrets");
    if (screen === "approvals") S.admin.approvals = await api("admin/approvals");
    if (screen === "view") S.admin.instances = await api("admin/instances");
  } catch (e) { toast(e.message, "err"); }
  render();
}
function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ""; }

function wire() {
  const app = $("#app");
  app.onclick = async (ev) => {
    const el = ev.target.closest("[data-act]"); if (!el) return;
    const act = el.dataset.act, v = el.dataset.v, id = el.dataset.id;
    try {
      if (act === "zone") { S.zone = v; if (v === "admin") await loadAdmin(S.adminScreen); else render(); }
      else if (act === "view") { S.taskView = v; render(); }
      else if (act === "live") { S.live = !S.live; render(); }
      else if (act === "fowner") { return; } else if (act === "fstatus") { return; }
      else if (act === "resetf") { S.fOwner = ""; S.fStatus = ""; render(); }
      else if (act === "newtask") { const t = await api("tasks", "POST", { title: "Новая задача", owner: "internal" }); await loadTasks(); await openTask(t.task.id); toast("задача создана"); }
      else if (act === "open") await openTask(id);
      else if (act === "closechat") { S.selId = null; S.full = null; render(); }
      else if (act === "move") { await api(`tasks/${id}/move`, "POST", { dir: Number(el.dataset.dir) }); await loadTasks(); if (S.selId === id) await refreshFull(); render(); }
      else if (act === "send") await send();
      else if (act === "q") { await sendText(el.dataset.t); }
      else if (act === "answer") { const inp = el.closest(".ans").querySelector("[data-answer]"); await sendText(inp.value); }
      else if (act === "handover") { const r = await api(`tasks/${S.selId}/handover`, "POST"); if (r.ok) { S.full = r.full; await loadTasks(); toast("передано исполнителю"); render(); } else toast(r.reason, "err"); }
      else if (act === "card") { S.cardOpen = true; render(); }
      else if (act === "closecard" || act === "closecard-bg") { S.cardOpen = false; render(); }
      else if (act === "savecard") await saveCard();
      else if (act === "addcomment") { const t = val("c_comment"); if (t) { S.full = await api(`tasks/${S.selId}/comment`, "POST", { text: t }); render(); } }
      // admin
      else if (act === "ascreen") { S.adminScreen = v; await loadAdmin(v); }
      else if (act === "stab") { S.servicesTab = v; render(); }
      else if (act === "wiz") { S.drawer = v; render(); }
      else if (act === "closedrawer" || act === "closedrawer-bg") { S.drawer = null; render(); }
      else if (act === "wsubmit") await submitWizard(v);
    } catch (e) { toast(e.message, "err"); }
  };
  app.onchange = (ev) => {
    const el = ev.target.closest("[data-act]"); if (!el) return;
    if (el.dataset.act === "fowner") { S.fOwner = el.value; render(); }
    if (el.dataset.act === "fstatus") { S.fStatus = el.value; render(); }
  };
  const comp = document.getElementById("composer");
  if (comp) comp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } };
  const box = document.getElementById("msgs"); if (box) box.scrollTop = box.scrollHeight;
}

async function send() { const inp = document.getElementById("composer"); if (!inp) return; const t = inp.value.trim(); if (t) await sendText(t); }
async function sendText(text) { if (!S.selId || !text) return; S.full = await api(`tasks/${S.selId}/message`, "POST", { text }); await loadTasks(); render(); }
async function saveCard() {
  const body = { title: val("c_title"), owner: val("c_owner"), status: val("c_status"), prio: val("c_prio"), due_date: val("c_due"), dod: val("c_dod") };
  S.full = await api(`tasks/${S.selId}`, "PATCH", body); await loadTasks(); S.cardOpen = false; toast("сохранено"); render();
}
async function submitWizard(kind) {
  try {
    if (kind === "endpoint") { await api("admin/allow", "POST", { owner: val("w_owner"), host: val("w_host"), methods: val("w_methods").split(",").map((s) => s.trim()).filter(Boolean), paths: val("w_paths").split(",").map((s) => s.trim()).filter(Boolean), op: val("w_op") }); }
    else if (kind === "rule") { await api("admin/rule", "POST", { sender: val("w_sender"), owner: val("w_owner"), caps: val("w_caps").split(",").map((s) => s.trim()).filter(Boolean), exec: val("w_exec"), lease: Number(val("w_lease")) || 1800, appr: document.getElementById("w_appr").checked }); }
    else if (kind === "irr") { await api("admin/irr", "POST", { host: val("w_host"), op: val("w_op"), cls: val("w_cls") }); }
    S.drawer = null; toast("добавлено"); await loadAdmin(S.adminScreen);
  } catch (e) { toast(e.message, "err"); }
}

// ---------- boot ----------
(async () => { try { await loadTasks(); } catch (e) { toast("нет связи с API: " + e.message, "err"); } render(); })();
