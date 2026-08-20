import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { createPool } from "@lpmc/runtime";
import { EVENTS } from "@lpmc/contracts";
import { ChannelAdapter, CLI_ADAPTER, parseReview } from "@lpmc/lina";

/**
 * TUI полного диалогового цикла LINA.
 *
 * Это ещё один канальный фронтенд контура LINA, а не отдельная система: он
 * пользуется тем же `ChannelAdapter` и тем же каналом «cli», что и командная
 * строка, поэтому ответы возвращаются уже работающим путём
 * (outbound.cli.v1 → lina deliveryd → таблица deliveries). TUI лишь показывает
 * этот путь целиком в одном окне: отправка обращения, ожидание уточняющих
 * вопросов и ответы на них, получение результата, приёмка.
 *
 * Границу контура TUI не переступает. Он подключается к схеме LINA под
 * пользователем lpmc-lina и НЕ видит реестра задач PACT — как и положено
 * недоверенному контуру. Всё, что он показывает как «ответ системы», уже прошло
 * egress-проверку PACT и легло в deliveries; состояние задачи внутри арбитра TUI
 * недоступно, и «ожидание» — честное отражение этой границы, а не заглушка.
 */

const isTty = stdout.isTTY === true;
const C = {
  reset: isTty ? "\x1b[0m" : "",
  dim: isTty ? "\x1b[2m" : "",
  bold: isTty ? "\x1b[1m" : "",
  cyan: isTty ? "\x1b[36m" : "",
  green: isTty ? "\x1b[32m" : "",
  yellow: isTty ? "\x1b[33m" : "",
  red: isTty ? "\x1b[31m" : "",
};

const conversation = process.env["LPMC_TUI_CONVERSATION"] ?? `tui-${randomUUID().slice(0, 8)}`;
const actor = process.env["LPMC_TUI_ACTOR"] ?? "operator";
const pool = createPool();
const adapter = new ChannelAdapter(pool, CLI_ADAPTER);

const rl = createInterface({ input: stdin, output: stdout, prompt: `${C.bold}› ${C.reset}` });
let busy = false;
const seen = new Set<string>();
let lastAt = new Date(0);

/** Напечатать строку НАД приглашением ввода, не затирая набранный текст. */
function line(text: string): void {
  if (isTty) stdout.write("\r\x1b[K");
  stdout.write(text + "\n");
  rl.prompt(true);
}

const meta = (s: string): void => line(`${C.dim}${s}${C.reset}`);
const reply = (s: string): void => line(`${C.cyan}🤖 ${s}${C.reset}`);
const note = (s: string): void => line(`${C.yellow}ℹ ${s}${C.reset}`);
const err = (s: string): void => line(`${C.red}✗ ${s}${C.reset}`);

function banner(): void {
  stdout.write(`${C.bold}LPMC · диалог с Линой${C.reset}\n`);
  stdout.write(`${C.dim}диалог: ${conversation}   отправитель: ${actor}   канал: ${CLI_ADAPTER.channel}${C.reset}\n`);
  stdout.write(`${C.dim}Напишите обращение и нажмите Enter. Лина уточнит недостающее, передаст задачу\n`);
  stdout.write(`через PACT исполнителю и вернёт результат сюда. Команды:${C.reset}\n`);
  stdout.write(`${C.dim}  /accept            принять результат${C.reset}\n`);
  stdout.write(`${C.dim}  /reject <причина>  не принять результат и назвать причину${C.reset}\n`);
  stdout.write(`${C.dim}  /status            состояние обращения (черновик, чего ждём)${C.reset}\n`);
  stdout.write(`${C.dim}  /quit              выход${C.reset}\n\n`);
}

/**
 * Опрос доставленных ответов. Всё, что кладёт в deliveries служба доставки LINA,
 * показывается здесь по мере поступления. Одноразовые значения показываются один
 * раз и стираются той же командой (L-13), как и в командной строке.
 */
async function poll(): Promise<void> {
  const r = await pool.query<{
    idempotency_key: string; created_at: Date; text: string;
    ephemeral: boolean; revealed_at: Date | null;
  }>(
    `SELECT d.idempotency_key, d.created_at, d.text, d.ephemeral, d.revealed_at
       FROM deliveries d JOIN conversations c ON c.id = d.conversation_id
      WHERE c.external_conversation_id = $1 AND c.channel = $2 AND d.created_at >= $3
      ORDER BY d.created_at`,
    [conversation, CLI_ADAPTER.channel, lastAt],
  );
  for (const row of r.rows) {
    if (seen.has(row.idempotency_key)) continue;
    seen.add(row.idempotency_key);
    lastAt = row.created_at > lastAt ? row.created_at : lastAt;
    if (!row.ephemeral) { reply(row.text); continue; }
    if (row.revealed_at !== null) { reply("«одноразовое значение уже показано и повторно не выдаётся»"); continue; }
    reply(row.text);
    // Показ и стирание — одной командой: значение не должно пережить даже сбой.
    await pool.query(
      `UPDATE deliveries SET text = '', revealed_at = now() WHERE idempotency_key = $1`,
      [row.idempotency_key]);
  }
}

