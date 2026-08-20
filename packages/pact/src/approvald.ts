import http from "node:http";
import { createPool } from "@lpmc/runtime";
import { EVENTS } from "@lpmc/contracts";
import { claim, newViewerId } from "./approval.js";

/**
 * Привратник подтверждения необратимых действий.
 *
 * Между человеком и решением стоит ровно он: nginx отдаёт наружу один
 * фиксированный путь и проксирует сюда. Решение принимается здесь, по
 * одноразовой ссылке, и НЕ проходит через канальный контур (W2-LINA-01) —
 * LINA лишь доставляет непрозрачное значение ссылки.
 *
 * Чего здесь нет намеренно: списка ожидающих подтверждений. Страница доступна
 * только по ссылке на конкретное решение; перечень «что ещё ждёт подтверждения»
 * дал бы обзор задач тому, кто получил одну ссылку.
 */
const LISTEN = process.env["LPMC_APPROVAL_LISTEN"] ?? "127.0.0.1:6190";
const PREFIX = process.env["LPMC_APPROVAL_PATH"] ?? "/lpmc-approval/";
const COOKIE = "lpmc_approval";
const SCHEMA_VERSION = "1.0.0";

const pool = createPool();

interface ApprovalRow {
  approval_id: string; task_id: string; run_id: string; owner_slug: string;
  reply_route_id: string; channel: string; adapter_id: string;
  host: string; operation_type: string; description: string; capabilities: string[];
  state: string; claimed_by: string | null; expires_at: Date; created_at: Date;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    console.error(`ошибка обработки: ${e instanceof Error ? e.message : String(e)}`);
    reply(res, 500, "500 внутренняя ошибка");
  });
});
server.on("connection", (s) => s.on("error", () => s.destroy()));
server.on("clientError", (_e, s) => s.destroy());

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? "").split("?")[0] ?? "";
  if (!url.startsWith(PREFIX)) { reply(res, 404, "404 нет такого пути"); return; }
  const tail = url.slice(PREFIX.length);
  const [token, action] = tail.split("/");
  if (!token) { reply(res, 404, "404 нет такого пути"); return; }

  const found = await pool.query<ApprovalRow>(
    `SELECT approval_id, task_id, run_id, owner_slug, reply_route_id, channel, adapter_id,
            host, operation_type, description, capabilities, state, claimed_by, expires_at, created_at
       FROM approvals WHERE token = $1`, [token]);
  const a = found.rows[0];
  if (!a) {
    console.log(`подтверждение отклонено token=${token.slice(0, 8)}… причина=нет_такой_ссылки`);
    reply(res, 403, "403 ссылка недействительна");
    return;
  }

  const viewer = cookieValue(req.headers.cookie);
  const verdict = claim(a.state, a.claimed_by, a.expires_at, viewer, new Date());
  if (!verdict.ok) {
    console.log(`подтверждение отклонено ${a.approval_id}: ${verdict.reason}`);
    reply(res, 403, `403 ${humanReason(verdict.reason)}`);
    return;
  }
  if (verdict.fresh) {
    await pool.query(`UPDATE approvals SET claimed_by = $2 WHERE approval_id = $1`,
      [a.approval_id, verdict.viewer]);
    // Идентификатор зрителя выставляется сразу после заявки, до любой другой
    // работы: иначе временная ошибка сожгла бы одноразовую ссылку.
    res.setHeader("Set-Cookie",
      `${COOKIE}=${verdict.viewer}; Path=${PREFIX}${token}/; HttpOnly; SameSite=Strict`);
  }

  if (req.method === "GET" && (action === undefined || action === "")) {
    reply(res, 200, page(a, token), "text/html; charset=utf-8");
    return;
  }
  if (req.method === "POST" && (action === "approve" || action === "deny")) {
    await decide(a, action === "approve", verdict.viewer);
    reply(res, 200, decided(a, action === "approve"), "text/html; charset=utf-8");
    return;
  }
  reply(res, 404, "404 нет такого пути");
}

/**
 * Запись решения и объявление о нём.
 *
 * Решение пишется одной транзакцией с событием: подтверждение, о котором никто
 * не узнал, равносильно его отсутствию, а объявленное без записи — подтверждению
 * без основания.
 */
