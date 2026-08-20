import { createPool } from "@lpmc/runtime";
import { EVENTS } from "@lpmc/contracts";

/**
 * Закрытие запуска, оставшегося без исхода.
 *
 * Такие запуски появляются, когда исполнитель прекращает работу между заявкой
 * и результатом, а событие запроса уже подтверждено брокеру — повторной выдачи
 * не будет, и запуск некому довести до конца.
 *
 * Команда НЕ правит состояние задачи: состояние ведёт арбитр. Она публикует
 * то же событие, что опубликовал бы сам исполнитель, — `runs.failed` с причиной
 * «прерван». Иначе пришлось бы менять чужое состояние в обход механизма,
 * и запись в журнале вердиктов не отличалась бы от настоящей работы.
 *
 * Действия НЕ повторяются: что успел сделать браузер, неизвестно.
 */
async function main(): Promise<void> {
  const [runId, generationRaw, reason] = process.argv.slice(2);
  if (!runId || !generationRaw) {
    console.error("использование: abandon-run <run_id> <поколение> [причина]");
    process.exit(2);
  }
  const generation = Number(generationRaw);
  const pool = createPool();
  try {
    const r = await pool.query<{ task_id: string; status: string | null }>(
      `SELECT task_id, status FROM runs WHERE run_id = $1 AND generation = $2`,
      [runId, generation]);
    const run = r.rows[0];
    if (!run) {
      console.error(`запуск ${runId} поколения ${generation} не найден`);
      process.exit(1);
    }
    if (run.status !== null) {
      console.log(`запуск ${runId} уже закрыт со статусом ${run.status}: ничего не делаем`);
      return;
    }
    const why = reason ?? "run.interrupted";
    await pool.query(
      `UPDATE runs SET status = 'failed', reason = $3, finished_at = now()
        WHERE run_id = $1 AND generation = $2`,
      [runId, generation, why]);
    await pool.query(
      `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, causation_id, dedup_key)
       VALUES ($1, $2, '1.0.0', $3::jsonb, $4, NULL, $5)`,
      [EVENTS.runFailed.subject, EVENTS.runFailed.eventType,
       JSON.stringify({
         task_id: run.task_id, run_id: runId, executor: "mita", status: "failed",
         result: { status: "failed", reason: why,
           summary: "запуск закрыт administratively: исхода не было, действия не повторялись" },
       }),
       `abandon:${runId}`, `abandoned:${runId}:${generation}`]);
    console.log(`запуск ${runId} закрыт как неудавшийся (${why}); задача ${run.task_id} — решение за арбитром`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`не удалось закрыть запуск: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
