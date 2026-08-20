import type pg from "pg";
import type { Rule } from "./gate.js";

/**
 * Владелец выводится доверенным компонентом из таблицы привязок (D-020).
 * Привязка с указанным маршрутом сильнее общей: частный случай должен
 * переопределять общий, иначе исключение невозможно выразить.
 */
export async function resolveOwner(
  pool: pg.Pool, sender: string, replyRouteId: string,
): Promise<string | null> {
  const r = await pool.query<{ owner_slug: string }>(
    `SELECT owner_slug FROM owner_bindings
      WHERE sender = $1 AND (reply_route_id = $2 OR reply_route_id IS NULL)
      ORDER BY (reply_route_id IS NULL)
      LIMIT 1`,
    [sender, replyRouteId],
  );
  return r.rows[0]?.owner_slug ?? null;
}

export async function loadRules(pool: pg.Pool): Promise<{ rules: Rule[]; version: number }> {
  const r = await pool.query<{
    ruleset_version: number; sender: string; owner_slug: string; capabilities: string[];
    executor: string; lease_ttl_seconds: number; requires_approval: boolean;
  }>(`SELECT ruleset_version, sender, owner_slug, capabilities, executor,
             lease_ttl_seconds, requires_approval FROM rules`);
  const rules = r.rows.map((x) => ({
    rulesetVersion: x.ruleset_version,
    sender: x.sender,
    ownerSlug: x.owner_slug,
    capabilities: x.capabilities,
    executor: x.executor,
    leaseTtlSeconds: x.lease_ttl_seconds,
    requiresApproval: x.requires_approval,
  }));
  // Действует старшая версия таблицы. Версия попадает в вердикт, и по ней
  // постфактум восстанавливается основание решения (D-027).
  const version = rules.length > 0 ? Math.max(...rules.map((x) => x.rulesetVersion)) : 0;
  return { rules, version };
}

export async function knownOwners(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ slug: string }>("SELECT slug FROM owners");
  return r.rows.map((x) => x.slug);
}

/**
 * След кандидата. Пишется и для отклонённых: задача создаётся не всегда,
 * а ответ на вопрос «почему обращение осталось без ответа» нужен всегда.
 */
export async function recordCandidate(
  pool: pg.Pool,
  c: {
    requestId: string; sender: string; replyRouteId: string; channel: string; adapterId: string;
    ownerHint: string | null; ownerResolved: string | null; taskId: string | null;
    outcome: string; reason: string;
  },
): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO candidates
       (request_id, sender, reply_route_id, channel, adapter_id, owner_hint, owner_resolved,
        task_id, outcome, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (request_id) DO NOTHING`,
    [c.requestId, c.sender, c.replyRouteId, c.channel, c.adapterId, c.ownerHint,
     c.ownerResolved, c.taskId, c.outcome, c.reason],
  );
  return r.rowCount === 1;
}
