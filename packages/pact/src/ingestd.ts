import { hostname } from "node:os";
import { createPool, connectAs, inTransaction } from "@lpmc/runtime";
import { EVENTS, type Envelope } from "@lpmc/contracts";
import { runConsumer, stopOnSignals } from "./consumer.js";

/**
 * Приём обращений LINA. Сейчас обрабатывается один их вид — требование уточнения.
 *
 * Зачем здесь вообще арбитр. Уточняющий вопрос сочиняет LINA, но выпустить его
 * наружу она не может: право публиковать во внешнюю доставку принадлежит
 * исключительно Egress Guard. Между ними нужен тот, кто превратит требование
 * в ПРЕДЛОЖЕНИЕ ответа — предложение, а не сообщение: решение о выпуске
 * принимает Guard, и только он.
 *
 * Кандидаты в задачу этой службой не читаются: у потребителя стоит фильтр
 * по одному топику. Их разбор — отдельная служба приёма задач; до её появления
 * кандидаты остаются в потоке непрочитанными, а не молча подтверждёнными.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/pact/nats/pact-enforcement.seed";
const DURABLE = "pact-ingest-clarifications";
const CONSUMER = "pact-ingest";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`pact-ingest@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "REQUESTS", durable: DURABLE, filterSubject: EVENTS.requestClarificationNeeded.subject },
    async (envelope: Envelope) => {
      const p = (envelope.payload ?? {}) as Record<string, unknown>;
      const question = typeof p["question"] === "string" ? p["question"] : "";
      const route = typeof p["reply_route_id"] === "string" ? p["reply_route_id"] : "";
      const channel = typeof p["channel"] === "string" ? p["channel"] : "";
      const adapterId = typeof p["adapter_id"] === "string" ? p["adapter_id"] : "";
      if (question === "" || route === "" || channel === "" || adapterId === "") {
        console.error(`требование уточнения без обязательных полей: ${envelope.event_id}`);
        return;
      }

      await inTransaction(pool, async (c) => {
        const first = await c.query(
          `INSERT INTO consumed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [CONSUMER, envelope.event_id],
        );
        if (first.rowCount === 0) {
          console.log(`требование ${envelope.event_id} уже обработано, повтор пропущен`);
          return;
        }
        // Предложение уходит через тот же outbox, что и остальные события
        // арбитра: запись факта и публикация — одна транзакция.
        await c.query(
          `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, causation_id, dedup_key)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [EVENTS.replyProposed.subject, EVENTS.replyProposed.eventType, "1.0.0",
           JSON.stringify({
             // Тождество предложения выводится из события-причины, а не
             // назначается заново: повторная обработка даст тот же идентификатор,
             // и Guard узнает в нём уже принятое решение.
             proposal_id: envelope.event_id,
             reply_route_id: route,
             channel,
             adapter_id: adapterId,
             content_class: "clarification",
             content: { text: question },
             // Задачи ещё нет: уточнение происходит ДО её создания. Владельца
             // на этом шаге тоже нет — привязку выводит приём задачи.
             task_id: null,
             owner: null,
           }),
           envelope.correlation_id, envelope.event_id, envelope.event_id],
        );
        console.log(`требование ${envelope.event_id}: предложен ответ классу clarification`);
      });
    },
    state,
  );

  await nc.drain();
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(`служба приёма остановлена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
