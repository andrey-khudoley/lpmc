import { hostname } from "node:os";
import { headers } from "nats";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS, type Envelope } from "@lpmc/contracts";
import { decideEgress, type EgressProposal } from "./egress.js";
import { loadEgressRules, loadTaskRoutes, loadSecretDigests, recordDecision } from "./egress-store.js";
import { findSecret } from "./secret-scan.js";
import { findInternalTrace } from "./internal-trace.js";
import { runConsumer, stopOnSignals } from "./consumer.js";

/**
 * Egress Guard — единственный продюсер топиков внешней доставки.
 *
 * Здесь сходятся две вещи, которые нельзя совмещать в одном компоненте: право
 * решать и право отправлять. Решает Guard по таблице правил; отправляет он же,
 * но ничего не сочиняет — текст приходит от предложившего. Поэтому компонент,
 * породивший текст, не может его выпустить, а компонент, выпускающий, не может
 * его изменить.
 *
 * Порядок операций: решение в базу → публикация → подтверждение. Падение между
 * публикацией и подтверждением даёт повторную публикацию с тем же тождеством
 * сообщения; повтор отсекается окном брокера и ключом идемпотентности
 * у адаптера. Обратный порядок терял бы сообщения молча.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/pact/nats/pact-egress-guard.seed";
const DURABLE = "pact-egress-guard";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`pact-egress@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const js = nc.jetstream();
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "REPLIES", durable: DURABLE, filterSubject: EVENTS.replyProposed.subject },
    async (envelope: Envelope) => {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const content = (payload["content"] ?? {}) as { text?: unknown };
      const text = typeof content.text === "string" ? content.text : "";
      const proposal: EgressProposal = {
        // Тождество предложения — тождество события: повторная выдача одного
        // события не создаёт второго решения и второго сообщения наружу.
        proposalId: String(payload["proposal_id"] ?? envelope.event_id),
        replyRouteId: String(payload["reply_route_id"] ?? ""),
        channel: String(payload["channel"] ?? ""),
        adapterId: String(payload["adapter_id"] ?? ""),
        contentClass: String(payload["content_class"] ?? ""),
        chars: text.length,
        ownerSlug: typeof payload["owner"] === "string" ? payload["owner"] : null,
        taskId: typeof payload["task_id"] === "string" ? payload["task_id"] : null,
      };

      const [rules, routes, digests] = await Promise.all([
        loadEgressRules(pool), loadTaskRoutes(pool), loadSecretDigests(pool)]);

      // Проверка на действующие выдачи секретов идёт ДО правил: утечку секрета
      // не может разрешить никакое правило, поэтому её незачем и сопоставлять
      // с ними. В журнал попадает, что именно утекло бы, но не само значение.
      const leaked = findSecret(text, digests);
      // Внутренняя диагностика в тексте для человека не выпускается ни при каком
      // правиле: пути на диске и трассировки описывают устройство системы,
      // а не результат работы (L-11).
      const trace = leaked === null ? findInternalTrace(text) : null;
      const verdict = leaked !== null
        ? { decision: "DENIED" as const, reason: `egress.secret_in_content:${leaked}` }
        : trace !== null
          ? { decision: "DENIED" as const, reason: `egress.internal_trace:${trace.marker}` }
          : decideEgress(proposal, rules, (routeId, taskId) => routes.get(taskId) === routeId);
      const fresh = await recordDecision(pool, proposal, verdict);

      if (!fresh) {
        console.log(`предложение ${proposal.proposalId}: решение уже принято, повтор пропущен`);
        return;
      }
      if (verdict.decision !== "ALLOWED") {
        // Отказ наружу не уходит: человек не должен получать тексты внутренних
        // отказов (L-11). Но и пропасть отказ не должен — он ложится в очередь
        // ручного разбора вместе с текстом и причиной. Иначе отклонённое
        // означало бы тишину, неотличимую от несработавшей системы.
        await pool.query(
          `INSERT INTO egress_review (proposal_id, reply_route_id, channel, adapter_id,
             content_class, content, decision, reason, task_id, owner_slug)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (proposal_id) DO NOTHING`,
          [proposal.proposalId, proposal.replyRouteId, proposal.channel, proposal.adapterId,
           proposal.contentClass, text, verdict.decision, verdict.reason,
           proposal.taskId, proposal.ownerSlug]);
        console.log(`предложение ${proposal.proposalId}: ${verdict.decision} — ${verdict.reason}`
          + "; отправлено на ручной разбор");
        return;
      }

      const h = headers();
      h.set("Nats-Msg-Id", proposal.proposalId);
      const out = {
        event_id: proposal.proposalId,
        event_type: EVENTS.messageDispatchRequested.eventType,
        schema_version: "1.0.0",
        occurred_at: new Date().toISOString(),
        producer: { service: "pact-egress-guard", instance: hostname() },
        correlation_id: envelope.correlation_id,
        causation_id: envelope.event_id,
        payload: {
          message_id: proposal.proposalId,
          destination: {
            channel: proposal.channel,
            adapter_id: proposal.adapterId,
            reply_route_id: proposal.replyRouteId,
          },
          content: { text, attachment_refs: [] },
          visibility: "external",
          // Признак срочности переносится как есть: решает его тот, кто
          // породил значение, а привратник лишь не теряет этот признак.
          ...(payload["ephemeral"] === true ? { ephemeral: true } : {}),
          idempotency_key: proposal.proposalId,
        },
      };
      await js.publish(
        `outbound.${proposal.channel}.v1`,
        new TextEncoder().encode(JSON.stringify(out)),
        { headers: h, expect: { streamName: "OUTBOUND" } },
      );
      console.log(`предложение ${proposal.proposalId}: ALLOWED — отправлено в outbound.${proposal.channel}.v1`);
    },
    state,
  );

  await nc.drain();
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(`Egress Guard остановлен: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
