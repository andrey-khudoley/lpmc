import type pg from "pg";
import * as admin from "./admin.js";
import { addTaskType } from "./store.js";

/**
 * Ассистент админки: у каждого раздела свой сайдбар и свой scope — жёстко
 * заданный тип сущности. Тип называть не нужно: раздел уже знает, что заводит.
 * Разбор параметров детерминированный (закрытые формы), как и вся квалификация;
 * чего не хватает — уточняется вопросом.
 *
 * scope: client | endpoint | rule | tasktype (пусто = запасной разбор по словам).
 */

const CAPS = ["page.read", "page.screenshot", "report.build", "api.read", "record.create"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

async function insertMsg(pool: pg.Pool, kind: string, text: string, scope: string): Promise<void> {
  await pool.query("INSERT INTO web_admin_inbox (kind, scope, payload) VALUES ($1, $2, $3::jsonb)",
    [kind, scope, JSON.stringify({ text })]);
}

/** Все реплики со scope — панель раздела берёт свою ленту, группируя по scope. */
export async function getAssistant(pool: pg.Pool): Promise<{ messages: unknown[] }> {
  const r = await pool.query<{ id: string; kind: string; scope: string; payload: object; created_at: Date }>(
    "SELECT id, kind, scope, payload, created_at FROM web_admin_inbox ORDER BY id");
  return { messages: r.rows.map((x) => ({ id: `a${x.id}`, kind: x.kind, scope: x.scope, at: x.created_at, ...(x.payload as object) })) };
}

async function ownerSlugs(pool: pg.Pool): Promise<string[]> {
  try {
    const r = await pool.query<{ slug: string }>("SELECT slug FROM pact.owners WHERE archived_at IS NULL ORDER BY slug");
    return r.rows.map((x) => x.slug);
  } catch { return []; }
}

function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function pickList(text: string, dict: readonly string[]): string[] {
  return dict.filter((d) => new RegExp("(?:^|[\\s,])" + esc(d) + "(?=$|[\\s,])", "i").test(text));
}

export async function assistantMessage(pool: pg.Pool, text: string, scope: string): Promise<{ messages: unknown[] }> {
  const clean = (text || "").trim();
  if (!clean) return getAssistant(pool);
  await insertMsg(pool, "you", clean, scope);
  let reply: string;
  try { reply = await handle(pool, clean, scope); }
  catch (e) { reply = "Не смог выполнить: " + (e instanceof Error ? e.message : String(e)); }
  await insertMsg(pool, "reply", reply, scope);
  return getAssistant(pool);
}

/** Запасной разбор по словам, если scope не задан (панель всегда его задаёт). */
function detect(low: string): string {
  if (/правил|\brule\b|полномочи|капабилит/.test(low)) return "rule";
  if (/разреш|эндпоинт|endpoint|allowlist/.test(low)) return "endpoint";
  if (/тип\s+задач|(?:^|\s)тип(?:\s|$)/.test(low)) return "tasktype";
  if (/клиент|владел/.test(low)) return "client";
  if (/секрет|secret|токен|token/.test(low)) return "secret";
  return "";
}

async function handle(pool: pg.Pool, text: string, scope: string): Promise<string> {
  const low = text.toLowerCase();
  const owners = await ownerSlugs(pool);
  const firstOwner = owners[0] ?? "internal";
  const findOwner = (): string | undefined =>
    owners.find((o) => new RegExp("(?:^|\\s)" + esc(o) + "(?=\\s|$)", "i").test(text));
  const entity = scope || detect(low);

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

  if (entity === "endpoint" || entity === "allow") {
    const host = ((/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i.exec(text) ?? [])[1] ?? "");
    if (!host || !/\.[a-z]{2,}$/i.test(host)) return "Какой хост разрешить? Например: «internal example.com GET».";
    const owner = findOwner() ?? firstOwner;
    let methods = pickList(text.toUpperCase(), METHODS);
    if (!methods.length) methods = ["GET"];
    const op = /удал|delete/i.test(low) ? "delete" : /запис|write|созд/i.test(low) ? "write" : /чтен|read/i.test(low) ? "read" : "auto";
    const pathM = /(?:пути|путь|prefix|префикс\S*)\s+(\/\S+)/i.exec(text);
    const paths = pathM ? [pathM[1]!] : [];
    await admin.addAllow(pool, { owner, host, methods, paths, op });
    return `Готово: ${owner} → ${host} [${methods.join(", ")}]${paths.length ? ", пути " + paths.join(",") : ""}, операция ${op}.`;
  }

  if (entity === "tasktype" || entity === "type") {
    let name = (/тип\S*(?:\s+задач\S*)?\s+[«"]?(.+?)[»"]?\s*$/i.exec(text) ?? [])[1] ?? "";
    if (!name) name = text.replace(/^\s*(?:добав\S*|созда\S*|заведи\S*|нов\S*)\s+(?:тип\S*(?:\s+задач\S*)?)?\s*/i, "").replace(/[«»"]/g, "").trim();
    if (!name) return "Как назвать тип задачи? Например: «Проверить DNS-запись».";
    await addTaskType(pool, { name, keywords: "", executor: "mita", clarify: "", dod_template: "" });
    return `Тип «${name}» добавлен. Уточните ключевые слова и шаблон критериев кнопкой «изменить» в таблице.`;
  }

  if (entity === "client") {
    const stripped = text.replace(/категор\S*\s+\S+/i, " ");
    const m = /(?:клиент\S*|владел\S*)\s+([a-z0-9][a-z0-9-]{1,63})/i.exec(text)
      ?? /(?:добав\S*|созда\S*|заведи\S*)\s+([a-z0-9][a-z0-9-]{1,63})/i.exec(text)
      ?? /(?:^|\s)([a-z][a-z0-9-]{1,63})(?:\s|$)/i.exec(stripped);
    const slug = m ? m[1]!.toLowerCase() : "";
    if (!slug) return "Какой слаг у клиента? Например: «acme-school» (латиница, цифры, дефис).";
    const catM = /категор\S*\s+(client|project|internal|клиент\S*|проект\S*|внутрен\S*)/i.exec(text);
    const category = catM ? (/проект|project/i.test(catM[1]!) ? "project" : /внутрен|internal/i.test(catM[1]!) ? "internal" : "client") : "client";
    await admin.addOwner(pool, slug, category);
    return `Клиент «${slug}» (${category}) заведён.`;
  }

  if (entity === "secret") {
    return "Значение секрета вносится консолью lpmc-admin — мастер-ключ на веб намеренно не выносится. Здесь можно только удалить имя секрета.";
  }

  return "Не понял запрос. Опишите, что завести — я в этом разделе.";
}
