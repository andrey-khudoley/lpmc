import { RetentionPolicy, StorageType } from "nats";
import { STREAMS } from "@lpmc/contracts";
import { connectAs } from "./nats.js";

/**
 * Заведение потоков. Выполняется административно, под учётной записью, которая
 * не принадлежит ни одному контуру: право создать поток есть право переопределить
 * политику хранения, то есть тихо изменить для соседей свойства доставки,
 * на которые они опираются.
 */
export async function ensureStreams(
  seedPath: string,
  server?: string,
): Promise<{ created: string[]; updated: string[] }> {
  const nc = await connectAs("streams-admin", seedPath, server);
  const created: string[] = [];
  const updated: string[] = [];
  try {
    const jsm = await nc.jetstreamManager();
    for (const s of STREAMS) {
      const cfg = {
        name: s.name,
        subjects: [...s.subjects],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: s.maxAgeSeconds === 0 ? 0 : s.maxAgeSeconds * 1_000_000_000,
        // Окно дедупликации брокера — оптимизация, а не гарантия (D-023):
        // прикладная дедупликация обязана работать и при пустом окне.
        duplicate_window: 2 * 60 * 1_000_000_000,
        description: s.description,
      };
      let exists = true;
      try {
        await jsm.streams.info(s.name);
      } catch {
        exists = false;
      }
      if (exists) {
        const before = await jsm.streams.info(s.name);
        const after = await jsm.streams.update(s.name, cfg);
        if (JSON.stringify(before.config.subjects) !== JSON.stringify(after.config.subjects)
          || before.config.max_age !== after.config.max_age) {
          updated.push(s.name);
        }
      } else {
        await jsm.streams.add(cfg);
        created.push(s.name);
      }
    }
    return { created, updated };
  } finally {
    await nc.drain();
  }
}

if (process.argv[1]?.endsWith("streams-admin.js")) {
  const seedPath = process.env["LPMC_NATS_ADMIN_SEED"] ?? "/etc/lpmc-system/nats/streams-admin.seed";
  ensureStreams(seedPath, process.env["LPMC_NATS_SERVER"])
    .then(({ created, updated }) => {
      console.log(`создано: ${created.length ? created.join(", ") : "нет"}`);
      console.log(`изменено: ${updated.length ? updated.join(", ") : "нет"}`);
    })
    .catch((e: unknown) => {
      console.error(`потоки не заведены: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
