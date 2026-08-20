import { hostname } from "node:os";
import { headers } from "nats";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS } from "@lpmc/contracts";

/**
 * Ручной разбор отклонённого исходящего (W1-PACT-09).
 *
 * Инструмент оператора. Две операции: посмотреть очередь и выпустить то, что
 * человек счёл безопасным. Третьей — «выпустить всё» — намеренно нет.
 *
 * Выпуск после разбора публикует РОВНО тот текст, который лежит в очереди.
 * Возможности отредактировать его здесь нет: правка означала бы, что наружу
 * уходит текст, которого не составлял ни исполнитель, ни LINA, и авторство
 * потерялось бы.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/pact/nats/pact-egress-guard.seed";

async function main(): Promise<number> {
  const [command, id, ...rest] = process.argv.slice(2);
  const by = rest.join(" ").trim();
  const pool = createPool();
  try {
    if (command === "list" || command === undefined) {
      const r = await pool.query<{
        proposal_id: string; content_class: string; decision: string; reason: string;
        content: string; created_at: Date;
      }>(
        `SELECT proposal_id, content_class, decision, reason, content, created_at
           FROM egress_review WHERE released_at IS NULL AND dismissed_at IS NULL
          ORDER BY created_at`);
      if (r.rowCount === 0) { console.log("очередь разбора пуста"); return 0; }
      for (const row of r.rows) {
        console.log(`${row.created_at.toISOString()}  ${row.proposal_id}`);
        console.log(`  класс: ${row.content_class}; решение: ${row.decision}; причина: ${row.reason}`);
        console.log(`  текст: ${row.content.slice(0, 300).replace(/\n/g, " ⏎ ")}`);
      }
      return 0;
    }

    if (command === "dismiss") {
      if (!id || !by) { console.error("использование: review-egress dismiss <id> <кто>"); return 2; }
      const r = await pool.query(
        `UPDATE egress_review SET dismissed_at = now(), dismissed_by = $2
          WHERE proposal_id = $1 AND released_at IS NULL AND dismissed_at IS NULL`, [id, by]);
      console.log(r.rowCount ? `${id}: снято с разбора (${by})` : `${id}: нечего снимать`);
      return r.rowCount ? 0 : 1;
    }

    if (command !== "release") {
      console.log("использование: review-egress [list] | release <id> <кто> | dismiss <id> <кто>");
      return 2;
    }
    if (!id || !by) { console.error("использование: review-egress release <id> <кто>"); return 2; }

    // Отметка ставится ДО публикации и в один заход: повторный запуск команды
    // не выпустит сообщение второй раз, даже если публикация не удалась.
    const claim = await pool.query<{
      reply_route_id: string; channel: string; adapter_id: string; content: string;
    }>(
      `UPDATE egress_review SET released_at = now(), released_by = $2
        WHERE proposal_id = $1 AND released_at IS NULL AND dismissed_at IS NULL
        RETURNING reply_route_id, channel, adapter_id, content`, [id, by]);
    const row = claim.rows[0];
    if (!row) { console.error(`${id}: не найдено или уже разобрано`); return 1; }

    const nc = await connectAs(`pact-review@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
    try {
      const h = headers();
      h.set("Nats-Msg-Id", id);
      await nc.jetstream().publish(
        `outbound.${row.channel}.v1`,
        new TextEncoder().encode(JSON.stringify({
          event_id: id,
          event_type: EVENTS.messageDispatchRequested.eventType,
          schema_version: "1.0.0",
          occurred_at: new Date().toISOString(),
          producer: { service: "pact-egress-guard", instance: `review:${by}` },
          correlation_id: row.reply_route_id,
          payload: {
            message_id: id,
            destination: { channel: row.channel, adapter_id: row.adapter_id,
              reply_route_id: row.reply_route_id },
            content: { text: row.content, attachment_refs: [] },
            visibility: "external",
            idempotency_key: id,
          },
        })),
        { headers: h, expect: { streamName: "OUTBOUND" } });
      // Решение человека попадает в журнал решений отдельной записью: по нему
      // должно быть видно, что выпуск состоялся не по правилу, а по разбору.
      await pool.query(
        `INSERT INTO egress_decisions (proposal_id, reply_route_id, channel, content_class,
           decision, reason, chars)
         VALUES ($1, $2, $3, 'notification', 'ALLOWED', $4, $5)
         ON CONFLICT (proposal_id) DO UPDATE SET decision = 'ALLOWED', reason = EXCLUDED.reason`,
        [id, row.reply_route_id, row.channel, `egress.released_by_human:${by}`, row.content.length]);
      console.log(`${id}: выпущено после разбора (${by})`);
      return 0;
    } finally {
      await nc.drain();
    }
  } finally {
    await pool.end();
  }
}

main().then((c) => process.exit(c)).catch((e: unknown) => {
  console.error(`разбор не выполнен: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
