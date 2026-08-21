import type pg from "pg";
import https from "node:https";

/**
 * Провайдеры модели с фейловером по приоритету.
 *
 * Веб-ассистент интерпретирует запрос моделью. Провайдеров несколько; вызов идёт
 * по возрастанию priority и при отказе переходит к следующему. Значения ключей
 * наружу не отдаются — только признак «задан».
 */

export interface ProviderView {
  id: string; kind: string; enabled: boolean; model: string; priority: number; has_key: boolean;
}

export async function listProviders(pool: pg.Pool): Promise<{ providers: ProviderView[] }> {
  const r = await pool.query<ProviderView>(
    "SELECT id, kind, enabled, model, priority, (api_key <> '') AS has_key FROM web_llm_providers ORDER BY priority, id");
  return { providers: r.rows };
}

export async function updateProvider(pool: pg.Pool, id: number, p: {
  enabled?: boolean | undefined; model?: string | undefined; apiKey?: string | undefined;
}): Promise<void> {
  // Ключ переписываем только если прислан непустым; иначе прежний сохраняется.
  await pool.query(
    `UPDATE web_llm_providers
        SET enabled = COALESCE($2, enabled),
            model   = COALESCE($3, model),
            api_key = CASE WHEN $4 <> '' THEN $4 ELSE api_key END,
            updated_at = now()
      WHERE id = $1`,
    [id, p.enabled ?? null, p.model && p.model.trim() !== "" ? p.model : null, p.apiKey ?? ""]);
}

/** Очистить ключ (кнопка «убрать ключ»). */
export async function clearKey(pool: pg.Pool, id: number): Promise<void> {
  await pool.query("UPDATE web_llm_providers SET api_key='', updated_at=now() WHERE id=$1", [id]);
}

export async function anyEnabled(pool: pg.Pool): Promise<boolean> {
  const r = await pool.query<{ n: string }>("SELECT count(*) AS n FROM web_llm_providers WHERE enabled = true AND api_key <> ''");
  return Number(r.rows[0]?.n ?? 0) > 0;
}

export async function reorder(pool: pg.Pool, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await pool.query("UPDATE web_llm_providers SET priority=$2, updated_at=now() WHERE id=$1", [ids[i], i + 1]);
  }
}

function post(host: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({ host, path, method: "POST",
      headers: { ...headers, "content-length": String(data.length) }, timeout: 45000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        let json: unknown = {}; try { json = t ? JSON.parse(t) : {}; } catch { json = { raw: t }; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(data);
  });
}

async function callProvider(kind: string, model: string, key: string, system: string, user: string): Promise<string> {
  if (kind === "openai") {
    const { status, json } = await post("api.openai.com", "/v1/chat/completions",
      { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      { model, max_tokens: 1024, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
    if (status >= 300) throw new Error(`openai ${status}: ${JSON.stringify(json).slice(0, 140)}`);
    const c = (json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
    if (!c) throw new Error("openai: пустой ответ");
    return c;
  }
  // anthropic (x-api-key) или subscription (OAuth Bearer + beta)
  const headers = kind === "subscription"
    ? { Authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const { status, json } = await post("api.anthropic.com", "/v1/messages", headers,
    { model, max_tokens: 1024, system, messages: [{ role: "user", content: user }] });
  if (status >= 300) throw new Error(`${kind} ${status}: ${JSON.stringify(json).slice(0, 140)}`);
  const text = (json as { content?: { text?: string }[] }).content?.[0]?.text;
  if (!text) throw new Error(`${kind}: пустой ответ`);
  return text;
}

/**
 * Пройтись по включённым провайдерам в порядке приоритета до первого успеха.
 * Возвращает текст ответа и имя сработавшего провайдера, либо список ошибок.
 */
export async function complete(pool: pg.Pool, system: string, user: string): Promise<
  { ok: true; text: string; provider: string } | { ok: false; errors: string[] }
> {
  const r = await pool.query<{ kind: string; model: string; api_key: string }>(
    "SELECT kind, model, api_key FROM web_llm_providers WHERE enabled = true ORDER BY priority, id");
  const errors: string[] = [];
  for (const p of r.rows) {
    if (!p.api_key) { errors.push(`${p.kind}: ключ не задан`); continue; }
    if (!p.model) { errors.push(`${p.kind}: модель не выбрана`); continue; }
    try {
      const text = await callProvider(p.kind, p.model, p.api_key, system, user);
      return { ok: true, text, provider: p.kind };
    } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  return { ok: false, errors };
}
