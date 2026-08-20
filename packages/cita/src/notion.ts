import { request, type ProxyCredentials } from "./http.js";

/**
 * Чтение строк из базы данных Notion.
 *
 * Сценарий выбран как первый пример контрактной модальности: у него есть всё,
 * что отличает работу по договорному интерфейсу от работы через браузер —
 * пагинация, лимиты частоты, схема ответа и токен из custody.
 *
 * Что здесь НЕ делается: запись, изменение и удаление. Модальность их допускает,
 * но полномочие на них не выдано, а необратимость таких операций не
 * классифицирована — то есть они запрещены механизмом, а не воздержанием.
 */
export const NOTION_HOST = "api.notion.com";
export const NOTION_VERSION = process.env["LPMC_NOTION_VERSION"] ?? "2022-06-28";

/** Максимум строк в одном ответе — ограничение стороны Notion, а не наше. */
export const PAGE_SIZE_LIMIT = 100;

export interface NotionRow {
  id: string;
  properties: Record<string, unknown>;
}

export type QueryOutcome =
  | { ok: true; rows: NotionRow[]; requests: number; hasMore: boolean }
  | { ok: false; status: number; reason: string; requests: number };

/**
 * Запрос строк с пагинацией.
 *
 * Ограничение `limit` соблюдается на нашей стороне: внешняя система вернёт
 * столько, сколько разрешит её собственный предел, и остановиться обязаны мы.
 * Иначе «сто значений» превращались бы в обход всей базы при первом же
 * увеличении её размера.
 */
export async function queryDataSource(
  creds: ProxyCredentials, token: string, dataSourceId: string, limit: number,
  filter?: Record<string, unknown>,
): Promise<QueryOutcome> {
  const rows: NotionRow[] = [];
  let cursor: string | undefined;
  let requests = 0;
  let hasMore = false;

  while (rows.length < limit) {
    const pageSize = Math.min(PAGE_SIZE_LIMIT, limit - rows.length);
    const body: Record<string, unknown> = { page_size: pageSize };
    if (cursor !== undefined) body["start_cursor"] = cursor;
    if (filter !== undefined) body["filter"] = filter;

    const res = await request(
      creds, "POST", `https://${NOTION_HOST}/v1/data_sources/${dataSourceId}/query`,
      {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      JSON.stringify(body),
    );
    requests += 1;
    if (res.status !== 200) {
      // Диагностика внешней системы не пересказывается человеку: она уходит
      // во внутренний результат, а наружу — только через проверку исходящего.
      return { ok: false, status: res.status, reason: shortReason(res.status, res.body), requests };
    }
    const parsed = JSON.parse(res.body) as {
      results?: { id?: string; properties?: Record<string, unknown> }[];
      has_more?: boolean; next_cursor?: string | null;
    };
    for (const r of parsed.results ?? []) {
      rows.push({ id: String(r.id ?? ""), properties: r.properties ?? {} });
    }
    hasMore = parsed.has_more === true;
    if (!hasMore || !parsed.next_cursor) break;
    cursor = parsed.next_cursor;
  }
  return { ok: true, rows: rows.slice(0, limit), requests, hasMore };
}

/**
 * Короткая типизированная причина по коду ответа.
 *
 * Notion намеренно не отличает «нет доступа» от «не существует», отвечая 404
 * в обоих случаях; пересказывать это как «база удалена» было бы догадкой.
 */
export function shortReason(status: number, body: string): string {
  const code = safeCode(body);
  switch (status) {
    case 401: return "notion.unauthorized";
    case 403: return "notion.forbidden";
    case 404: return "notion.not_found_or_not_shared";
    case 429: return "notion.rate_limited";
    default: return code !== null ? `notion.${code}` : `notion.http_${status}`;
  }
}

function safeCode(body: string): string | null {
  try {
    const p = JSON.parse(body) as { code?: unknown };
    return typeof p.code === "string" && /^[a-z_]{1,64}$/.test(p.code) ? p.code : null;
  } catch {
    return null;
  }
}

/**
 * Значения свойств в плоском виде — то, что человек называет «строкой таблицы».
 * Разбираются только те типы, которые встречаются в первом сценарии; остальные
 * помечаются типом, а не додумываются.
 */
export function flattenProperties(properties: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(properties)) {
    const v = raw as { type?: string } & Record<string, unknown>;
    switch (v?.type) {
      case "title":
      case "rich_text": {
        const parts = (v[v.type] as { plain_text?: string }[] | undefined) ?? [];
        out[name] = parts.map((p) => p.plain_text ?? "").join("");
        break;
      }
      case "number": out[name] = v["number"] === null ? "" : String(v["number"]); break;
      case "select": out[name] = String((v["select"] as { name?: string } | null)?.name ?? ""); break;
      case "status": out[name] = String((v["status"] as { name?: string } | null)?.name ?? ""); break;
      case "multi_select":
        out[name] = ((v["multi_select"] as { name?: string }[] | undefined) ?? [])
          .map((x) => x.name ?? "").join(", ");
        break;
      case "checkbox": out[name] = v["checkbox"] === true ? "да" : "нет"; break;
      case "date": out[name] = String((v["date"] as { start?: string } | null)?.start ?? ""); break;
      case "url": case "email": case "phone_number":
        out[name] = String(v[v.type] ?? ""); break;
      default:
        out[name] = `«тип ${String(v?.type ?? "неизвестен")} не разобран»`;
    }
  }
  return out;
}

/**
 * Создание страницы в базе — НЕОБРАТИМАЯ операция.
 *
 * Функция вызывается только после подтверждения человеком: остановка происходит
 * раньше, в исполнителе, и до неё сюда попасть нельзя. Обратного вызова
 * «удалить созданное» здесь нет намеренно — необратимость означает, что откат
 * не является частью механизма.
 */
export interface CreatedRecord {
  id: string;
  url: string | null;
}

export type CreateOutcome =
  | { ok: true; record: CreatedRecord }
  | { ok: false; status: number; reason: string };

export async function createPage(
  creds: ProxyCredentials, token: string, dataSourceId: string, title: string,
  titleProperty: string,
): Promise<CreateOutcome> {
  const res = await request(
    creds, "POST", `https://${NOTION_HOST}/v1/pages`,
    {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    JSON.stringify({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: { [titleProperty]: { title: [{ text: { content: title } }] } },
    }),
  );
  if (res.status !== 200) {
    return { ok: false, status: res.status, reason: shortReason(res.status, res.body) };
  }
  const p = JSON.parse(res.body) as { id?: string; url?: string };
  return { ok: true, record: { id: String(p.id ?? ""), url: p.url ?? null } };
}