async function decide(a: ApprovalRow, approved: boolean, by: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upd = await client.query(
      `UPDATE approvals SET state = $2, decided_at = now(), decided_by = $3
        WHERE approval_id = $1 AND state = 'pending'`,
      [a.approval_id, approved ? "approved" : "denied", by]);
    if (upd.rowCount === 0) { await client.query("ROLLBACK"); return; }
    await client.query(
      `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id,
                           causation_id, dedup_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, NULL, $6)`,
      [EVENTS.approvalDecided.subject, EVENTS.approvalDecided.eventType, SCHEMA_VERSION,
       JSON.stringify({
         approval_id: a.approval_id, task_id: a.task_id, run_id: a.run_id,
         decision: approved ? "approved" : "denied",
         host: a.host, operation_type: a.operation_type, capabilities: a.capabilities,
       }),
       a.task_id, `approval:${a.approval_id}`]);
    await client.query("COMMIT");
    console.log(`подтверждение ${a.approval_id}: ${approved ? "выдано" : "отказано"}`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function page(a: ApprovalRow, token: string): string {
  return html(`
    <h1>Подтверждение действия</h1>
    <p class="lead">Система просит разрешить необратимое действие. Проверьте описание —
      после подтверждения отменить его будет нельзя.</p>
    <dl>
      <dt>Владелец</dt><dd>${esc(a.owner_slug)}</dd>
      <dt>Внешняя система</dt><dd>${esc(a.host)}</dd>
      <dt>Тип операции</dt><dd>${esc(a.operation_type)}</dd>
      <dt>Что будет сделано</dt><dd>${esc(a.description)}</dd>
      <dt>Полномочия запуска</dt><dd>${esc(a.capabilities.join(", "))}</dd>
      <dt>Действительно до</dt><dd>${esc(a.expires_at.toISOString())}</dd>
    </dl>
    <form method="post" action="${PREFIX}${esc(token)}/approve" class="row">
      <button class="ok" type="submit">Подтвердить</button>
    </form>
    <form method="post" action="${PREFIX}${esc(token)}/deny" class="row">
      <button class="no" type="submit">Отказать</button>
    </form>
    <p class="note">Ссылка одноразовая и действует до указанного времени.
      Повторное решение по ней невозможно.</p>`);
}

function decided(a: ApprovalRow, approved: boolean): string {
  return html(`
    <h1>${approved ? "Подтверждено" : "Отказано"}</h1>
    <p class="lead">${approved
      ? "Система продолжит работу новым запуском. Прежний лизинг для этого не годится."
      : "Действие не будет выполнено. Задача закрыта отказом."}</p>
    <dl><dt>Задача</dt><dd>${esc(a.task_id)}</dd></dl>`);
}

function html(body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Подтверждение действия</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.4rem} .lead{color:#444}
 dl{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem;margin:1.5rem 0}
 dt{color:#666} dd{margin:0;word-break:break-word}
 .row{display:inline-block;margin:0 .5rem .5rem 0}
 button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #999;cursor:pointer}
 .ok{background:#0a6b2f;color:#fff;border-color:#0a6b2f}
 .no{background:#fff;color:#8a1010;border-color:#8a1010}
 .note{color:#666;font-size:.9rem;margin-top:2rem}
</style></head><body>${body}</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function humanReason(reason: string): string {
  if (reason.includes("expired")) return "срок подтверждения истёк";
  if (reason.includes("claimed_by_other")) return "ссылка уже открыта в другом месте";
  if (reason.includes("already_")) return "решение по этой ссылке уже принято";
  return "ссылка недействительна";
}

function cookieValue(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE && v) return v;
  }
  return undefined;
}

function reply(res: http.ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}



const [host, port] = LISTEN.split(":") as [string, string];
server.listen(Number(port), host, () => {
  console.log(`привратник подтверждений слушает ${LISTEN}, путь ${PREFIX}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`получен ${sig}: останавливаемся`);
    server.close(() => { void pool.end().then(() => process.exit(0)); });
  });
}
