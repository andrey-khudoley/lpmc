import type pg from "pg";
import type { ReplyClass } from "@lpmc/contracts";
import type { EgressRule, EgressVerdict, EgressProposal } from "./egress.js";
import type { SecretDigest } from "./secret-scan.js";

/** Текущая таблица правил исходящего. Пустая таблица — законное состояние. */
export async function loadEgressRules(pool: pg.Pool): Promise<EgressRule[]> {
  const r = await pool.query<{
    ruleset_version: number; owner_slug: string; channel: string;
    content_class: ReplyClass; max_chars: number; decision: "allow" | "deny";
  }>(`SELECT ruleset_version, owner_slug, channel, content_class, max_chars, decision FROM egress_rules`);
  return r.rows.map((x) => ({
    rulesetVersion: x.ruleset_version,
    ownerSlug: x.owner_slug,
    channel: x.channel,
    contentClass: x.content_class,
    maxChars: x.max_chars,
    decision: x.decision,
  }));
}

/** Маршруты задач: ответ по задаче уходит только по маршруту этой задачи. */
export async function loadTaskRoutes(pool: pg.Pool): Promise<Map<string, string>> {
  const r = await pool.query<{ task_id: string; reply_route_id: string }>(
    `SELECT task_id, reply_route_id FROM tasks`);
  return new Map(r.rows.map((x) => [x.task_id, x.reply_route_id]));
}

/**
 * Запись решения. Возвращает false, если решение по этому предложению уже
 * принято: повторная выдача события брокером не должна порождать второго
 * решения — и, что важнее, второго исходящего сообщения.
 */
export async function recordDecision(
  pool: pg.Pool, p: EgressProposal, v: EgressVerdict,
): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO egress_decisions
       (proposal_id, reply_route_id, channel, content_class, owner_slug, task_id,
        decision, reason, ruleset_version, chars)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (proposal_id) DO NOTHING`,
    [p.proposalId, p.replyRouteId, p.channel, p.contentClass, p.ownerSlug, p.taskId,
     v.decision, v.reason, v.rulesetVersion ?? null, p.chars],
  );
  return r.rowCount === 1;
}

/** Отметка о том, что потребитель обработал событие (D-023). */
export async function markConsumed(pool: pg.Pool, consumer: string, eventId: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO consumed_events (consumer, event_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [consumer, eventId],
  );
  return r.rowCount === 1;
}

/**
 * Выдачи секретов, подлежащие сверке.
 *
 * Проверяются не только действующие, но и недавно истёкшие: значение, утёкшее
 * до истечения срока, не перестаёт быть опасным в момент истечения (W2-PACT-02).
 * Окно сверки задаётся при выдаче.
 */
export async function loadSecretDigests(pool: pg.Pool): Promise<SecretDigest[]> {
  const r = await pool.query<{ salt: string; digest: string; length: number; issued_for: string }>(
    `SELECT salt, digest, length, issued_for FROM egress_secret_digests
      WHERE revoked_at IS NULL AND (check_until IS NULL OR check_until > now())`);
  return r.rows.map((x) => ({ salt: x.salt, digest: x.digest, length: x.length, issuedFor: x.issued_for }));
}
