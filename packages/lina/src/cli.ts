import { randomUUID } from "node:crypto";
import { createPool } from "@lpmc/runtime";
import { EVENTS } from "@lpmc/contracts";
import { ChannelAdapter } from "./adapter.js";
import { parseReview } from "./review.js";
import { CLI_ADAPTER } from "./identity.js";

/**
 * CLI как канал.
 *
 * Это полноценный канальный адаптер, а не отладочный вход: Telegram и веб-чат
 * будут другими экземплярами того же адаптера, а не переделкой этого кода.
 * Отсюда и внешние идентификаторы: диалог и отправитель у CLI такие же внешние
 * сущности, как чат и пользователь в мессенджере.
 *
 * Прочитанное сообщение НЕ печатается сразу после приёма: то, что человек
 * увидит, обязано пройти egress-проверку PACT и вернуться как одобренное
 * сообщение (L-11). Поэтому «say» подтверждает только приём.
 */
const USAGE = `Использование:
  lina say <текст>            принять сообщение в диалог
  lina read                   показать доставленные ответы
  lina status                 показать состояние диалога
  lina accept                 принять результат работы
  lina reject <причина>       не принять результат и назвать причину

Переменные окружения:
  LPMC_CLI_CONVERSATION       идентификатор диалога (по умолчанию "operator")
  LPMC_CLI_ACTOR              идентификатор отправителя (по умолчанию "operator")
  LPMC_CLI_MESSAGE_ID         идентификатор сообщения; повтор того же значения
                              считается повторной доставкой одного сообщения`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const conversation = process.env["LPMC_CLI_CONVERSATION"] ?? "operator";
  const actor = process.env["LPMC_CLI_ACTOR"] ?? "operator";
  const pool = createPool();
  try {
    switch (command) {
      case "say": {
        const text = rest.join(" ").trim();
        if (text === "") { console.error("пустое сообщение не принимается"); return 2; }
        const adapter = new ChannelAdapter(pool, CLI_ADAPTER);
        const r = await adapter.receive({
          externalConversationId: conversation,
          externalActorId: actor,
          externalMessageId: process.env["LPMC_CLI_MESSAGE_ID"] ?? randomUUID(),
          text,
        });
        if (r.kind === "duplicate") console.log("это сообщение уже принято; второй кандидат не создан");
        else if (r.kind === "question") console.log(`принято; не хватает поля «${r.field}» — вопрос отправлен на проверку`);
        else console.log(`принято; обращение полное, кандидат в задачу опубликован (${r.requestId})`);
        return 0;
      }
      case "accept":
      case "reject": {
        const parsed = parseReview({
          decision: command === "accept" ? "accepted" : "rejected",
          note: rest.join(" "),
        });
        if (!parsed.ok) {
          console.error(parsed.reason === "review.rejection_without_reason"
            ? "нужна причина: «lina reject <причина>»"
            : parsed.reason);
          return 2;
        }
        const route = await pool.query<{ id: string }>(
          `SELECT r.id FROM reply_routes r
             JOIN conversations c ON c.id = r.conversation_id
            WHERE c.external_conversation_id = $1 AND c.channel = $2 AND r.revoked_at IS NULL
            ORDER BY r.created_at DESC LIMIT 1`,
          [conversation, CLI_ADAPTER.channel]);
        const routeId = route.rows[0]?.id;
        if (!routeId) { console.error("в этом диалоге ещё не было обращений"); return 2; }
        await pool.query(
          `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, dedup_key)
           VALUES ($1, $2, '1.0.0', $3::jsonb, $4, $5)`,
          [EVENTS.reviewDecided.subject, EVENTS.reviewDecided.eventType,
           JSON.stringify({
             reply_route_id: routeId,
             channel: CLI_ADAPTER.channel,
             adapter_id: CLI_ADAPTER.adapterId,
             decision: parsed.decision,
             note: parsed.note,
             decided_by: actor,
           }),
           routeId, `review:${routeId}:${Date.now()}`]);
        console.log(parsed.decision === "accepted"
          ? "решение передано: принято"
          : "решение передано: не принято");
        return 0;
      }
      case "read": {
        const r = await pool.query<{ idempotency_key: string; created_at: Date; text: string;
          ephemeral: boolean; revealed_at: Date | null }>(
          `SELECT d.idempotency_key, d.created_at, d.text, d.ephemeral, d.revealed_at
             FROM deliveries d
             JOIN conversations c ON c.id = d.conversation_id
            WHERE c.external_conversation_id = $1 AND c.channel = $2
            ORDER BY d.created_at`,
          [conversation, CLI_ADAPTER.channel],
        );
        if (r.rowCount === 0) { console.log("доставленных ответов нет"); return 0; }
        for (const row of r.rows) {
          if (!row.ephemeral) {
            console.log(`[${row.created_at.toISOString()}] ${row.text}`);
            continue;
          }
          if (row.revealed_at !== null) {
            // Повторно значение не выдаётся: новое выдаёт только новое решение
            // арбитра (L-13). Отметка о том, что оно было, остаётся.
            console.log(`[${row.created_at.toISOString()}] «одноразовое значение уже показано`
              + ` и повторно не выдаётся»`);
            continue;
          }
          console.log(`[${row.created_at.toISOString()}] ${row.text}`);
          // Показ и стирание — одной командой: между ними значение не должно
          // пережить даже сбой.
          await pool.query(
            `UPDATE deliveries SET text = '', revealed_at = now() WHERE idempotency_key = $1`,
            [row.idempotency_key]);
        }
        return 0;
      }
      case "status": {
        const r = await pool.query<{
          objective: string | null; owner_hint: string | null; dod: string[] | null;
          published_at: Date | null; pending: string | null;
        }>(
          `SELECT dr.objective, dr.owner_hint, dr.dod, dr.published_at,
                  (SELECT field FROM open_questions q
                    WHERE q.conversation_id = c.id AND q.answered_at IS NULL
                    ORDER BY q.id LIMIT 1) AS pending
             FROM conversations c JOIN drafts dr ON dr.conversation_id = c.id
            WHERE c.external_conversation_id = $1 AND c.channel = $2`,
          [conversation, CLI_ADAPTER.channel],
        );
        if (r.rowCount === 0) { console.log("диалога нет"); return 0; }
        const d = r.rows[0]!;
        console.log(`цель:      ${d.objective ?? "—"}`);
        console.log(`владелец:  ${d.owner_hint ?? "—"} (подсказка; владельца определяет PACT)`);
        console.log(`приёмка:   ${d.dod?.join("; ") ?? "—"}`);
        console.log(`кандидат:  ${d.published_at ? d.published_at.toISOString() : "не опубликован"}`);
        console.log(`ждём:      ${d.pending ?? "ничего"}`);
        return 0;
      }
      default:
        console.log(USAGE);
        return command === undefined ? 0 : 2;
    }
  } finally {
    await pool.end();
  }
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
