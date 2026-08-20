import { hostname } from "node:os";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS, type Envelope } from "@lpmc/contracts";
import { parseCandidate, proposeCapabilities, QUALIFIER_VERSION } from "./qualify.js";
import { runConsumer, stopOnSignals } from "./consumer.js";

/**
 * Диспетчер приёма: разбирает кандидата в задачу.
 *
 * Здесь и только здесь читается свободный текст обращения. Результат разбора —
 * значения закрытых типов плюс отдельно лежащая полезная нагрузка, которую
 * enforcement сохранит в карточке задачи, но не подаст в решение.
 *
 * Диспетчер работает под СВОИМ системным пользователем и своей учётной записью
 * в брокере, у которой нет права публиковать события. Это и есть разделение
 * по правам: часть, читающая недоверенное, не может ни выдать полномочия,
 * ни объявить о чём-либо остальной системе.
 *
 * Когда появится квалификатор на модели, он встанет ровно сюда — в процесс,
 * который уже ничего не может.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/dispatch/nats/pact-dispatcher.seed";
const CONSUMER = "dispatch-qualifier";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`pact-dispatch@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "REQUESTS", durable: "dispatch-candidates",
      filterSubject: EVENTS.requestSubmitted.subject },
    async (envelope: Envelope) => {
      const first = await pool.query(
        `INSERT INTO consumed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [CONSUMER, envelope.event_id]);
      if (first.rowCount === 0) return;

      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const parsed = parseCandidate(payload);
      if (!parsed.ok) {
        await pool.query(
          `INSERT INTO rejections (event_id, request_id, reason, payload, stage)
           VALUES ($1, $2, $3, $4::jsonb, 'task-ingress') ON CONFLICT (event_id) DO NOTHING`,
          [envelope.event_id,
           typeof payload["request_id"] === "string" ? payload["request_id"] : null,
           parsed.reason,
           JSON.stringify({ ...payload, correlation_id: envelope.correlation_id })]);
        console.log(`кандидат отклонён на разборе: ${parsed.reason}`);
        return;
      }
      const c = parsed.candidate;
      const proposed = proposeCapabilities(c);
      if (proposed.length === 0) {
        // Квалификатор не смог предложить ни одной возможности. Это НЕ отказ
        // приёма: обращение разобрано, но квалифицировать его нечем — и очередь
        // разбора у этого случая своя.
        await pool.query(
          `INSERT INTO rejections (event_id, request_id, reason, payload, stage)
           VALUES ($1, $2, $3, $4::jsonb, 'qualification') ON CONFLICT (event_id) DO NOTHING`,
          [envelope.event_id, c.requestId, "qualification.no_capabilities_proposed",
           JSON.stringify({ correlation_id: envelope.correlation_id })]);
        console.log(`кандидат ${c.requestId}: квалифицировать нечем`);
        return;
      }
      await pool.query(
        `INSERT INTO qualifications
           (request_id, event_id, decision_sender, decision_reply_route_id, decision_channel,
            decision_adapter_id, decision_capabilities, owner_hint, payload, qualifier_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (request_id) DO NOTHING`,
        [c.requestId, envelope.event_id, c.sender, c.replyRouteId, c.channel, c.adapterId,
         proposed, c.ownerHint,
         // Полезная нагрузка: то, что хранится дословно и в решении не участвует.
         JSON.stringify({
           objective: c.objective, dod: c.dod,
           correlation_id: envelope.correlation_id,
         }),
         QUALIFIER_VERSION]);
      console.log(`кандидат ${c.requestId} разобран; предложено: ${proposed.join(", ")}`);
    },
    state,
  );

  await nc.drain();
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(`диспетчер остановлен: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
