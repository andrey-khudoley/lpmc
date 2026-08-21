import type pg from "pg";
import * as admin from "./admin.js";
import { addTaskType } from "./store.js";

/**
 * Ассистент админки: детерминированный разбор запроса оператора в действие над
 * сущностью политики. Понимания текста нет — только закрытые формы команд, как и
 * в остальной квалификации. Что распознано, то и создаётся теми же функциями, что
 * зовут мастера; чего не хватает — уточняется вопросом.
 */

const CAPS = ["page.read", "page.screenshot", "report.build", "api.read", "record.create"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

async function insertMsg(pool: pg.Pool, kind: string, text: string): Promise<void> {
  await pool.query("INSERT INTO web_admin_inbox (kind, payload) VALUES ($1, $2::jsonb)", [kind, JSON.stringify({ text })]);
}

export async function getAssistant(pool: pg.Pool): Promise<{ messages: unknown[] }> {
  const r = await pool.query<{ id: string; kind: string; payload: object; created_at: Date }>(
    "SELECT id, kind, payload, created_at FROM web_admin_inbox ORDER BY id");
  return { messages: r.rows.map((x) => ({ id: `a${x.id}`, kind: x.kind, at: x.created_at, ...(x.payload as object) })) };
}

async function ownerSlugs(pool: pg.Pool): Promise<string[]> {
  try {
    const r = await pool.query<{ slug: string }>("SELECT slug FROM pact.owners WHERE archived_at IS NULL ORDER BY slug");
    return r.rows.map((x) => x.slug);
  } catch { return []; }
}

/** Выбор известных токенов из текста (для методов и capability). */
function pickList(text: string, dict: readonly string[]): string[] {
  return dict.filter((d) => new RegExp("(?:^|[\\s,])" + d.replace(/[.]/g, "\\.") + "(?=$|[\\s,])", "i").test(text));
}

export async function assistantMessage(pool: pg.Pool, text: string, screen: string): Promise<{ messages: unknown[] }> {
  const clean = (text || "").trim();
  if (!clean) return getAssistant(pool);
  await insertMsg(pool, "you", clean);
  let reply: string;
  try { reply = await handle(pool, clean, screen || ""); }
  catch (e) { reply = "Не смог выполнить: " + (e instanceof Error ? e.message : String(e)); }
  await insertMsg(pool, "reply", reply);
  return getAssistant(pool);
}

const HELP = "Я умею заводить:\n"
  + "• клиента — «добавь клиента acme-school» (категория client/project/internal)\n"
  + "• эндпоинт — «разреши internal example.com GET» (методы, «пути /v1», «операция read»)\n"
  + "• правило — «правило cli:operator internal page.read report.build исполнитель mita»\n"
  + "• тип задачи — «добавь тип Проверить доступность»";

async function handle(pool: pg.Pool, text: string, screen: string): Promise<string> {
  const low = text.toLowerCase();
  const owners = await ownerSlugs(pool);
  const firstOwner = owners[0] ?? "internal";
  const findOwner = (): string | undefined =>
    owners.find((o) => new RegExp("(?:^|\\s)" + o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)", "i").test(text));

  const wantsRule = /правил|\brule\b|полномочи|капабилит|capabilit/.test(low);
  const wantsAllow = /разреш|эндпоинт|endpoint|allowlist|\ballow\b|ходить\s+на|доступ\s+к|adres|адрес/.test(low);
  const wantsType = /тип\s+задач|(?:^|\s)тип(?:\s|$)/.test(low);
  const wantsClient = /клиент|владел/.test(low);
  const wantsSecret = /секрет|secret|токен|token/.test(low);

  // Явные ключевые слова — приоритетнее контекста экрана; экран — только запасной
  // выбор, когда сущность в тексте не названа.
  const entity = wantsRule ? "rule" : wantsAllow ? "allow" : wantsType ? "type" : wantsClient ? "client" : wantsSecret ? "secret"
    : screen === "services" ? "allow" : screen === "clients" ? "client" : screen === "types" ? "type" : screen === "secrets" ? "secret" : "";

  if (entity === "rule") {
    const sender = (/cli:[a-z0-9_.-]+/i.exec(text) ?? [])[0] ?? "cli:operator";
    const owner = findOwner() ?? firstOwner;
    const caps = pickList(text, CAPS);
    const exec = /\bcita\b/i.test(text) ? "cita" : "mita";
    const lease = Number((/(?:лизинг|lease)\D{0,3}(\d{2,6})/i.exec(text) ?? [])[1]) || 1800;
    const appr = /подтвержд|approval|апрув/i.test(low);
    if (!caps.length) return `Правило ${sender} → ${owner}: какие полномочия выдать? Доступны: ${CAPS.join(", ")}.`;
    await admin.addRule(pool, { sender, owner, caps, exec, lease, appr });
    return `Готово: правило ${sender} → ${owner}, полномочия [${caps.join(", ")}], исполнитель ${exec}, лизинг ${lease}с${appr ? ", с подтверждением" : ""}.`;
  }

  if (entity === "allow") {
    const host = ((/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i.exec(text) ?? [])[1] ?? "");
    if (!host || !/\.[a-z]{2,}$/i.test(host)) return "Какой хост разрешить? Например: «разреши internal example.com GET».";
    const owner = findOwner() ?? firstOwner;
    let methods = pickList(text.toUpperCase(), METHODS);
    if (!methods.length) methods = ["GET"];
    const op = /удал|delete/i.test(low) ? "delete" : /запис|write|созд/i.test(low) ? "write" : /чтен|read/i.test(low) ? "read" : "auto";
    const pathM = /(?:пути|путь|prefix|префикс\S*)\s+(\/\S+)/i.exec(text);
    const paths = pathM ? [pathM[1]!] : [];
    await admin.addAllow(pool, { owner, host, methods, paths, op });
    return `Готово: ${owner} → ${host} [${methods.join(", ")}]${paths.length ? ", пути " + paths.join(",") : ""}, операция ${op}.`;
  }

  if (entity === "type") {
    const nameM = /тип\S*(?:\s+задач\S*)?\s+[«"]?(.+?)[»"]?\s*$/i.exec(text);
    const name = (nameM ? nameM[1]! : "").trim();
    if (!name) return "Как назвать тип задачи? Например: «добавь тип Проверить DNS-запись».";
    await addTaskType(pool, { name, keywords: "", executor: "mita", clarify: "", dod_template: "" });
    return `Тип «${name}» добавлен. Уточните ключевые слова и шаблон критериев в разделе «Типы задач» (кнопка «изменить»).`;
  }

  if (entity === "client") {
    const m = /(?:клиент\S*|владел\S*)\s+([a-z0-9][a-z0-9-]{1,63})/i.exec(text) ?? /(?:добав\S*|созда\S*|заведи\S*)\s+([a-z0-9][a-z0-9-]{1,63})/i.exec(text);
    const slug = m ? m[1]!.toLowerCase() : "";
    if (!slug) return "Какой слаг у клиента? Например: «добавь клиента acme-school».";
    const catM = /категор\S*\s+(client|project|internal|клиент\S*|проект\S*|внутрен\S*)/i.exec(text);
    const category = catM ? (/проект|project/i.test(catM[1]!) ? "project" : /внутрен|internal/i.test(catM[1]!) ? "internal" : "client") : "client";
    await admin.addOwner(pool, slug, category);
    return `Клиент «${slug}» (${category}) заведён.`;
  }

  if (entity === "secret") {
    return "Значение секрета вносится консолью lpmc-admin — мастер-ключ на веб намеренно не выносится. Здесь можно только удалить имя секрета в разделе «Секреты».";
  }

  return "Не понял запрос. " + HELP;
}
