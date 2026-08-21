import { randomUUID } from "node:crypto";
import type pg from "pg";
import { buildLinaText, missingField, parseCommand, questionFor, type Patch } from "./lina.js";

export interface TaskRow {
  id: string; title: string; owner: string; status: string; prio: string;
  start_date: string | null; due_date: string | null; descr: string; dod: string;
  lina_text: string; handed: boolean; request_id: string | null;
}

const TASK_COLS = `id, title, owner, status, prio,
  to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(due_date,'YYYY-MM-DD') AS due_date,
  descr, dod, lina_text, handed, request_id`;

export async function knownOwners(pool: pg.Pool): Promise<string[]> {
  try {
    const r = await pool.query<{ slug: string }>("SELECT slug FROM pact.owners ORDER BY slug");
    return r.rows.map((x) => x.slug);
  } catch { return ["internal", "notion-demo"]; }
}

export async function listTasks(pool: pg.Pool): Promise<unknown[]> {
  const r = await pool.query(`
    SELECT t.id, t.title, t.owner, t.status, t.prio,
           to_char(t.start_date,'YYYY-MM-DD') AS start,
           to_char(t.due_date,'YYYY-MM-DD') AS due,
           t.handed, d.id AS dialog_id, d.status AS dialog_status,
           (SELECT count(*) FROM web_comments c WHERE c.task_id = t.id) AS comments
      FROM web_tasks t LEFT JOIN web_dialogs d ON d.task_id = t.id
     ORDER BY t.created_at`);
  return r.rows;
}

