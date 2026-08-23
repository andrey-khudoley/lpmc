/* Мобильное приложение LPMC.
   Отдельный интерфейс (не адаптация десктопной панели) поверх тех же реальных
   API. Никакого фреймворка: экран целиком перерисовывается из состояния —
   на объёмах операторской панели это дешевле и предсказуемее, чем диффы. */
(function () {
  "use strict";

  // Приложение живёт в подкаталоге m/, поэтому путь к API — на уровень выше.
  // Относительный, чтобы работать и под префиксом обратного прокси (/lpmc/).
  var API = "../api";
  var S = {
    tab: "tasks",            // tasks | lina | admin
    view: null,              // {name, ...} — экран поверх вкладки (стек глубиной 1)
    sheet: null,             // форма снизу
    toast: null,
    loading: true,
    tasks: [], task: null,   // список и открытая задача
    inbox: [],               // общий диалог Лины
    admin: null,             // {owners, bindings, allow, irr, rules, secrets, approvals, types, llm}
    section: null,           // открытый раздел админки
    assist: {},              // ленты ассистента по scope
    draft: {},               // черновики полей форм
    filter: "all",
    wiz: { step: 1 },       // мастер сценария
  };

  // ---- сеть -----------------------------------------------------------------
  function api(path, method, body) {
    return fetch(API + "/" + path, {
      method: method || "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = {}; try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { error: t }; }
        if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
        return d;
      });
    });
  }
  function toast(label, text) {
    S.toast = { label: label, text: text }; render();
    clearTimeout(toast._t); toast._t = setTimeout(function () { S.toast = null; render(); }, 3400);
  }
  function fail(e) { toast("ошибка", e && e.message ? e.message : String(e)); }

  // ---- утилиты --------------------------------------------------------------
  function h(html) { return String(html == null ? "" : html)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function hhmm(at) { var d = new Date(at); return isNaN(d) ? "" : d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function dmy(s) { if (!s) return ""; var p = String(s).split("-"); return p.length === 3 ? p[2] + "." + p[1] : s; }
  var STATUS = { todo: ["к выполнению", "dim"], doing: ["в работе", "acc"], review: ["на проверке", "warn"], done: ["готово", "ok"] };

  // ---- загрузка -------------------------------------------------------------
  function loadTasks() {
    return api("tasks").then(function (r) { S.tasks = r.tasks || []; });
  }
  function loadTask(id) {
    return api("tasks/" + id).then(function (r) { S.task = r; });
  }
  function loadInbox() {
    return api("lina/inbox").then(function (r) { S.inbox = r.messages || []; });
  }
  function loadAdmin() {
    return Promise.all([
      api("admin/owners"), api("admin/services"), api("admin/secrets"),
      api("admin/approvals"), api("tasktypes"), api("admin/llm"), api("admin/assistant"),
    ]).then(function (a) {
      S.admin = {
        owners: a[0].owners || [], bindings: a[0].bindings || [],
        allow: a[1].allow || [], irr: a[1].irr || [], rules: a[1].rules || [],
        secrets: a[2].secrets || [], approvals: a[3].approvals || [],
        types: a[4].types || [], llm: a[5].providers || [],
      };
      S.assist = {};
      (a[6].messages || []).forEach(function (m) {
        (S.assist[m.scope || ""] = S.assist[m.scope || ""] || []).push(m);
      });
    });
  }
  function boot() {
    S.loading = true; render();
    var p = S.tab === "tasks" ? loadTasks() : S.tab === "lina" ? loadInbox() : loadAdmin();
    p.catch(fail).then(function () { S.loading = false; render(); });
  }

  // ---- действия -------------------------------------------------------------
  function openTask(id) {
    S.view = { name: "task", id: id }; S.loading = true; render();
    loadTask(id).catch(fail).then(function () { S.loading = false; render(); });
  }
  function back() { S.view = null; S.task = null; render(); if (S.tab === "tasks") loadTasks().then(render); }

  function sendTaskMsg(id, text) {
    return api("tasks/" + id + "/message", "POST", { text: text })
      .then(function () { return loadTask(id); }).then(render).catch(fail);
  }
  function sendLina(text) {
    return api("lina/inbox", "POST", { text: text }).then(function (r) {
      S.inbox = r.messages || [];
      if (r.createdTaskId) { toast("лина", "задача создана"); loadTasks(); }
      render();
    }).catch(fail);
  }
  function handover(id) {
    api("tasks/" + id + "/handover", "POST").then(function (r) {
      if (!r.ok) { toast("нельзя передать", r.reason || ""); return; }
      toast("передано", "исполнение запущено");
      return loadTask(id).then(render);
    }).catch(fail);
  }
  function decide(id, decision) {
    var note = "";
    if (decision === "rejected") { note = prompt("Что не так с результатом?") || ""; if (!note.trim()) return; }
    api("tasks/" + id + "/result-decision", "POST", { decision: decision, note: note })
      .then(function () { return loadTask(id); }).then(render).catch(fail);
  }
  function delTask(id) {
    if (!confirm("Удалить задачу безвозвратно?")) return;
    api("tasks/" + id, "DELETE").then(function () { toast("задача", "удалена"); back(); }).catch(fail);
  }
  function sendAssist(scope, text) {
    return api("admin/assistant", "POST", { text: text, scope: scope }).then(function (r) {
      S.assist = {};
      (r.messages || []).forEach(function (m) { (S.assist[m.scope || ""] = S.assist[m.scope || ""] || []).push(m); });
      return loadAdmin();
    }).then(render).catch(fail);
  }

  // ---- разметка -------------------------------------------------------------
  function appbar(title, opts) {
    opts = opts || {};
    return '<div class="appbar">'
      + (opts.back ? '<button class="iconbtn" data-act="back">‹</button>' : '<div style="width:8px"></div>')
      + "<h1>" + h(title) + "</h1>"
      + (opts.action ? '<button class="abact" data-act="' + opts.action.act + '">' + h(opts.action.label) + "</button>" : "")
      + "</div>";
  }
  // Иконки — инлайновый SVG: шрифтовые символы (☰ ◆ ⚙) на части устройств
  // отсутствуют и рисуются «квадратиком».
  var ICON = {
    tasks: '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6">'
      + '<path d="M3 5h14M3 10h14M3 15h9"/></svg>',
    lina: '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6">'
      + '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-4 3v-3H4.5A1.5 1.5 0 0 1 3 12.5z"/></svg>',
    admin: '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6">'
      + '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4"/></svg>',
  };
  function tabbar() {
    var t = [["tasks", "Задачи"], ["lina", "Лина"], ["admin", "Админ"]];
    return '<div class="tabs">' + t.map(function (x) {
      return '<button class="tab' + (S.tab === x[0] ? " on" : "") + '" data-tab="' + x[0] + '">'
        + '<span class="ic">' + ICON[x[0]] + "</span>" + x[1] + "</button>";
    }).join("") + "</div>";
  }
  function composer(ph, act, val) {
    return '<div class="composer"><input id="cmp" placeholder="' + h(ph) + '" value="' + h(val || "") + '">'
      + '<button data-act="' + act + '">→</button></div>';
  }

  // ---- экран: список задач --------------------------------------------------
  function viewTasks() {
    var f = S.filter, list = S.tasks.filter(function (t) { return f === "all" || t.status === f; });
    var chips = [["all", "все"], ["todo", "к выполнению"], ["doing", "в работе"], ["review", "на проверке"], ["done", "готово"]];
    var body = list.length ? list.map(function (t) {
      var st = STATUS[t.status] || [t.status, "dim"];
      return '<div class="card" data-open="' + h(t.id) + '">'
        + "<h3>" + h(t.title) + "</h3>"
        + '<div class="row">'
          + '<span class="chip ' + st[1] + '">' + h(st[0]) + "</span>"
          + '<span class="chip dim">' + h(t.owner) + "</span>"
          + (t.prio && t.prio !== "обычный" ? '<span class="chip warn">' + h(t.prio) + "</span>" : "")
          + (t.due ? '<span class="chip dim">до ' + h(dmy(t.due)) + "</span>" : "")
        + "</div></div>";
    }).join("") : '<div class="empty">Задач нет.<br>Опишите задачу Лине — она квалифицирует и создаст её.</div>';
    return appbar("Задачи", { action: { act: "newtask", label: "+ Задача" } })
      + '<div class="screen">'
      + '<div class="strip">' + chips.map(function (c) {
          return '<button data-filter="' + c[0] + '"' + (f === c[0] ? ' class="on"' : "") + ">" + c[1] + "</button>";
        }).join("") + "</div>"
      + body + "</div>" + tabbar();
  }

  // ---- экран: задача --------------------------------------------------------
  function msgBlock(m) {
    if (m.kind === "you") return '<div class="msg you"><span class="who">ВЫ · ' + hhmm(m.at) + '</span><div class="bub">' + h(m.text) + "</div></div>";
    if (m.kind === "reply") return '<div class="msg lina"><span class="who">ЛИНА · ' + hhmm(m.at) + '</span><div class="bub">' + h(m.text) + "</div></div>";
    if (m.kind === "note") return '<div class="msg note"><div class="bub">' + h(m.text) + "</div></div>";
    if (m.kind === "question") {
      return '<div class="qcard"><span class="who mono" style="font-size:9.5px;letter-spacing:.14em;color:var(--accent)">УТОЧНЕНИЕ · ' + h(m.field || "") + "</span>"
        + '<div class="q">' + h(m.text) + "</div>"
        + (m.answered ? '<span class="dim mono" style="font-size:11px">✓ ' + h(m.answerText || "заполнено") + "</span>" : "") + "</div>";
    }
    if (m.kind === "result") {
      var dec = m.decision;
      return '<div class="result"><div class="rh">результат исполнителя</div>'
        + '<div class="rb">' + h(m.text) + "</div>"
        + (dec ? '<div class="rb dim" style="border-top:1px solid var(--line)">' + (dec === "accepted" ? "принято" : "не принято") + "</div>"
              : '<div class="btnrow" style="padding:12px"><button class="btn" data-act="accept">Принять</button>'
                + '<button class="btn dan" data-act="reject">Не принять</button></div>')
        + "</div>";
    }
    return "";
  }
  function viewTask() {
    if (!S.task) return appbar("Задача", { back: true }) + '<div class="spin"></div>' + tabbar();
    var t = S.task.task, st = STATUS[t.status] || [t.status, "dim"];
    var msgs = (S.task.messages || []).map(msgBlock).join("");
    return appbar(t.title, { back: true })
      + '<div class="screen haschat">'
      + '<div class="pad row" style="padding-bottom:10px">'
        + '<span class="chip ' + st[1] + '">' + h(st[0]) + "</span>"
        + '<span class="chip dim">' + h(t.owner) + "</span>"
        + (t.due ? '<span class="chip dim">до ' + h(dmy(t.due)) + "</span>" : "")
        + (t.handed ? '<span class="chip acc">передана</span>' : "")
      + "</div>"
      + '<div class="card" style="gap:10px">'
        + '<div class="kv"><b>цель</b><span>' + h(t.title) + "</span></div>"
        + '<div class="kv"><b>критерии</b><span>' + (t.dod ? h(t.dod) : '<i class="dim">не заданы</i>') + "</span></div>"
        + (t.request_id ? '<div class="kv"><b>запуск</b><span class="mono" style="font-size:11px">' + h(t.request_id) + "</span></div>" : "")
      + "</div>"
      + (!t.handed ? '<div class="btnrow"><button class="btn" data-act="handover">Передать исполнителю →</button></div>' : "")
      + '<div class="btnrow"><button class="btn ghost" data-act="edit">Изменить поля</button>'
      + '<button class="btn dan" data-act="deltask">Удалить</button></div>'
      + '<div class="sec">диалог</div><div class="chat">' + msgs + "</div>"
      + "</div>"
      + composer(t.handed ? "Сообщение в диалог" : "Уточнить или поправить поле", "sendtask")
      + tabbar();
  }

  // ---- экран: Лина ----------------------------------------------------------
  function viewLina() {
    var msgs = S.inbox.length ? S.inbox.map(msgBlock).join("")
      : '<div class="empty">Опишите задачу словами — Лина квалифицирует и создаст её.<br><br>'
        + '<span class="mono dim" style="font-size:12px">например: «нужно зайти на example.com и проверить, что там есть слово Example»</span></div>';
    return appbar("Лина")
      + '<div class="screen haschat"><div class="chat">' + msgs + "</div></div>"
      + composer("Опишите задачу…", "sendlina") + tabbar();
  }

  // ---- экран: админка -------------------------------------------------------
  var SECTIONS = [
    { key: "wizard", title: "Мастер сценария", scope: "", hint: "настроить работающий сценарий с нуля" },
    { key: "clients", title: "Клиенты", scope: "client", hint: "владельцы задач и политики" },
    { key: "endpoints", title: "Эндпоинты", scope: "endpoint", hint: "куда разрешён выход наружу" },
    { key: "rules", title: "Правила", scope: "rule", hint: "полномочия, исполнитель, лизинг" },
    { key: "types", title: "Типы задач", scope: "tasktype", hint: "инструкции квалификации Лины" },
    { key: "secrets", title: "Секреты", scope: "", hint: "имена; значения — только консоль" },
    { key: "approvals", title: "Подтверждения", scope: "", hint: "журнал необратимых действий" },
    { key: "model", title: "Модель", scope: "", hint: "провайдеры и фейловер" },
  ];
  function viewAdmin() {
    var a = S.admin || {};
    var count = { clients: (a.owners || []).length, endpoints: (a.allow || []).length, rules: (a.rules || []).length,
      types: (a.types || []).length, secrets: (a.secrets || []).length, approvals: (a.approvals || []).length,
      model: (a.llm || []).filter(function (p) { return p.enabled; }).length };
    return appbar("Администрирование")
      + '<div class="screen">' + SECTIONS.map(function (s) {
        return '<div class="card" data-section="' + s.key + '">'
          + '<div class="row" style="justify-content:space-between"><h3>' + h(s.title) + "</h3>"
          + '<span class="chip dim">' + count[s.key] + "</span></div>"
          + '<span class="dim" style="font-size:12.5px">' + h(s.hint) + "</span></div>";
      }).join("") + "</div>" + tabbar();
  }

  function itemCard(title, chips, kvs, acts) {
    return '<div class="card">'
      + "<h3>" + h(title) + "</h3>"
      + (chips && chips.length ? '<div class="row">' + chips.join("") + "</div>" : "")
      + (kvs || []).join("")
      + (acts && acts.length ? '<div class="row" style="gap:18px;padding-top:4px">' + acts.join("") + "</div>" : "")
      + "</div>";
  }
  function actBtn(act, label, cls) { return '<span class="link' + (cls ? " " + cls : "") + '" data-act="' + act + '" style="font-size:12.5px">' + h(label) + "</span>"; }

  // ---- Мастер сценария: пять шагов до работающего сценария ------------------
  // Род работы задаёт полномочия, исполнителя и форму критериев — их не
  // спрашиваем: знать модель полномочий наизусть оператор не обязан.
  var WKINDS = [
    ["browser-extract", "Достать значение со страницы", "браузер вернёт заголовок или совпадение", 'extract-heading https://ХОСТ/'],
    ["browser-read", "Проверить страницу", "есть ли строка, тот ли код ответа", 'page-contains https://ХОСТ/ "СТРОКА"'],
    ["api-read", "Прочитать из внешнего интерфейса", "запрос к API без изменений", "rows-at-least 1"],
    ["api-write", "Создать запись во внешней системе", "необратимо: объявляется необратимость", 'record-created "НАЗВАНИЕ"'],
  ];
  function wkind() { return WKINDS.filter(function (k) { return k[0] === S.wiz.kind; })[0] || null; }

  function wizStep(n) { S.wiz.step = n; render(); }
  function wizCheck() {
    return api("admin/scenario/check", "POST", { kind: S.wiz.kind, owner: S.wiz.owner, host: S.wiz.host, sender: S.wiz.sender || "cli:operator" })
      .then(function (r) { S.wiz.checks = r.items || []; S.wiz.ready = !!r.ready; render(); }).catch(fail);
  }
  function wizApply() {
    var w = S.wiz, k = wkind();
    return api("admin/scenario/apply", "POST", {
      kind: w.kind, owner: w.owner, ownerCategory: "client", host: w.host,
      methods: [w.method || "GET"], paths: w.paths ? w.paths.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : [],
      sender: w.sender || "cli:operator", lease: 1800, approval: false,
      typeName: w.typeName || (k ? k[1] : ""), keywords: w.keywords || "", clarify: w.clarify || "",
      dodTemplate: w.dodTemplate || (k ? k[3] : ""),
    }).then(function (r) {
      if (!r.ok) { toast("не удалось", r.reason || ""); return; }
      S.wiz.done = r.steps || []; S.wiz.step = 6;
      toast("сценарий", "заведён");
      return loadAdmin().then(wizCheck);
    }).catch(fail);
  }

  function viewWizard() {
    var w = S.wiz, k = wkind(), a = S.admin || {};
    var owners = (a.owners || []).filter(function (o) { return !o.archived; }).map(function (o) { return o.slug; });
    // Клиент по умолчанию — первый действующий: пустой выбор на шаге «далее»
    // выглядел бы отказом без причины.
    if (!w.owner && owners.length) w.owner = owners[0];
    var pills = ["род", "клиент", "хост", "инструкция", "проверка"].map(function (label, i) {
      var st = w.step === i + 1 ? "acc" : w.step > i + 1 ? "ok" : "dim";
      return '<span class="chip ' + st + '">' + (i + 1) + " " + label + "</span>";
    }).join("");
    var body = "", title = "", lead = "", next = "Далее →";

    if (w.step === 1) {
      title = "Что должна делать система?"; lead = "Полномочия и форма критериев следуют из рода работы.";
      body = WKINDS.map(function (x) {
        return '<div class="card" data-act="wkind:' + x[0] + '"' + (w.kind === x[0] ? ' style="border-color:var(--accent-line)"' : "") + ">"
          + "<h3>" + h(x[1]) + "</h3><span class=\"dim\" style=\"font-size:12.5px\">" + h(x[2]) + "</span>"
          + '<span class="mono dim" style="font-size:11px">' + h(x[3]) + "</span></div>";
      }).join("");
    } else if (w.step === 2) {
      title = "Для кого и от кого"; lead = "Клиент — единица изоляции. Отправитель для панели — cli:operator.";
      body = '<div class="field"><label>клиент</label><div class="opts" data-wopts="owner">'
        + owners.map(function (o) { return '<button data-val="' + h(o) + '"' + (w.owner === o ? ' class="on"' : "") + ">" + h(o) + "</button>"; }).join("")
        + "</div></div>"
        + '<div class="field"><label>или новый клиент</label><input id="w_ownerNew" value="' + h(w.ownerNew || "") + '" placeholder="acme-school"><span class="hint">заполните, только если клиента ещё нет</span></div>'
        + '<div class="field"><label>отправитель</label><input id="w_sender" value="' + h(w.sender || "cli:operator") + '"></div>';
    } else if (w.step === 3) {
      title = "Куда ходить наружу"; lead = "Хост разрешается на обеих границах, в форме с www и без.";
      body = '<div class="field"><label>хост</label><input id="w_host" value="' + h(w.host || "") + '" placeholder="example.com"><span class="hint">без схемы и путей</span></div>'
        + '<div class="field"><label>метод</label><div class="opts" data-wopts="method">'
        + ["GET", "POST", "PUT", "PATCH", "DELETE"].map(function (m) { return '<button data-val="' + m + '"' + ((w.method || "GET") === m ? ' class="on"' : "") + ">" + m + "</button>"; }).join("")
        + "</div></div>"
        + '<div class="field"><label>префиксы путей</label><input id="w_paths" value="' + h(w.paths || "") + '" placeholder="/v1/data"><span class="hint">через запятую; пусто = любой путь</span></div>';
    } else if (w.step === 4) {
      title = "Инструкция Лины"; lead = "По ключевым словам Лина подберёт тип и подставит форму критериев.";
      body = '<div class="field"><label>название типа</label><input id="w_typeName" value="' + h(w.typeName || (k ? k[1] : "")) + '"></div>'
        + '<div class="field"><label>ключевые слова</label><input id="w_keywords" value="' + h(w.keywords || "") + '" placeholder="заголовок, страница"></div>'
        + '<div class="field"><label>что уточнять</label><input id="w_clarify" value="' + h(w.clarify || "") + '" placeholder="адрес страницы"></div>'
        + '<div class="field"><label>шаблон критериев</label><input id="w_dodTemplate" value="' + h(w.dodTemplate || (k ? k[3] : "")) + '"></div>';
    } else if (w.step === 5) {
      title = "Проверка готовности"; lead = "Красное мешает работать, жёлтое — просто нужно знать."; next = "Завести сценарий";
      body = (w.checks || []).map(function (c) {
        return '<div class="card"><div class="row"><span class="chip ' + (c.ok ? "ok" : c.blocking ? "dan" : "warn") + '">'
          + (c.ok ? "✓" : c.blocking ? "✗" : "!") + '</span><h3 style="font-size:14px">' + h(c.label) + "</h3></div>"
          + '<span class="dim" style="font-size:12px">' + h(c.detail) + "</span></div>";
      }).join("") || '<span class="spin"></span>';
    } else {
      title = "Сценарий готов"; lead = "Опишите задачу Лине — она подберёт тип и подставит критерии."; next = "Проверить ещё раз";
      body = '<div class="card" style="border-color:var(--ok)">'
        + '<span class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--ok)">СЦЕНАРИЙ ЗАВЕДЁН</span>'
        + (w.done || []).map(function (t) { return '<span class="mono dim" style="font-size:11.5px">• ' + h(t) + "</span>"; }).join("")
        + "</div>"
        + (w.checks || []).map(function (c) {
          return '<div class="row" style="padding:6px 14px"><span class="chip ' + (c.ok ? "ok" : c.blocking ? "dan" : "warn") + '">'
            + (c.ok ? "✓" : c.blocking ? "✗" : "!") + "</span><span>" + h(c.label) + "</span></div>";
        }).join("");
    }

    return appbar(title, { back: true })
      + '<div class="screen">'
      + '<div class="pad" style="padding-bottom:10px"><span class="dim" style="font-size:13px;line-height:1.55">' + h(lead) + "</span></div>"
      + '<div class="strip">' + pills + "</div>"
      + body
      + '<div class="btnrow">'
        + (w.step > 1 && w.step < 6 ? '<button class="btn ghost" data-act="wback">Назад</button>' : "")
        + '<button class="btn" data-act="wnext">' + h(next) + "</button>"
      + "</div>"
      + (w.step > 1 ? '<div class="btnrow"><button class="btn ghost" data-act="wreset">Начать заново</button></div>' : "")
      + "</div>" + tabbar();
  }

  function viewSection() {
    if (S.section === "wizard") return viewWizard();
    var s = SECTIONS.filter(function (x) { return x.key === S.section; })[0];
    var a = S.admin || {}, body = "";
    if (S.section === "clients") {
      body = (a.owners || []).map(function (o) {
        return itemCard(o.slug, ['<span class="chip ' + (o.archived ? "dim" : "acc") + '">' + h(o.archived ? "в архиве" : o.category) + "</span>"], [],
          [actBtn("owner-arch:" + o.slug, o.archived ? "вернуть" : "в архив"), actBtn("owner-del:" + o.slug, "удалить", "dan")]);
      }).join("");
      body += '<div class="sec">привязки отправителей</div>'
        + (a.bindings || []).map(function (b) {
          return itemCard(b.sender, ['<span class="chip dim">' + h(b.owner_slug) + "</span>"], []);
        }).join("");
    } else if (S.section === "endpoints") {
      body = (a.allow || []).map(function (r) {
        return itemCard(r.host, ['<span class="chip acc">' + h(r.owner) + "</span>",
          '<span class="chip dim">' + h((r.methods || []).join(", ")) + "</span>",
          '<span class="chip ' + (r.op === "delete" ? "dan" : "dim") + '">' + h(r.op) + "</span>"],
          (r.paths && r.paths.length ? ['<div class="kv"><b>пути</b><span>' + h(r.paths.join(", ")) + "</span></div>"] : []),
          [actBtn("allow-del:" + r.id, "удалить", "dan")]);
      }).join("");
    } else if (S.section === "rules") {
      body = (a.rules || []).map(function (r) {
        return itemCard(r.sender + " → " + r.owner,
          ['<span class="chip dim">' + h(r.exec) + "</span>",
           '<span class="chip dim">' + h(r.lease) + " с</span>",
           r.appr ? '<span class="chip warn">подтверждение</span>' : ""],
          ['<div class="kv"><b>полномочия</b><span>' + h((r.caps || []).join(", ")) + "</span></div>"],
          [actBtn("rule-edit:" + r.id, "изменить"), actBtn("rule-del:" + r.id, "удалить", "dan")]);
      }).join("");
    } else if (S.section === "types") {
      body = (a.types || []).map(function (t) {
        return itemCard(t.name, ['<span class="chip dim">' + h(t.executor || "любой") + "</span>"],
          [t.keywords ? '<div class="kv"><b>слова</b><span>' + h(t.keywords) + "</span></div>" : "",
           t.clarify ? '<div class="kv"><b>уточнять</b><span>' + h(t.clarify) + "</span></div>" : "",
           t.dod_template ? '<div class="kv"><b>критерии</b><span class="mono" style="font-size:11.5px">' + h(t.dod_template) + "</span></div>" : ""],
          [actBtn("type-edit:" + t.id, "изменить"), actBtn("type-del:" + t.id, "удалить", "dan")]);
      }).join("");
    } else if (S.section === "secrets") {
      body = (a.secrets || []).map(function (x) {
        return itemCard(x.name, ['<span class="chip dim">' + h(x.owner) + "</span>"],
          [x.purpose ? '<div class="kv"><b>назначение</b><span>' + h(x.purpose) + "</span></div>" : ""],
          [actBtn("secret-del:" + x.name, "удалить", "dan")]);
      }).join("") || '<div class="empty">Секретов нет. Значения вносятся консолью lpmc-admin.</div>';
    } else if (S.section === "approvals") {
      body = (a.approvals || []).map(function (x) {
        var cls = x.state === "approved" ? "ok" : x.state === "denied" ? "dan" : "warn";
        return itemCard(x.op + " · " + x.host, ['<span class="chip ' + cls + '">' + h(x.state) + "</span>",
          '<span class="chip dim">' + h(x.created || "") + "</span>"], []);
      }).join("") || '<div class="empty">Очередь пуста.</div>';
    } else if (S.section === "model") {
      body = (a.llm || []).map(function (p, i) {
        var label = p.kind === "subscription" ? "По подписке" : p.kind === "anthropic" ? "Anthropic API" : "OpenAI API";
        var st = p.kind === "subscription"
          ? (p.bridge_ok && p.login_ok ? '<span class="chip ok">через машину</span>' : '<span class="chip warn">мост недоступен</span>')
          : (p.has_key ? '<span class="chip ok">ключ задан</span>' : '<span class="chip dim">ключа нет</span>');
        return itemCard("#" + (i + 1) + " " + label,
          ['<span class="chip ' + (p.enabled ? "acc" : "dim") + '" data-act="llm-toggle:' + p.id + '">' + (p.enabled ? "включён" : "выключен") + "</span>", st],
          ['<div class="kv"><b>модель</b><span class="mono" style="font-size:11.5px">' + h(p.model) + "</span></div>"],
          [actBtn("llm-edit:" + p.id, "настроить"),
           i > 0 ? actBtn("llm-up:" + p.id, "выше") : "",
           i < (a.llm.length - 1) ? actBtn("llm-down:" + p.id, "ниже") : ""]);
      }).join("");
    }

    var log = (S.assist[s.scope] || []).map(msgBlock).join("");
    var addLabel = { clients: "+ Клиент", endpoints: "+ Эндпоинт", rules: "+ Правило", types: "+ Тип" }[S.section];
    return appbar(s.title, { back: true, action: addLabel ? { act: "add", label: addLabel } : null })
      + '<div class="screen' + (s.scope ? " haschat" : "") + '">'
      + (body || '<div class="empty">Пусто.</div>')
      + (s.scope ? '<div class="sec">ассистент раздела</div><div class="chat">' + log + "</div>" : "")
      + "</div>"
      + (s.scope ? composer("Опишите, что завести…", "sendassist") : "")
      + tabbar();
  }

  // ---- листы (формы) --------------------------------------------------------
  function field(label, id, val, hint, type) {
    return '<div class="field"><label>' + h(label) + "</label>"
      + '<input id="' + id + '" type="' + (type || "text") + '" value="' + h(val || "") + '">'
      + (hint ? '<span class="hint">' + h(hint) + "</span>" : "") + "</div>";
  }
  function options(label, id, opts, cur) {
    return '<div class="field"><label>' + h(label) + '</label><div class="opts" data-opts="' + id + '">'
      + opts.map(function (o) {
        return '<button data-val="' + h(o[0]) + '"' + (String(cur) === String(o[0]) ? ' class="on"' : "") + ">" + h(o[1]) + "</button>";
      }).join("") + "</div></div>";
  }
  function sheet(title, inner, submitLabel) {
    return '<div class="sheetwrap" data-act="sheetbd"><div class="sheet" data-stop="1">'
      + '<div class="sh"><h2>' + h(title) + '</h2><button class="iconbtn" data-act="closesheet">✕</button></div>'
      + inner
      + '<div class="btnrow" style="padding:16px 14px 0"><button class="btn" data-act="submitsheet">' + h(submitLabel) + "</button></div>"
      + "</div></div>";
  }
  function viewSheet() {
    var k = S.sheet.kind, d = S.draft, a = S.admin || {};
    var owners = (a.owners || []).filter(function (o) { return !o.archived; }).map(function (o) { return [o.slug, o.slug]; });
    if (k === "newtask") {
      return sheet("Новая задача",
        field("название", "f_title", d.title, "коротко: что нужно сделать")
        + options("клиент", "owner", owners.length ? owners : [["internal", "internal"]], d.owner || (owners[0] && owners[0][0])),
        "Создать задачу");
    }
    if (k === "edittask") {
      return sheet("Поля задачи",
        field("название", "f_title", d.title)
        + field("критерии приёмки (DoD)", "f_dod", d.dod, 'машинная форма, напр. page-contains https://хост/ "строка"')
        + field("срок (ГГГГ-ММ-ДД)", "f_due", d.due_date)
        + options("приоритет", "prio", [["низкий", "низкий"], ["обычный", "обычный"], ["высокий", "высокий"]], d.prio),
        "Сохранить");
    }
    if (k === "client") {
      return sheet("Новый клиент",
        field("слаг", "f_slug", d.slug, "строчная латиница, цифры, дефис")
        + options("категория", "category", [["client", "клиент"], ["project", "проект"], ["internal", "внутренний"]], d.category || "client"),
        "Завести клиента");
    }
    if (k === "endpoint") {
      return sheet("Разрешить эндпоинт",
        options("владелец", "owner", owners, d.owner || (owners[0] && owners[0][0]))
        + field("хост", "f_host", d.host, "например api.example.com")
        + options("методы", "methods", [["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"]], d.methods || "GET")
        + field("префиксы путей", "f_paths", d.paths, "через запятую; пусто = любой путь")
        + options("операция", "op", [["auto", "auto"], ["read", "read"], ["write", "write"], ["delete", "delete"]], d.op || "auto"),
        "Разрешить");
    }
    if (k === "rule") {
      var caps = (d.caps || "page.read,report.build").split(",");
      return sheet(d.id ? "Изменить правило" : "Новое правило",
        field("отправитель", "f_sender", d.sender || "cli:operator", "канал:актор, для веб-оператора cli:operator")
        + options("владелец", "owner", owners, d.owner || (owners[0] && owners[0][0]))
        + '<div class="field"><label>полномочия</label><div class="opts" data-multi="caps">'
        + ["page.read", "page.screenshot", "report.build", "api.read", "record.create"].map(function (c) {
            return '<button data-val="' + c + '"' + (caps.indexOf(c) >= 0 ? ' class="on"' : "") + ">" + c + "</button>";
          }).join("") + "</div></div>"
        + options("исполнитель", "exec", [["mita", "mita · браузер"], ["cita", "cita · API"]], d.exec || "mita")
        + field("лизинг, сек", "f_lease", d.lease || "1800")
        + options("подтверждение", "appr", [["", "не требуется"], ["1", "требуется"]], d.appr || ""),
        d.id ? "Сохранить" : "Завести правило");
    }
    if (k === "tasktype") {
      return sheet(d.id ? "Изменить тип" : "Новый тип задачи",
        field("название", "f_name", d.name)
        + field("ключевые слова", "f_keywords", d.keywords, "через запятую; по ним Лина подбирает тип")
        + options("исполнитель", "executor", [["mita", "mita"], ["cita", "cita"], ["", "любой"]], d.executor || "mita")
        + field("что уточнять", "f_clarify", d.clarify)
        + field("шаблон критериев", "f_dod", d.dod_template, 'напр. page-contains https://ХОСТ/ "СТРОКА"'),
        d.id ? "Сохранить" : "Добавить тип");
    }
    if (k === "llm") {
      var models = (S.models && S.models[d.kind === "openai" ? "openai" : "anthropic"]) || [];
      return sheet("Провайдер · " + (d.kind === "subscription" ? "подписка" : d.kind),
        '<div class="field"><label>модель</label><select id="f_model">'
        + (models.length ? models : [{ id: d.model, label: d.model }]).map(function (m) {
            return '<option value="' + h(m.id) + '"' + (m.id === d.model ? " selected" : "") + ">" + h(m.label || m.id) + "</option>";
          }).join("") + "</select><span class=\"hint\">цена указана за 1M токенов</span></div>"
        + (d.kind === "subscription"
            ? '<div class="field"><span class="hint">Ключ не нужен: вызов исполняется на машине через /login, токен в веб не попадает.</span></div>'
            : field("API-ключ", "f_key", "", "оставьте пустым, чтобы не менять", "password")),
        "Сохранить");
    }
    return "";
  }

  // ---- рендер ---------------------------------------------------------------
  function render() {
    var html;
    if (S.loading) html = appbar(S.tab === "tasks" ? "Задачи" : S.tab === "lina" ? "Лина" : "Администрирование")
      + '<div class="spin"></div>' + tabbar();
    else if (S.view && S.view.name === "task") html = viewTask();
    else if (S.tab === "tasks") html = viewTasks();
    else if (S.tab === "lina") html = viewLina();
    else if (S.section) html = viewSection();
    else html = viewAdmin();
    if (S.sheet) html += viewSheet();
    if (S.toast) html += '<div class="toast"><b>' + h(S.toast.label) + "</b>" + h(S.toast.text) + "</div>";
    document.getElementById("app").innerHTML = html;
    var c = document.getElementById("cmp");
    if (c && S.focusComposer) { c.focus(); S.focusComposer = false; }
  }

  // ---- события --------------------------------------------------------------
  function composerValue() { var c = document.getElementById("cmp"); return c ? c.value.trim() : ""; }
  function clearComposer() { var c = document.getElementById("cmp"); if (c) c.value = ""; }

  function submitSheet() {
    var k = S.sheet.kind, d = S.draft, v = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; };
    var done = function (label, text) { S.sheet = null; S.draft = {}; toast(label, text); };
    if (k === "newtask") {
      var title = v("f_title"); if (!title) return toast("нужно", "укажите название");
      api("tasks", "POST", { title: title, owner: d.owner || "internal" }).then(function (r) {
        done("задача", "создана"); return loadTasks().then(function () { openTask(r.task.id); });
      }).catch(fail);
    } else if (k === "edittask") {
      var body = { title: v("f_title"), dod: v("f_dod") };
      if (v("f_due")) body.due_date = v("f_due");
      if (d.prio) body.prio = d.prio;
      api("tasks/" + S.view.id, "PATCH", body).then(function () {
        done("задача", "обновлена"); return loadTask(S.view.id).then(render);
      }).catch(fail);
    } else if (k === "client") {
      var slug = v("f_slug"); if (!/^[a-z0-9-]{1,64}$/.test(slug)) return toast("слаг", "строчная латиница, цифры, дефис");
      api("admin/owner", "POST", { slug: slug, category: d.category || "client" })
        .then(function () { done("клиент", slug + " заведён"); return loadAdmin().then(render); }).catch(fail);
    } else if (k === "endpoint") {
      var host = v("f_host"); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return toast("хост", "например api.example.com");
      api("admin/allow", "POST", { owner: d.owner || "internal", host: host,
        methods: [d.methods || "GET"], paths: v("f_paths") ? v("f_paths").split(",").map(function (s) { return s.trim(); }) : [], op: d.op || "auto" })
        .then(function () { done("эндпоинт", host + " разрешён"); return loadAdmin().then(render); }).catch(fail);
    } else if (k === "rule") {
      var caps = (d.caps || "").split(",").filter(Boolean);
      if (!caps.length) return toast("нужно", "выберите полномочия");
      var b = { sender: v("f_sender"), owner: d.owner || "internal", caps: caps, exec: d.exec || "mita",
        lease: Number(v("f_lease")) || 1800, appr: !!d.appr };
      api("admin/rule" + (d.id ? "/" + d.id : ""), "POST", b)
        .then(function () { done("правило", d.id ? "обновлено" : "заведено"); return loadAdmin().then(render); }).catch(fail);
    } else if (k === "tasktype") {
      var name = v("f_name"); if (!name) return toast("нужно", "укажите название");
      var t = { name: name, keywords: v("f_keywords"), executor: d.executor || "mita", clarify: v("f_clarify"), dod_template: v("f_dod") };
      api("tasktypes" + (d.id ? "/" + d.id : ""), "POST", t)
        .then(function () { done("тип", d.id ? "обновлён" : "добавлен"); return loadAdmin().then(render); }).catch(fail);
    } else if (k === "llm") {
      var body2 = { model: v("f_model") };
      if (v("f_key")) body2.apiKey = v("f_key");
      api("admin/llm/" + d.id, "POST", body2)
        .then(function () { done("модель", "сохранено"); return loadAdmin().then(render); }).catch(fail);
    }
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-act],[data-tab],[data-open],[data-section],[data-filter],[data-val]");
    if (!el) return;
    var tab = el.getAttribute("data-tab");
    if (tab) { S.tab = tab; S.view = null; S.section = null; S.task = null; boot(); return; }
    var open = el.getAttribute("data-open"); if (open) return openTask(open);
    var sec = el.getAttribute("data-section");
    if (sec) { S.section = sec; render(); if (sec === "model" && !S.models) api("admin/llm/models").then(function (m) { S.models = m; }); return; }
    var flt = el.getAttribute("data-filter"); if (flt) { S.filter = flt; return render(); }

    // выбор в форме (одиночный/множественный)
    var val = el.getAttribute("data-val");
    if (val !== null) {
      var single = el.closest("[data-opts]"), multi = el.closest("[data-multi]");
      if (single) { S.draft[single.getAttribute("data-opts")] = val; return render(); }
      if (multi) {
        var key = multi.getAttribute("data-multi");
        var cur = (S.draft[key] || "page.read,report.build").split(",").filter(Boolean);
        var i = cur.indexOf(val); if (i >= 0) cur.splice(i, 1); else cur.push(val);
        S.draft[key] = cur.join(","); return render();
      }
    }

    // выбор опции в мастере (одиночный)
    if (val !== null) {
      var wo = el.closest("[data-wopts]");
      if (wo) { S.wiz[wo.getAttribute("data-wopts")] = val; return render(); }
    }

    var act = el.getAttribute("data-act"); if (!act) return;
    var arg = act.indexOf(":") > 0 ? act.slice(act.indexOf(":") + 1) : null;
    var cmd = arg ? act.slice(0, act.indexOf(":")) : act;

    if (cmd === "back") return S.view ? back() : (S.section = null, S.wiz = { step: 1 }, render());
    if (cmd === "wkind") { S.wiz.kind = arg; return render(); }
    if (cmd === "wreset") { S.wiz = { step: 1 }; return render(); }
    if (cmd === "wback") { S.wiz.step = Math.max(1, S.wiz.step - 1); return render(); }
    if (cmd === "wnext") {
      var g = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; };
      var w = S.wiz;
      if (w.step === 1) { if (!w.kind) return toast("нужно", "выберите род сценария"); return wizStep(2); }
      if (w.step === 2) {
        w.ownerNew = g("w_ownerNew"); w.sender = g("w_sender") || "cli:operator";
        var owner = w.ownerNew || w.owner;
        if (!owner) return toast("нужно", "укажите клиента");
        w.owner = owner; return wizStep(3);
      }
      if (w.step === 3) {
        w.host = g("w_host"); w.paths = g("w_paths");
        if (!w.host) return toast("нужно", "укажите хост");
        return wizStep(4);
      }
      if (w.step === 4) {
        w.typeName = g("w_typeName"); w.keywords = g("w_keywords");
        w.clarify = g("w_clarify"); w.dodTemplate = g("w_dodTemplate");
        w.step = 5; render(); return wizCheck();
      }
      if (w.step === 5) return wizApply();
      return wizCheck();
    }
    if (cmd === "closesheet" || cmd === "sheetbd") { if (el.getAttribute("data-stop")) return; S.sheet = null; S.draft = {}; return render(); }
    if (cmd === "submitsheet") return submitSheet();
    if (cmd === "newtask") { S.sheet = { kind: "newtask" }; S.draft = {}; return render(); }
    if (cmd === "add") {
      var kind = { clients: "client", endpoints: "endpoint", rules: "rule", types: "tasktype" }[S.section];
      S.sheet = { kind: kind }; S.draft = {}; return render();
    }
    if (cmd === "edit") { var t = S.task.task; S.sheet = { kind: "edittask" };
      S.draft = { title: t.title, dod: t.dod, due_date: t.due_date, prio: t.prio }; return render(); }
    if (cmd === "handover") return handover(S.view.id);
    if (cmd === "deltask") return delTask(S.view.id);
    if (cmd === "accept") return decide(S.view.id, "accepted");
    if (cmd === "reject") return decide(S.view.id, "rejected");
    if (cmd === "sendtask") { var x = composerValue(); if (!x) return; clearComposer(); return sendTaskMsg(S.view.id, x); }
    if (cmd === "sendlina") { var y = composerValue(); if (!y) return; clearComposer(); return sendLina(y); }
    if (cmd === "sendassist") {
      var s = SECTIONS.filter(function (q) { return q.key === S.section; })[0];
      var z = composerValue(); if (!z) return; clearComposer(); return sendAssist(s.scope, z);
    }
    // админ-действия
    if (cmd === "owner-arch") {
      var o = (S.admin.owners || []).filter(function (x2) { return x2.slug === arg; })[0];
      return api("admin/owner-" + (o && o.archived ? "unarchive" : "archive"), "POST", { slug: arg })
        .then(function (r) { if (r.ok === false) return toast("нельзя", r.reason || ""); toast("клиент", arg); return loadAdmin().then(render); }).catch(fail);
    }
    if (cmd === "owner-del") {
      if (prompt("Удаление клиента «" + arg + "» необратимо: стираются задачи и аудит.\nВведите слаг для подтверждения:") !== arg) return;
      return api("admin/owner/" + encodeURIComponent(arg), "DELETE").then(function (r) {
        if (r.ok === false) return toast("нельзя", r.reason || ""); toast("клиент", "удалён"); return loadAdmin().then(render); }).catch(fail);
    }
    if (cmd === "allow-del" || cmd === "rule-del" || cmd === "secret-del" || cmd === "type-del") {
      if (!confirm("Удалить?")) return;
      var url = cmd === "allow-del" ? "admin/allow/" + arg : cmd === "rule-del" ? "admin/rule/" + arg
        : cmd === "secret-del" ? "admin/secret/" + encodeURIComponent(arg) : "tasktypes/" + arg;
      return api(url, "DELETE").then(function () { toast("удалено", ""); return loadAdmin().then(render); }).catch(fail);
    }
    if (cmd === "rule-edit") {
      var r2 = (S.admin.rules || []).filter(function (x3) { return String(x3.id) === arg; })[0]; if (!r2) return;
      S.sheet = { kind: "rule" }; S.draft = { id: r2.id, sender: r2.sender, owner: r2.owner,
        caps: (r2.caps || []).join(","), exec: r2.exec, lease: String(r2.lease), appr: r2.appr ? "1" : "" }; return render();
    }
    if (cmd === "type-edit") {
      var t2 = (S.admin.types || []).filter(function (x4) { return String(x4.id) === arg; })[0]; if (!t2) return;
      S.sheet = { kind: "tasktype" }; S.draft = { id: t2.id, name: t2.name, keywords: t2.keywords,
        executor: t2.executor, clarify: t2.clarify, dod_template: t2.dod_template }; return render();
    }
    if (cmd === "llm-toggle") {
      var p = (S.admin.llm || []).filter(function (x5) { return String(x5.id) === arg; })[0];
      return api("admin/llm/" + arg, "POST", { enabled: !p.enabled }).then(function () { return loadAdmin().then(render); }).catch(fail);
    }
    if (cmd === "llm-edit") {
      var p2 = (S.admin.llm || []).filter(function (x6) { return String(x6.id) === arg; })[0]; if (!p2) return;
      if (!S.models) api("admin/llm/models").then(function (m) { S.models = m; render(); });
      S.sheet = { kind: "llm" }; S.draft = { id: p2.id, kind: p2.kind, model: p2.model }; return render();
    }
    if (cmd === "llm-up" || cmd === "llm-down") {
      var ids = (S.admin.llm || []).map(function (x7) { return Number(x7.id); });
      var i2 = ids.indexOf(Number(arg)), j = cmd === "llm-up" ? i2 - 1 : i2 + 1;
      if (j < 0 || j >= ids.length) return;
      var tmp = ids[i2]; ids[i2] = ids[j]; ids[j] = tmp;
      return api("admin/llm/reorder", "POST", { ids: ids }).then(function () { return loadAdmin().then(render); }).catch(fail);
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var c = document.getElementById("cmp");
    if (c && document.activeElement === c) {
      var btn = document.querySelector(".composer button");
      if (btn) btn.click();
    }
  });

  boot();
})();
