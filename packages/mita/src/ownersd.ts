import { hostname } from "node:os";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS, type Envelope } from "@lpmc/contracts";
import { runConsumer, stopOnSignals } from "./consumer.js";

/**
 * Проекция реестра владельцев — только для чтения (PACT §9.2).
 *
 * Исполнитель не может добавить владельца: он лишь отражает то, что сообщил
 * арбитр. Пустая проекция запрещает всё — задача с любым владельцем будет
 * отклонена до первого внешнего действия.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/mita/nats/mita-executor.seed";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`mita-owners@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "OWNERS", durable: "mita-owners", filterSubject: EVENTS.ownerUpdated.subject },
    async (envelope: Envelope) => {
      const p = (envelope.payload ?? {}) as Record<string, unknown>;
      const slug = typeof p["slug"] === "string" ? p["slug"] : "";
      const category = typeof p["category"] === "string" ? p["category"] : "";
      if (!slug || !category) {
        console.error(`обновление владельца без обязательных полей: ${envelope.event_id}`);
        return;
      }
      await pool.query(
        `INSERT INTO owners (slug, category) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET category = EXCLUDED.category, updated_at = now()`,
        [slug, category],
      );
      console.log(`владелец ${slug} отражён в проекции`);
    },
    state,
  );

  await nc.drain();
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(`служба проекции владельцев остановлена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
