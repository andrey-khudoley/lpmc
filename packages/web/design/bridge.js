/* LIVE DATA BRIDGE — привязка компонента макета к живому API и мосту исполнения.
   Внедряется в конец data-dc-script, где класс Component уже в области видимости.
   Рендер макета не трогаем: только заменяем источник данных (state) и действия. */
(function () {
  const API = "api";
  async function jx(path, method, body) {
    const r = await fetch(API + "/" + path, {
      method: method || "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let d = {}; try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { error: t }; }
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    return d;
  }
  const hhmm = (at) => { const d = new Date(at); return isNaN(d.getTime()) ? "" : (d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0")); };
  const csv = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

  function mapTaskList(t) {
    // Форматтер срока в макете ожидает валидную дату всегда; для задач без срока
    // подставляем старт (или дефолт), чтобы не ломать рендер.
    const o = { id: t.id, title: t.title, owner: t.owner, status: t.status, prio: t.prio,
      start: t.start || "2026-08-21", due: t.due || t.start || "2026-08-31", desc: "", lina: "", comments: [] };
    if (t.dialog_id) o.dialogId = t.dialog_id;
    return o;
  }
  function mapMsg(m) {
    const b = { id: "m" + m.id, kind: m.kind, time: hhmm(m.at) };
    if (m.kind === "you" || m.kind === "reply" || m.kind === "note") b.text = m.text;
    if (m.kind === "question") { b.field = m.field; b.text = m.text; b.answered = !!m.answered; b.answerText = m.answerText || ""; b.open = !m.answered; b.placeholder = m.placeholder || ""; }
    if (m.kind === "result") { b.title = m.title || "результат"; b.text = m.text || ""; b.artifacts = m.artifacts || []; b.decision = m.decision || null; }
    return b;
  }
  function mapDialog(full) {
    const t = full.task, d = full.dialog || {};
    return { id: "dlg-" + t.id, taskId: t.id, title: t.title, status: d.status || "draft", time: "", unread: false,
      owner: t.owner, handed: !!t.handed,
      fields: { objective: !!d.f_objective, owner: !!d.f_owner, dod: !!d.f_dod },
      messages: (full.messages || []).map(mapMsg) };
  }

  const P = Component.prototype;

  P.loadAll = async function (sel) {
    try {
      const r = await jx("tasks");
      const tasks = (r.tasks || []).map(mapTaskList);
      sel = sel || this.state.selectedTask;
      let dialogs = (this.state.dialogs || []).slice();
      if (sel && tasks.some((t) => t.id === sel)) {
        const full = await jx("tasks/" + sel);
        const ti = tasks.findIndex((t) => t.id === sel);
        if (ti >= 0) {
          tasks[ti].desc = full.task.descr || "";
          tasks[ti].lina = full.task.lina_text || "";
          tasks[ti].comments = (full.comments || []).map((c) => ({ author: c.author, time: hhmm(c.at), text: c.text }));
        }
        dialogs = dialogs.filter((x) => x.taskId !== sel);
        dialogs.push(mapDialog(full));
      }
      this.setState({ tasks, dialogs, activeId: sel ? "dlg-" + sel : this.state.activeId });
    } catch (e) { this.toast("ошибка", e.message); }
  };

  P.loadAdmin = async function () {
    try {
      const [sv, se, ap, ow, tt, lm] = await Promise.all([jx("admin/services"), jx("admin/secrets"), jx("admin/approvals"), jx("admin/owners"), jx("tasktypes"), jx("admin/llm")]);
      const stateLabel = (s) => s === "approved" ? "подтверждено" : s === "denied" ? "отказано" : s === "pending" ? "ожидает" : s;
      this.setState({
        llmProviders: (lm.providers || []).map((p) => ({ id: p.id, kind: p.kind, enabled: p.enabled, model: p.model, priority: p.priority, has_key: p.has_key })),
        taskTypes: (tt.types || []).map((t) => ({ id: t.id, name: t.name, keywords: t.keywords, executor: t.executor, clarify: t.clarify, dod_template: t.dod_template })),
        // Для выбора владельца в мастерах — только действующие: архивный лишён
        // правил и привязок, обращение к нему получило бы отказ на валидации.
        realOwners: (ow.owners || []).filter((o) => !o.archived).map((o) => o.slug),
        ownerRows: (ow.owners || []).map((o) => ({ slug: o.slug, category: o.category, archived: !!o.archived, archived_on: o.archived_on })),
        bindingRows: (ow.bindings || []).map((b) => ({ sender: b.sender, route: b.route, owner: b.owner_slug })),
        allow: (sv.allow || []).map((a) => ({ owner: a.owner, host: a.host, methods: a.methods, paths: a.paths, op: a.op, version: a.version })),
        irr: (sv.irr || []).map((a) => ({ host: a.host, op: a.op, cls: a.cls, version: a.version })),
        rules: (sv.rules || []).map((a) => ({ id: a.id, sender: a.sender, owner: a.owner, caps: a.caps, exec: a.exec, lease: a.lease, leaseLabel: a.lease + " s", appr: a.appr })),
        secrets: (se.secrets || []).map((s) => ({ name: s.name, owner: s.owner, purpose: s.purpose, updated: s.updated })),
        approvals: (ap.approvals || []).map((a) => ({ id: a.id, host: a.host, op: a.op, state: a.state, stateLabel: stateLabel(a.state), created: a.created || "", title: a.op + " · " + a.host, owner: "" })),
        instances: [],
      });
    } catch (e) { this.toast("ошибка", e.message); }
  };

  const origCDM = P.componentDidMount;
  P.componentDidMount = function () {
    if (origCDM) try { origCDM.call(this); } catch (e) { /* оригинальные таймеры */ }
    // Стереть мок-данные и загрузить живые.
    // selectedTask сбрасываем: мок-дефолт 't1' реальной задачей не подкреплён,
    // а при нём общий диалог Лины не считался бы активным.
    this.setState({ tasks: [], dialogs: [], inbox: [], adminInbox: [], selectedTask: null, allow: [], irr: [], rules: [], secrets: [], approvals: [], instances: [] });
    // На телефоне стартуем со списка задач: чат открывается тапом по задаче.
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 680px)").matches) {
      this.setState({ chatHidden: true });
    }
    this.loadAll(this.state.selectedTask);
    this.loadAdmin();
    this.loadInbox();
    this.loadAdminInbox();
    this.__poll = setInterval(() => {
      const t = (this.state.tasks || []).find((x) => x.id === this.state.selectedTask);
      if (t && t.status === "doing" && this.live) this.loadAll(this.state.selectedTask);
    }, 3500);
  };
  P.mockDelivery = function () { /* реальный поток вместо симуляции */ };

  P.loadInbox = async function () {
    try { const r = await jx("lina/inbox"); this.setState({ inbox: (r.messages || []).map(mapMsg) }); }
    catch (e) { /* общий диалог не критичен для остального интерфейса */ }
  };
  P.loadAdminInbox = async function () {
    try {
      const r = await jx("admin/assistant");
      // Раздельные ленты: группируем по scope, у каждой панели своя история.
      const by = {};
      (r.messages || []).forEach((m) => { (by[m.scope || ""] = by[m.scope || ""] || []).push(m); });
      const mapped = {};
      Object.keys(by).forEach((k) => { mapped[k] = by[k].map(mapMsg); });
      this.setState({ adminInbox: mapped });
    } catch (e) { /* ассистент админки не критичен для остального */ }
  };
  P.adminSend = async function (scope) {
    const text = (this.state.adminComposer || "").trim(); if (!text || !scope) return;
    this.setState({ adminComposer: "" });
    // Тип сущности задаётся разделом (scope), а не текстом запроса.
    try { await jx("admin/assistant", "POST", { text, scope }); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdminInbox();
    await this.loadAdmin();
  };
  P.send = async function () {
    const text = (this.state.composer || "").trim(); if (!text) return;
    // Диалог задачи — только если выбранная задача реально есть в списке (иначе
    // это общий диалог Лины: тот же критерий, что у ct в рендере чата).
    const sel = this.state.selectedTask;
    const onTask = sel && (this.state.tasks || []).some((t) => t.id === sel);
    this.setState({ composer: "" });
    if (!onTask) {
      try { await jx("lina/inbox", "POST", { text }); } catch (e) { this.toast("ошибка", e.message); }
      await this.loadInbox();
      await this.loadAll(null);
      return;
    }
    try { await jx("tasks/" + sel + "/message", "POST", { text }); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAll(sel);
  };
  P.answerQuestion = async function () {
    const text = (this.state.answer || "").trim(); if (!text || !this.state.selectedTask) return;
    this.setState({ answer: "" });
    try { await jx("tasks/" + this.state.selectedTask + "/message", "POST", { text }); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAll(this.state.selectedTask);
  };
  P.handover = async function (id) {
    try { const r = await jx("tasks/" + id + "/handover", "POST"); if (!r.ok) { this.toast("нельзя передать", r.reason || ""); return; } this.toast("передано исполнителю", "исполнение запущено в реальном контуре"); }
    catch (e) { this.toast("ошибка", e.message); }
    await this.loadAll(id);
  };
  P.newTask = async function () {
    try { const r = await jx("tasks", "POST", { title: "Новая задача", owner: "internal" }); await this.loadAll(r.task.id); this.setState({ selectedTask: r.task.id, chatHidden: false }); }
    catch (e) { this.toast("ошибка", e.message); }
  };
  P.moveTask = async function (id, dir) {
    try { await jx("tasks/" + id + "/move", "POST", { dir }); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAll(this.state.selectedTask);
  };
  P.addComment = async function (id) {
    const text = (this.state.comment || "").trim(); if (!text) return;
    this.setState({ comment: "" });
    try { await jx("tasks/" + id + "/comment", "POST", { text }); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAll(this.state.selectedTask);
  };
  P.patchTask = async function (id, fn) {
    const t = (this.state.tasks || []).find((x) => x.id === id); if (!t) return;
    const c = Object.assign({}, t); try { fn(c); } catch (e) { /* мутатор */ }
    const body = {};
    if (c.title !== t.title) body.title = c.title;
    if (c.owner !== t.owner) body.owner = c.owner;
    if (c.status !== t.status) body.status = c.status;
    if (c.prio !== t.prio) body.prio = c.prio;
    if (c.due !== t.due) body.due_date = c.due;
    try { await jx("tasks/" + id, "PATCH", body); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAll(this.state.selectedTask);
  };
  P.decideResult = async function (mid, decision) {
    const note = decision === "rejected" ? (this.state.rejectReason || "").trim() : "";
    if (decision === "rejected" && !note) { this.setState({ rejectingId: mid }); return; }
    try { await jx("tasks/" + this.state.selectedTask + "/result-decision", "POST", { decision, note }); } catch (e) { this.toast("ошибка", e.message); }
    this.setState({ rejectingId: null, rejectReason: "" });
    await this.loadAll(this.state.selectedTask);
  };
  // Сумма удалённых строк по таблицам — чтобы в подтверждении был виден объём,
  // а не только слово «удалено».
  function rowsTotal(counts) {
    return Object.keys(counts || {}).reduce(function (a, k) { return a + (Number(counts[k]) || 0); }, 0);
  }

  P.archiveOwner = async function (slug) {
    if (typeof window !== "undefined" && !window.confirm(
      "Отправить клиента «" + slug + "» в архив?\n\n"
      + "Клиент и его задачи будут скрыты. Правила, привязки, имена секретов "
      + "(со значениями) и снимки сессий будут УДАЛЕНЫ — при возврате из архива "
      + "их придётся завести заново. Журнал вердиктов сохранится.")) return;
    try {
      const r = await jx("admin/owner-archive", "POST", { slug });
      if (r && r.ok === false) { this.toast("не удалось", r.reason || "архивирование отклонено"); return; }
      this.toast("владельцы", "клиент " + slug + " в архиве, отозвано строк: " + rowsTotal(r && r.revoked));
    } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };

  P.unarchiveOwner = async function (slug) {
    try {
      const r = await jx("admin/owner-unarchive", "POST", { slug });
      if (r && r.ok === false) { this.toast("не удалось", r.reason || "возврат отклонён"); return; }
      this.toast("владельцы", "клиент " + slug + " возвращён из архива; правила и секреты заведите заново");
    } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };

  // Необратимая операция администрирования: стирает и аудит (вердикты, лизинги,
  // подтверждения). Подтверждение — вводом слага, а не одним «ОК»: цена ошибки
  // здесь выше, чем у любой другой кнопки интерфейса.
  P.deleteOwner = async function (slug) {
    if (typeof window !== "undefined") {
      const typed = window.prompt(
        "УДАЛЕНИЕ КЛИЕНТА «" + slug + "» — НЕОБРАТИМО.\n\n"
        + "Будут стёрты: задачи, вердикты, лизинги, подтверждения, решения о выдаче "
        + "секретов, правила, привязки, allowlist и снимки сессий этого клиента. "
        + "Ответить на вопрос «на каком основании было выдано право» после этого будет нечем.\n\n"
        + "Нужен архив вместо удаления? Отмените и нажмите «в архив».\n\n"
        + "Для подтверждения введите слаг клиента:");
      if (typed === null) return;
      if (typed.trim() !== slug) { this.toast("отменено", "слаг не совпал — ничего не удалено"); return; }
    }
    try {
      const r = await jx("admin/owner/" + encodeURIComponent(slug), "DELETE");
      if (r && r.ok === false) { this.toast("нельзя удалить", r.reason || "владелец используется"); return; }
      this.toast("владельцы", "клиент " + slug + " удалён, строк стёрто: " + rowsTotal(r && r.deleted));
    } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };

  P.llmUpdate = async function (id, patch) {
    try { await jx("admin/llm/" + id, "POST", patch); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };
  P.llmReorder = async function (ids) {
    try { await jx("admin/llm/reorder", "POST", { ids }); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };
  P.llmClearKey = async function (id) {
    try { await jx("admin/llm/" + id + "/clear", "POST"); this.toast("модель", "ключ убран"); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };

  P.delTaskType = async function (t) {
    if (typeof window !== "undefined" && !window.confirm("Удалить тип задачи «" + t.name + "»?")) return;
    try { await jx("tasktypes/" + t.id, "DELETE"); this.toast("типы задач", "тип удалён"); }
    catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };

  P.delRuleRow = async function (r) {
    if (typeof window !== "undefined" && !window.confirm("Удалить правило «" + r.sender + " → " + r.owner + "»?")) return;
    try { await jx("admin/rule/" + r.id, "DELETE"); this.toast("политика", "правило удалено"); }
    catch (e) { this.toast("ошибка", e.message); }
    await this.loadAdmin();
  };

  P.submitWizard = async function () {
    const w = this.state.wizard; if (!w) return;
    try {
      if (w.kind === "client") {
        if (!/^[a-z0-9-]{1,64}$/.test(w.slug || "")) { this.setState((s) => ({ wizard: Object.assign({}, s.wizard, { err: "слаг: строчная латиница, цифры, дефис — до 64 символов" }) })); return; }
        await jx("admin/owner", "POST", { slug: w.slug, category: w.category || "client" });
        this.toast("владельцы", "клиент " + w.slug + " добавлен"); this.setState({ wizard: null }); await this.loadAdmin();
        return;
      }
      if (w.kind === "tasktype") {
        if (!(w.name || "").trim()) { this.setState((s) => ({ wizard: Object.assign({}, s.wizard, { err: "укажите название типа" }) })); return; }
        const body = { name: w.name.trim(), keywords: w.keywords || "", executor: w.executor || "", clarify: w.clarify || "", dod_template: w.dod_template || "" };
        if (w.id) { await jx("tasktypes/" + w.id, "POST", body); this.toast("типы задач", "тип обновлён"); }
        else { await jx("tasktypes", "POST", body); this.toast("типы задач", "тип добавлен"); }
        this.setState({ wizard: null }); await this.loadAdmin();
        return;
      }
      if (w.kind === "rule") {
        const setErr = (msg) => this.setState((s) => ({ wizard: Object.assign({}, s.wizard, { err: msg }) }));
        if (!/^[a-z]+:[a-z0-9_.-]+$/i.test(w.sender || "")) { setErr("отправитель: вид канал:актор, например cli:operator"); return; }
        if (!w.caps || !w.caps.length) { setErr("выберите хотя бы одно полномочие"); return; }
        const body = { sender: w.sender, owner: w.owner, caps: w.caps, exec: w.exec || "mita", lease: Number(w.lease) || 1800, appr: !!w.appr };
        if (w.id) { await jx("admin/rule/" + w.id, "POST", body); this.toast("политика", "правило обновлено"); }
        else { await jx("admin/rule", "POST", body); this.toast("политика", "правило заведено для " + w.sender); }
        this.setState({ wizard: null }); await this.loadAdmin();
        return;
      }
      if (w.kind === "endpoint") {
        // Мастер трёхшаговый: «Далее» продвигает шаги, POST — только на последнем.
        const setW = (patch) => this.setState((s) => ({ wizard: Object.assign({}, s.wizard, patch) }));
        if (w.step === 1) {
          if (!/^[a-z0-9.-]+$/i.test(w.host || "")) { setW({ err: "хост: латиница, цифры, точки, дефис" }); return; }
          setW({ step: 2, err: null }); return;
        }
        if (w.step === 2) {
          if (!w.methods || !w.methods.length) { setW({ err: "выберите хотя бы один метод" }); return; }
          setW({ step: 3, err: null }); return;
        }
        // methods — уже массив (мультивыбор); paths — строка, её и разбираем в список.
        await jx("admin/allow", "POST", { owner: w.owner || "internal", host: w.host, methods: w.methods, paths: csv(w.paths), op: w.op || "auto" });
        this.toast("готово", "эндпоинт " + w.host + " разрешён"); this.setState({ wizard: null }); await this.loadAdmin();
        return;
      } else if (w.kind === "secret") {
        this.toast("секрет", "значение вносится консолью lpmc-admin (мастер-ключ на веб не выносится)"); this.setState({ wizard: null });
      }
    } catch (e) { this.toast("ошибка", e.message); }
  };
  P.decideApproval = function () { this.toast("подтверждение", "решение — через доверенный путь approvald (одноразовая ссылка)"); };
  P.issueView = function () { this.toast("просмотр экрана", "выдача ссылки — сервисом lpmc-view (30 мин)"); };

  // Удаление секрета: макет строит confirm.onConfirm замыканием в renderVals —
  // оборачиваем renderVals и подменяем действие на реальный backend.
  const origRV = P.renderVals;
  P.renderVals = function () {
    const v = origRV.call(this);
    if (v && v.confirm && v.confirm.open && this.state.confirm && this.state.confirm.name) {
      const name = this.state.confirm.name;
      v.confirm.onConfirm = async () => {
        try { await jx("admin/secret/" + encodeURIComponent(name), "DELETE"); this.toast("custody", "секрет " + name + " удалён"); }
        catch (e) { this.toast("ошибка", e.message); }
        this.setState({ confirm: null });
        await this.loadAdmin();
      };
    }
    // Удаление задачи из карточки (кнопка «Удалить» в футере).
    // У открытой карточки поле — open:true (не exists).
    if (v && v.card && v.card.open && !v.readOnly) {
      v.card.onDelete = async () => {
        const id = v.card.id || this.state.selectedTask; if (!id) return;
        if (typeof window !== "undefined" && !window.confirm("Удалить задачу безвозвратно?")) return;
        try { await jx("tasks/" + id, "DELETE"); this.toast("задача", "удалена"); } catch (e) { this.toast("ошибка", e.message); }
        this.setState({ cardOpen: false, selectedTask: null, chatHidden: true });
        await this.loadAll(null);
      };
    }
    return v;
  };
})();