async function send(text: string): Promise<void> {
  const r = await adapter.receive({
    externalConversationId: conversation,
    externalActorId: actor,
    externalMessageId: randomUUID(),
    text,
  });
  if (r.kind === "duplicate") meta("это сообщение уже принято; второй кандидат не создан");
  else if (r.kind === "question") meta(`принято; не хватает поля «${r.field}» — жду уточняющий вопрос системы…`);
  else meta(`принято; обращение полное, задача передана (${r.requestId}). Жду результат…`);
}

async function review(decision: "accepted" | "rejected", noteText: string): Promise<void> {
  const parsed = parseReview({ decision, note: noteText });
  if (!parsed.ok) {
    err(parsed.reason === "review.rejection_without_reason"
      ? "нужна причина: «/reject <причина>»" : parsed.reason);
    return;
  }
  const route = await pool.query<{ id: string }>(
    `SELECT r.id FROM reply_routes r
       JOIN conversations c ON c.id = r.conversation_id
      WHERE c.external_conversation_id = $1 AND c.channel = $2 AND r.revoked_at IS NULL
      ORDER BY r.created_at DESC LIMIT 1`,
    [conversation, CLI_ADAPTER.channel]);
  const routeId = route.rows[0]?.id;
  if (!routeId) { err("в этом диалоге ещё не было обращений"); return; }
  await pool.query(
    `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, dedup_key)
     VALUES ($1, $2, '1.0.0', $3::jsonb, $4, $5)`,
    [EVENTS.reviewDecided.subject, EVENTS.reviewDecided.eventType,
     JSON.stringify({
       reply_route_id: routeId, channel: CLI_ADAPTER.channel, adapter_id: CLI_ADAPTER.adapterId,
       decision: parsed.decision, note: parsed.note, decided_by: actor,
     }),
     routeId, `review:${routeId}:${Date.now()}`]);
  meta(parsed.decision === "accepted" ? "решение передано: принято" : "решение передано: не принято");
}

async function status(): Promise<void> {
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
    [conversation, CLI_ADAPTER.channel]);
  if (r.rowCount === 0) { note("диалога ещё нет — напишите первое обращение"); return; }
  const d = r.rows[0]!;
  meta(`цель:     ${d.objective ?? "—"}`);
  meta(`владелец: ${d.owner_hint ?? "—"} (подсказка; владельца определяет PACT)`);
  meta(`приёмка:  ${d.dod?.join("; ") ?? "—"}`);
  meta(`кандидат: ${d.published_at ? "передан " + d.published_at.toISOString() : "не передан"}`);
  meta(`ждём:     ${d.pending ?? "ответа системы"}`);
}

async function handle(input: string): Promise<void> {
  const text = input.trim();
  if (text === "") return;
  if (text === "/quit" || text === "/exit") { await shutdown(); return; }
  if (text === "/status") { await status(); return; }
  if (text === "/accept") { await review("accepted", ""); return; }
  if (text.startsWith("/reject")) { await review("rejected", text.slice("/reject".length).trim()); return; }
  if (text.startsWith("/")) { err("неизвестная команда; /status /accept /reject /quit"); return; }
  await send(text);
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  rl.close();
  await pool.end().catch(() => undefined);
  stdout.write("\n");
  process.exit(0);
}

banner();
void poll().catch(() => undefined);
const timer = setInterval(() => { if (!busy) void poll().catch(() => undefined); }, 900);
timer.unref();
rl.prompt();

// Строки обрабатываются строго по одной: следующая начинается только после того,
// как завершилась предыдущая. Иначе быстрый ввод (или поданный из пайпа сценарий)
// запустил бы обработку второй реплики раньше, чем первая записала свой открытый
// вопрос, и ответ лёг бы не в то поле.
let chain: Promise<void> = Promise.resolve();
rl.on("line", (input) => {
  chain = chain.then(async () => {
    busy = true;
    try { await handle(input); }
    catch (e: unknown) { err(e instanceof Error ? e.message : String(e)); }
    finally { busy = false; rl.prompt(); }
  });
});
rl.on("SIGINT", () => { void shutdown(); });
rl.on("close", () => { void shutdown(); });