async function getTask(pool: pg.Pool, id: string): Promise<TaskRow | null> {
  const r = await pool.query<TaskRow>(`SELECT ${TASK_COLS} FROM web_tasks WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

async function ensureDialog(pool: pg.Pool, taskId: string): Promise<string> {
  const r = await pool.query<{ id: string }>("SELECT id FROM web_dialogs WHERE task_id = $1", [taskId]);
  if (r.rows[0]) return r.rows[0].id;
  const id = `d-${randomUUID().slice(0, 8)}`;
  await pool.query("INSERT INTO web_dialogs (id, task_id, status) VALUES ($1, $2, 'draft')", [id, taskId]);
  return id;
}

export async function getTaskFull(pool: pg.Pool, id: string): Promise<unknown | null> {
  const t = await getTask(pool, id);
  if (!t) return null;
  const dialogId = await ensureDialog(pool, id);
  const d = await pool.query<{ id: string; status: string; f_objective: boolean; f_owner: boolean; f_dod: boolean }>(
    "SELECT id, status, f_objective, f_owner, f_dod FROM web_dialogs WHERE id = $1", [dialogId]);
  const m = await pool.query<{ id: number; kind: string; payload: unknown; created_at: Date }>(
    "SELECT id, kind, payload, created_at FROM web_messages WHERE dialog_id = $1 ORDER BY id", [dialogId]);
  const c = await pool.query<{ author: string; text: string; created_at: Date }>(
    "SELECT author, text, created_at FROM web_comments WHERE task_id = $1 ORDER BY id", [id]);
  const messages: unknown[] = m.rows.map((x) => ({ id: x.id, kind: x.kind, at: x.created_at, ...(x.payload as object) }));
  // Результаты реального исполнения приходят в lina.deliveries — подмешиваем их
  // как ответы исполнителя (через мост-функцию, без прямого доступа к схеме lina).
  if (t.handed) {
    try {
      const dl = await pool.query<{ text: string; created_at: Date }>(
        "SELECT text, created_at FROM lina.web_deliveries($1)", [`web-${id}`]);
      dl.rows.forEach((x, i) => {
        const isResult = /нужна проверка|результат/i.test(x.text) && !/принят/i.test(x.text);
        messages.push(isResult
          ? { id: `dl${i}`, kind: "result", at: x.created_at, title: "результат исполнителя", text: x.text,
              artifacts: [], decision: t.status === "done" ? "accepted" : null }
          : { id: `dl${i}`, kind: "note", at: x.created_at, text: x.text });
      });
    } catch { /* мост ещё не доступен — не критично */ }
  }
  return { task: t, dialog: d.rows[0], messages, comments: c.rows.map((x) => ({ author: x.author, text: x.text, at: x.created_at })) };
}

export async function createTask(pool: pg.Pool, title: string, owner: string): Promise<TaskRow> {
  const id = `t-${randomUUID().slice(0, 8)}`;
  const lina = buildLinaText({ title, owner, dod: "" });
  await pool.query(
    `INSERT INTO web_tasks (id, title, owner, status, prio, start_date, due_date, lina_text)
     VALUES ($1, $2, $3, 'todo', 'обычный', current_date, current_date + 3, $4)`, [id, title, owner, lina]);
  const dialogId = await ensureDialog(pool, id);
  const t = (await getTask(pool, id))!;
  const owners = await knownOwners(pool);
  const miss = await refreshFlags(pool, id, t, owners);
  if (miss) await insertMsg(pool, dialogId, "question", { ...questionFor(miss), answered: false, open: true });
  else await insertMsg(pool, dialogId, "reply", { text: "обращение полное — можно передать исполнителю кнопкой ниже." });
  return t;
}

async function insertMsg(pool: pg.Pool, dialogId: string, kind: string, payload: object): Promise<void> {
  await pool.query("INSERT INTO web_messages (dialog_id, kind, payload) VALUES ($1, $2, $3::jsonb)",
    [dialogId, kind, JSON.stringify(payload)]);
}

async function applyPatch(pool: pg.Pool, t: TaskRow, patch: Patch): Promise<TaskRow> {
  const next = { ...t, ...patch };
  next.lina_text = buildLinaText({ title: next.title, owner: next.owner, dod: next.dod });
  await pool.query(
    `UPDATE web_tasks SET title=$2, owner=$3, prio=$4, status=$5, dod=$6,
       due_date = CASE WHEN $7 = '' THEN due_date ELSE $7::date END,
       lina_text=$8, updated_at=now() WHERE id=$1`,
    [t.id, next.title, next.owner, next.prio, next.status, next.dod, patch.due_date ?? "", next.lina_text]);
  return next;
}

async function refreshFlags(pool: pg.Pool, taskId: string, t: TaskRow, owners: string[]): Promise<"owner" | "dod" | null> {
  const fObj = t.title.trim() !== "";
  const fOwner = t.owner.trim() !== "" && owners.includes(t.owner.trim());
  const fDod = t.dod.trim() !== "";
  const miss = missingField({ title: t.title, owner: fOwner ? t.owner : "", dod: t.dod });
  const status = t.handed ? "working" : miss ? "awaiting" : "draft";
  await pool.query(
    "UPDATE web_dialogs SET f_objective=$2, f_owner=$3, f_dod=$4, status=$5 WHERE task_id=$1",
    [taskId, fObj, fOwner, fDod, status]);
  return miss;
}

/** Приём сообщения в диалог задачи: команды правят поля, промпт пересобирается,
 *  недостающее уточняется вопросом, полнота открывает передачу исполнителю. */
export async function postMessage(pool: pg.Pool, taskId: string, text: string): Promise<unknown | null> {
  const t = await getTask(pool, taskId);
  if (!t) return null;
  const dialogId = await ensureDialog(pool, taskId);
  await insertMsg(pool, dialogId, "you", { text });

  if (t.handed) {
    await insertMsg(pool, dialogId, "note", { text: "задача передана исполнителю · поля зафиксированы" });
    return getTaskFull(pool, taskId);
  }

  const owners = await knownOwners(pool);
  const { patch, labels } = parseCommand(text, owners);

  // Ответ на открытый вопрос: если поле не задано командой — заполняем его текстом.
  const pend = await pool.query<{ field: string }>(
    `SELECT payload->>'field' AS field FROM web_messages
      WHERE dialog_id=$1 AND kind='question' AND (payload->>'answered')::bool IS NOT TRUE
      ORDER BY id DESC LIMIT 1`, [dialogId]);
  const pendField = pend.rows[0]?.field;
  if (pendField === "dod" && patch.dod === undefined) { patch.dod = text.trim(); labels.push("критерии приёмки обновлены"); }
  if (pendField === "owner" && patch.owner === undefined) {
    const o = text.trim().toLowerCase();
    if (owners.includes(o)) { patch.owner = o; labels.push(`владелец ${o}`); }
  }

  const next = await applyPatch(pool, t, patch);

  // Отметить отвеченные вопросы.
  for (const f of ["owner", "dod"] as const) {
    const filled = f === "owner" ? owners.includes(next.owner) : next.dod.trim() !== "";
    if (filled) {
      await pool.query(
        `UPDATE web_messages SET payload = payload || jsonb_build_object('answered', true, 'answerText', $3::text)
          WHERE dialog_id=$1 AND kind='question' AND payload->>'field'=$2 AND (payload->>'answered')::bool IS NOT TRUE`,
        [dialogId, f, f === "owner" ? next.owner : next.dod]);
    }
  }

  if (labels.length) await insertMsg(pool, dialogId, "note", { text: `обновлено: ${labels.join(" · ")}` });

  const miss = await refreshFlags(pool, taskId, next, owners);
  if (miss) {
    await insertMsg(pool, dialogId, "question", { ...questionFor(miss), answered: false, open: true });
  } else {
    await insertMsg(pool, dialogId, "reply", { text: "обращение полное — можно передать исполнителю кнопкой ниже." });
  }
  return getTaskFull(pool, taskId);
}

export async function patchTask(pool: pg.Pool, taskId: string, patch: Patch): Promise<unknown | null> {
  const t = await getTask(pool, taskId);
  if (!t) return null;
  if (t.handed) return getTaskFull(pool, taskId); // поля зафиксированы после передачи
  const next = await applyPatch(pool, t, patch);
  await refreshFlags(pool, taskId, next, await knownOwners(pool));
  return getTaskFull(pool, taskId);
}

export async function addComment(pool: pg.Pool, taskId: string, author: string, text: string): Promise<unknown | null> {
  await pool.query("INSERT INTO web_comments (task_id, author, text) VALUES ($1, $2, $3)", [taskId, author, text]);
  return getTaskFull(pool, taskId);
}

/** Одна кнопка: передать задачу исполнителю. Требует полноты; фиксирует поля. */
export async function handover(pool: pg.Pool, taskId: string): Promise<{ ok: boolean; reason?: string; full?: unknown }> {
  const t = await getTask(pool, taskId);
  if (!t) return { ok: false, reason: "нет такой задачи" };
  if (t.handed) return { ok: true, full: await getTaskFull(pool, taskId) };
  const owners = await knownOwners(pool);
  const miss = missingField({ title: t.title, owner: owners.includes(t.owner) ? t.owner : "", dod: t.dod });
  if (miss) return { ok: false, reason: `обращение неполное: не хватает поля «${miss}»` };
  // Реальная передача исполнителю: заводим кандидат в конвейер через мост-функцию
  // lina.web_submit (SECURITY DEFINER). Дальше — dispatch → PACT → MITA/CITA.
  const conv = `web-${taskId}`;
  const dodArr = t.dod.split(";").map((s) => s.trim()).filter((s) => s !== "");
  let reqId: string;
  try {
    const r = await pool.query<{ req: string }>("SELECT lina.web_submit($1, $2, $3::text[], $4) AS req",
      [t.title, t.owner, dodArr, conv]);
    reqId = r.rows[0]!.req;
  } catch (e) {
    return { ok: false, reason: `не удалось передать в конвейер: ${e instanceof Error ? e.message : String(e)}` };
  }
  await pool.query("UPDATE web_tasks SET handed=true, status='doing', request_id=$2, updated_at=now() WHERE id=$1",
    [taskId, reqId]);
  const dialogId = await ensureDialog(pool, taskId);
  await pool.query("UPDATE web_dialogs SET status='working' WHERE task_id=$1", [taskId]);
  await insertMsg(pool, dialogId, "note", { text: `обращение полное · задача передана арбитру · ${reqId} · исполнение запущено` });
  return { ok: true, full: await getTaskFull(pool, taskId) };
}

/** Приёмка результата человеком (accepted/rejected) — через мост в реальный контур. */
export async function reviewDecision(pool: pg.Pool, taskId: string, decision: string, note: string): Promise<unknown> {
  try {
    await pool.query("SELECT lina.web_review($1, $2, $3)", [`web-${taskId}`, decision, note]);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const dialogId = await ensureDialog(pool, taskId);
  await insertMsg(pool, dialogId, "note", { text: decision === "accepted" ? "решение передано: принято" : `решение передано: не принято — ${note}` });
  if (decision === "accepted") await pool.query("UPDATE web_tasks SET status='done' WHERE id=$1", [taskId]);
  return getTaskFull(pool, taskId);
}

export async function moveTask(pool: pg.Pool, taskId: string, dir: number): Promise<unknown | null> {
  const order = ["todo", "doing", "review", "done"];
  const t = await getTask(pool, taskId);
  if (!t) return null;
  const i = Math.max(0, Math.min(order.length - 1, order.indexOf(t.status) + (dir > 0 ? 1 : -1)));
  await pool.query("UPDATE web_tasks SET status=$2, updated_at=now() WHERE id=$1", [taskId, order[i]]);
  return getTaskFull(pool, taskId);
}
