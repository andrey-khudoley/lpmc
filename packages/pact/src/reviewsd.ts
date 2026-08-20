import { hostname } from "node:os";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS, isMember, REVIEW_DECISIONS, type Envelope } from "@lpmc/contracts";
import type pg from "pg";
import { TaskRegistry } from "./registry.js";
import { runConsumer, stopOnSignals } from "./consumer.js";

/**
 * Приёмка результата человеком.
 *
 * Кто принял решение, устанавливает не сообщение, а МАРШРУТ ОТВЕТА: задача
 * ищется по маршруту, на который был отправлен отчёт. Поэтому принять задачу
 * может только тот диалог, в котором она возникла, — идентификатор задачи
 * в решении не передаётся вовсе и подделать его нечем.
 *
 * Неоднозначность не разрешается догадкой. Если на одном маршруте ждут приёмки
 * несколько задач, решение отклоняется: закрыть «какую-нибудь» из них хуже,
 * чем не закрыть ни одной.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/pact/nats/pact-enforcement.seed";
const CONSUMER = "pact-reviews";
const SCHEMA_VERSION = "1.0.0";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`pact-reviews@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const registry = new TaskRegistry(pool);
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "REVIEWS", durable: "pact-reviews", filterSubject: EVENTS.reviewDecided.subject },
    async (envelope: Envelope) => {
      const first = await pool.query(
        `INSERT INTO consumed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [CONSUMER, envelope.event_id]);
      if (first.rowCount === 0) return;

      const p = (envelope.payload ?? {}) as Record<string, unknown>;
      const route = typeof p["reply_route_id"] === "string" ? p["reply_route_id"] : "";
      const decision = p["decision"];
      const note = typeof p["note"] === "string" ? p["note"] : "";
      const channel = typeof p["channel"] === "string" ? p["channel"] : "cli";
      const adapterId = typeof p["adapter_id"] === "string" ? p["adapter_id"] : "lina-cli";
      const decidedBy = typeof p["decided_by"] === "string" ? p["decided_by"] : "";

      if (!route || !isMember(REVIEW_DECISIONS, decision)) {
        console.error(`решение приёмки не соответствует контракту: ${envelope.event_id}`);
        return;
      }

      const waiting = await pool.query<{ task_id: string; owner_slug: string }>(
        `SELECT task_id, owner_slug FROM tasks
          WHERE reply_route_id = $1 AND state = 'REVIEW_PENDING'
          ORDER BY updated_at`,
        [route]);

      if (waiting.rowCount === 0) {
        await notify(pool, envelope, route, channel, adapterId, null,
          "Принимать нечего: на этом маршруте нет задачи, ожидающей приёмки.");
        console.log("решение приёмки без ожидающей задачи");
        return;
      }
      if ((waiting.rowCount ?? 0) > 1) {
        await notify(pool, envelope, route, channel, adapterId, null,
          `Приёмки ждут несколько задач (${waiting.rowCount}). Решение не применено:`
          + " закрыть какую-нибудь из них было бы хуже, чем не закрыть ни одной.");
        console.log(`неоднозначная приёмка: задач в ожидании ${waiting.rowCount}`);
        return;
      }

      const task = waiting.rows[0]!;
      const to = decision === "accepted" ? "COMPLETED" : "FAILED";
      await registry.transition(task.task_id, to, {
        toState: to,
        // Причина сохраняется дословно: по журналу должно быть видно не только
        // «не принято», но и что именно человек назвал недостатком.
        reason: `review.${decision}${note !== "" ? `: ${note}` : ""}`
          + (decidedBy !== "" ? ` (решил ${decidedBy})` : ""),
        causeEventId: envelope.event_id,
      });
      await notify(pool, envelope, route, channel, adapterId, task.owner_slug,
        decision === "accepted"
          ? "Результат принят, задача закрыта."
          : `Результат не принят: ${note}`);
      console.log(`задача ${task.task_id}: review.${decision} → ${to}`);
    },
    state,
  );

  await nc.drain();
  await pool.end();
}

/**
 * Уведомление человеку о судьбе его решения.
 *
 * Это предложение ответа класса `notification`, а не сообщение: выпускает его
 * проверка исходящего, как и всё остальное. Без такого уведомления решение
 * человека уходило бы в тишину, и отличить «принято» от «не дошло» было бы
 * нечем.
 */
async function notify(
  pool: pg.Pool, envelope: Envelope, route: string, channel: string, adapterId: string,
  owner: string | null, text: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, causation_id, dedup_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [EVENTS.replyProposed.subject, EVENTS.replyProposed.eventType, SCHEMA_VERSION,
     JSON.stringify({
       proposal_id: envelope.event_id,
       reply_route_id: route,
       channel,
       adapter_id: adapterId,
       content_class: "notification",
       content: { text },
       task_id: null,
       owner,
     }),
     envelope.correlation_id, envelope.event_id, `review-notice:${envelope.event_id}`]);
}

main().catch((e: unknown) => {
  console.error(`служба приёмки остановлена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
