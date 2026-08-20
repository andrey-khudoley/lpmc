import { createPool } from "@lpmc/runtime";
import { EVENTS } from "@lpmc/contracts";

/**
 * Публикация проекции реестра владельцев.
 *
 * Реестр принадлежит арбитру, а исполнителю нужна его копия для проверки
 * входящей задачи. Копия обновляется событиями, а не общим доступом к таблице:
 * общий доступ означал бы, что исполнитель читает хранилище арбитра.
 *
 * Команда идемпотентна: повторный запуск публикует те же события с тем же
 * ключом дедупликации, и потребитель применит их повторно без последствий —
 * запись владельца в проекции есть значение, а не приращение.
 */
async function main(): Promise<void> {
  const pool = createPool();
  try {
    const owners = await pool.query<{ slug: string; category: string }>(
      "SELECT slug, category FROM owners ORDER BY slug");
    for (const o of owners.rows) {
      await pool.query(
        `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, dedup_key)
         VALUES ($1, $2, '1.0.0', $3::jsonb, 'owners-projection', $4)`,
        [EVENTS.ownerUpdated.subject, EVENTS.ownerUpdated.eventType,
         JSON.stringify({ slug: o.slug, category: o.category }), `owner:${o.slug}`],
      );
    }
    console.log(`опубликовано владельцев: ${owners.rowCount}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`проекция владельцев не опубликована: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
