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
      const [sv, se, ap, inst, ow] = await Promise.all([jx("admin/services"), jx("admin/secrets"), jx("admin/approvals"), jx("admin/instances"), jx("admin/owners")]);
      this.setState({
        realOwners: (ow.owners || []).map((o) => o.slug),
        ownerRows: (ow.owners || []).map((o) => ({ slug: o.slug, category: o.category })),
        bindingRows: (ow.bindings || []).map((b) => ({ sender: b.sender, route: b.route, owner: b.owner_slug })),
        allow: (sv.allow || []).map((a) => ({ owner: a.owner, host: a.host, methods: a.methods, paths: a.paths, op: a.op, version: a.version })),
        irr: (sv.irr || []).map((a) => ({ host: a.host, op: a.op, cls: a.cls, version: a.version })),
        rules: (sv.rules || []).map((a) => ({ sender: a.sender, owner: a.owner, caps: a.caps, exec: a.exec, lease: a.lease + " s", appr: a.appr })),
        secrets: (se.secrets || []).map((s) => ({ name: s.name, owner: s.owner, purpose: s.purpose, updated: s.updated })),
        approvals: (ap.approvals || []).map((a) => ({ id: a.id, host: a.host, op: a.op, state: a.state, title: a.host + " · " + a.op, owner: "", expires: Date.now() + 1800000, caps: "", desc: "", task: "", run: "", dialog: "" })),
        instances: (inst.instances || []).map((i) => ({ id: i.id, owner: i.owner, host: i.host, state: i.state })),
      });
    } catch (e) { this.toast("ошибка", e.message); }
  };

  const origCDM = P.componentDidMount;
  P.componentDidMount = function () {
    if (origCDM) try { origCDM.call(this); } catch (e) { /* оригинальные таймеры */ }
    // Стереть мок-данные и загрузить живые.
    this.setState({ tasks: [], dialogs: [], allow: [], irr: [], rules: [], secrets: [], approvals: [], instances: [] });
    // На телефоне стартуем со списка задач: чат открывается тапом по задаче.
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 680px)").matches) {
      this.setState({ chatHidden: true });
    }
    this.loadAll(this.state.selectedTask);
    this.loadAdmin();
    this.__poll = setInterval(() => {
      const t = (this.state.tasks || []).find((x) => x.id === this.state.selectedTask);
      if (t && t.status === "doing" && this.live) this.loadAll(this.state.selectedTask);
    }, 3500);
  };
  P.mockDelivery = function () { /* реальный поток вместо симуляции */ };

  P.send = async function () {
    const text = (this.state.composer || "").trim(); if (!text || !this.state.selectedTask) return;
    this.setState({ composer: "" });
    try { await jx("tasks/" + this.state.selectedTask + "/message", "POST", { text }); } catch (e) { this.toast("ошибка", e.message); }
    await this.loadAll(this.state.selectedTask);
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
  P.submitWizard = async function () {
    const w = this.state.wizard; if (!w) return;
    try {
      if (w.kind === "endpoint") {
        await jx("admin/allow", "POST", { owner: w.owner || "internal", host: w.host, methods: csv(w.methods), paths: csv(w.paths), op: w.op || "auto" });
        this.toast("готово", "эндпоинт разрешён"); this.setState({ wizard: null }); await this.loadAdmin();
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
