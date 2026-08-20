import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { TaskState } from "@lpmc/contracts";
import { inTransaction } from "@lpmc/runtime";
import { canTransition } from "./states.js";

/**
 * Реестр задач: состояния, журнал вердиктов, лизинги и outbox.
 *
 * Главное правило этого файла: переход состояния, запись причины и публикуемое
 * событие происходят ОДНОЙ транзакцией. Иначе возможна задача в LEASED без
 * события и событие без записи о переходе — и тогда вопрос «на каком основании»
 * остаётся без ответа (SPEC §15.4, PACT 5.2 п. 4).
 */

export interface NewTask {
  ownerSlug: string;
  replyRouteId: string;
  channel?: string;
  adapterId?: string;
  objective: string;
  dod: string[];
  idempotencyKey: string;
  correlationId: string;
}

export interface OutboxEvent {
  subject: string;
  eventType: string;
  schemaVersion: string;
  payload: unknown;
  correlationId: string;
  causationId?: string;
  dedupKey?: string;
}

export interface VerdictRecord {
  toState: TaskState;
  reason: string;
  kind?: "REJECTED" | "DENIED";
  rulesetVersion?: number;
  grantedCapabilities?: string[];
  causeEventId?: string;
}

export class TaskRegistry {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Приём кандидата в задачу. Повтор одного и того же обращения не создаёт
   * вторую задачу: ключ идемпотентности уникален, и повтор возвращает
   * существующую (D-023, уровень «задача»).
   */
  async accept(task: NewTask, event: OutboxEvent): Promise<{ taskId: string; created: boolean }> {
    return inTransaction(this.pool, async (c) => {
      const existing = await c.query<{ task_id: string }>(
        "SELECT task_id FROM tasks WHERE idempotency_key = $1",
        [task.idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0]) {
        return { taskId: existing.rows[0].task_id, created: false };
      }
      const taskId = randomUUID();
      await c.query(
        `INSERT INTO tasks (task_id, owner_slug, state, reply_route_id, objective, dod,
                            idempotency_key, correlation_id, channel, adapter_id)
         VALUES ($1, $2, 'RECEIVED', $3, $4, $5::jsonb, $6, $7, $8, $9)`,
        [taskId, task.ownerSlug, task.replyRouteId, task.objective,
         JSON.stringify(task.dod), task.idempotencyKey, task.correlationId,
         task.channel ?? null, task.adapterId ?? null],
      );
      await this.writeVerdict(c, taskId, null, { toState: "RECEIVED", reason: "task.accepted" });
      await this.writeOutbox(c, event);
      return { taskId, created: true };
    });
  }

  /**
   * Переход состояния. Недопустимый переход — исключение, а не молчаливое
   * присвоение: задача не должна оказываться в состоянии, которого никто
   * не назначал. Событие, если оно есть, уходит той же транзакцией.
   */
  async transition(taskId: string, to: TaskState, verdict: VerdictRecord, event?: OutboxEvent): Promise<void> {
    await inTransaction(this.pool, async (c) => {
      const r = await c.query<{ state: TaskState }>(
        "SELECT state FROM tasks WHERE task_id = $1 FOR UPDATE",
        [taskId],
      );
      const from = r.rows[0]?.state;
      if (!from) throw new Error(`задача ${taskId} не найдена`);
      if (!canTransition(from, to)) {
        throw new Error(`переход ${from} → ${to} не предусмотрен автоматом состояний`);
      }
      await c.query("UPDATE tasks SET state = $2, updated_at = now() WHERE task_id = $1", [taskId, to]);
      await this.writeVerdict(c, taskId, from, verdict);
      if (event) await this.writeOutbox(c, event);
    });
  }

  /**
   * Выдача лизинга. Одновременно действующий лизинг на задачу — один; это
   * обеспечивается уникальным индексом, а не проверкой в коде: проверка в коде
   * проигрывает гонку, индекс — нет.
   */
  async issueLease(
    taskId: string,
    executor: string,
    grantedCapabilities: string[],
    ttlSeconds: number,
    event: OutboxEvent,
  ): Promise<{ leaseId: string; runId: string; generation: number }> {
    return inTransaction(this.pool, async (c) => {
      // Прежний лизинг закрывается ЗДЕСЬ же, одной транзакцией с выдачей нового.
      // Одновременно действующий лизинг на задачу — один: иначе отозванный
      // запуск и возобновлённый существовали бы рядом, и отзыв полномочий
      // у первого ничего не значил бы.
      await c.query(
        `UPDATE leases SET revoked_at = now() WHERE task_id = $1 AND revoked_at IS NULL`,
        [taskId]);
      const g = await c.query<{ max: number | null }>(
        "SELECT max(generation) AS max FROM leases WHERE task_id = $1",
        [taskId],
      );
      const generation = (g.rows[0]?.max ?? 0) + 1;
      const leaseId = randomUUID();
      const runId = randomUUID();
      await c.query(
        `INSERT INTO leases (lease_id, task_id, run_id, executor, generation, granted_capabilities, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
        [leaseId, taskId, runId, executor, generation, grantedCapabilities, ttlSeconds],
      );
      await this.writeOutbox(c, event);
      return { leaseId, runId, generation };
    });
  }

  private async writeVerdict(
    c: pg.PoolClient, taskId: string, from: TaskState | null, v: VerdictRecord,
  ): Promise<void> {
    await c.query(
      `INSERT INTO verdicts (task_id, from_state, to_state, kind, reason, ruleset_version,
                             granted_capabilities, cause_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [taskId, from, v.toState, v.kind ?? null, v.reason, v.rulesetVersion ?? null,
       v.grantedCapabilities ?? null, v.causeEventId ?? null],
    );
  }

  private async writeOutbox(c: pg.PoolClient, e: OutboxEvent): Promise<void> {
    await c.query(
      `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, causation_id, dedup_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [e.subject, e.eventType, e.schemaVersion, JSON.stringify(e.payload),
       e.correlationId, e.causationId ?? null, e.dedupKey ?? null],
    );
  }
}
