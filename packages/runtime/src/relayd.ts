import { hostname } from "node:os";
import { createPool } from "./db.js";
import { connectAs } from "./nats.js";
import { OutboxRelay } from "./relay.js";

/**
 * Служба ретрансляции outbox → брокер. Одна на компонент.
 *
 * Отдельный процесс, а не поток внутри самого компонента: публикация зависит от
 * доступности брокера, а работа компонента — нет. Если брокер недоступен, приём
 * обязан продолжаться, а события — копиться в таблице и уйти позже.
 */
export async function runRelay(service: string, seedPath: string, idleMs: number): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`${service}-relay@${hostname()}`, seedPath, process.env["LPMC_NATS_SERVER"]);
  const relay = new OutboxRelay(pool, nc, service, hostname());

  let running = true;
  const stop = (sig: string): void => {
    console.log(`получен ${sig}: завершаем текущий проход и выходим`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  while (running) {
    let r;
    try {
      r = await relay.pump();
    } catch (e) {
      // Недоступность базы или брокера — не повод останавливать службу:
      // неотправленные строки останутся в outbox и уйдут следующим проходом.
      console.error(`проход не удался: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(idleMs * 4);
      continue;
    }
    if (r.published > 0) console.log(`опубликовано: ${r.published}`);
    if (r.failed > 0) console.error(`не опубликовано: ${r.failed} (${r.lastError ?? "без причины"})`);
    if (r.published === 0) await sleep(idleMs);
  }

  await nc.drain();
  await pool.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Единая точка запуска: имя компонента и путь к ключу задаются окружением юнита. */
export function relayMain(service: string, defaultSeed: string): void {
  const seed = process.env["LPMC_NATS_SEED"] ?? defaultSeed;
  const idle = Number(process.env["LPMC_RELAY_IDLE_MS"] ?? 250);
  runRelay(service, seed, idle).catch((e: unknown) => {
    console.error(`ретранслятор остановлен: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
