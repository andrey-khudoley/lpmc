import { hostname } from "node:os";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS, type Envelope } from "@lpmc/contracts";
import { Delivery } from "./delivery.js";
import { CLI_ADAPTER } from "./identity.js";
import { runConsumer, stopOnSignals } from "./consumer.js";

/**
 * Служба доставки: читает одобренные сообщения и кладёт их в канал.
 *
 * Потребитель долговременный и с явным подтверждением: сообщение считается
 * обработанным только после того, как запись о доставке зафиксирована в базе.
 * Падение между чтением и записью приводит к повторной выдаче того же
 * сообщения — и вторая попытка отсекается ключом идемпотентности, а не удачей.
 *
 * Читается ровно один топик — собственного канала (§10.3 п. 4). Право на другие
 * не выдано на брокере, поэтому нарушить это правило нельзя даже ошибкой в коде.
 *
 * Проверка конверта общая для всех потребителей системы и выполняется до того,
 * как кто-либо посмотрит в payload.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/lina/nats/lina-adapter.seed";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`lina-delivery@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const delivery = new Delivery(pool, CLI_ADAPTER);
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "OUTBOUND", durable: "lina-cli-delivery",
      filterSubject: EVENTS.messageDispatchRequested.subject },
    async (envelope: Envelope) => {
      const r = await delivery.deliver((envelope.payload ?? {}) as Record<string, unknown>);
      if (r.kind === "refused") console.error(`отказ в доставке: ${r.reason}`);
      else {
        console.log(`${r.kind === "duplicate" ? "повтор, доставка не повторена" : "доставлено"}`
          + `: диалог ${r.conversationId}`);
      }
    },
    state,
  );

  await nc.drain();
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(`служба доставки остановлена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
