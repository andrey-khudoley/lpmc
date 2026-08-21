import type pg from "pg";
import https from "node:https";
import http from "node:http";

// Мост подписки: вызов исполняется НА МАШИНЕ процессом с логином (/login), веб
// лишь проксирует сюда — токен в веб/БД не попадает.
const BRIDGE_URL = process.env["LPMC_LLM_BRIDGE"] ?? "http://127.0.0.1:6210/complete";

function bridge(model: string, system: string, user: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(BRIDGE_URL);
    const data = Buffer.from(JSON.stringify({ model, system, user }));
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", timeout: 50000,
      headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      const c: Buffer[] = []; res.on("data", (x: Buffer) => c.push(x));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("мост недоступен (timeout)")));
    req.end(data);
  });
}

/**
 * Провайдеры модели с фейловером по приоритету.
 *
 * Веб-ассистент интерпретирует запрос моделью. Провайдеров несколько; вызов идёт
 * по возрастанию priority и при отказе переходит к следующему. Значения ключей
 * наружу не отдаются — только признак «задан».
 */

// ---- Каталог моделей (внешний источник models.dev: id + цены) --------------

export interface ModelInfo { id: string; name: string; in_price: number | null; out_price: number | null; label: string }

function fetchJson(host: string, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: "GET", timeout: 20000,
      headers: { "user-agent": "Mozilla/5.0 (LPMC model-catalog)", accept: "application/json" } }, (res) => {
      const c: Buffer[] = []; res.on("data", (x: Buffer) => c.push(x));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// Популярность: models.dev её не даёт, поэтому курируем порядок флагманов.
const ORDER: Record<string, string[]> = {
  anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-haiku", "claude-opus", "claude-sonnet"],
  openai: ["gpt-5.3-chat", "gpt-5.1-chat", "gpt-5-chat", "gpt-5", "gpt-5-pro", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3", "o1"],
};
const OPENAI_EXCLUDE = /image|embedding|tts|whisper|audio|realtime|moderation|dall-e|sora|transcribe|search|codex|computer|guardrail/i;

function rankOf(id: string, order: string[]): number {
  const exact = order.indexOf(id);
  if (exact >= 0) return exact;
  for (let i = 0; i < order.length; i++) if (id.includes(order[i]!)) return i;
  return order.length + 1;
}

let catalogCache: { at: number; data: { anthropic: ModelInfo[]; openai: ModelInfo[] } } | null = null;

async function buildCatalog(): Promise<{ anthropic: ModelInfo[]; openai: ModelInfo[] }> {
  const d = await fetchJson("models.dev", "/api.json");
  const pick = (prov: string, exclude?: RegExp): ModelInfo[] => {
    const models = ((d[prov] as { models?: Record<string, { name?: string; cost?: { input?: number; output?: number } }> } | undefined)?.models) ?? {};
    const arr = Object.keys(models).filter((id) => {
      if (exclude && exclude.test(id)) return false;
      return models[id]?.cost?.input != null; // только модели с токенной ценой (текстовые)
    }).map((id): ModelInfo => {
      const m = models[id]!; const ci = m.cost?.input ?? null, co = m.cost?.output ?? null;
      const price = ci != null && co != null ? ` · $${ci}/$${co} за 1M` : "";
      return { id, name: m.name ?? id, in_price: ci, out_price: co, label: `${m.name ?? id}${price}` };
    });
    arr.sort((a, b) => { const ra = rankOf(a.id, ORDER[prov] ?? []), rb = rankOf(b.id, ORDER[prov] ?? []); return ra !== rb ? ra - rb : a.id.localeCompare(b.id); });
    return arr;
  };
  return { anthropic: pick("anthropic"), openai: pick("openai", OPENAI_EXCLUDE) };
}

export async function listModels(): Promise<{ anthropic: ModelInfo[]; openai: ModelInfo[] }> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < 6 * 3600 * 1000) return catalogCache.data;
  try { const data = await buildCatalog(); catalogCache = { at: now, data }; return data; }
  catch { return catalogCache?.data ?? { anthropic: [], openai: [] }; }
}

export interface ProviderView {
  id: string; kind: string; enabled: boolean; model: string; priority: number; has_key: boolean;
  bridge_ok?: boolean; login_ok?: boolean;
}

function bridgeHealth(): Promise<{ ok: boolean; hasLogin: boolean }> {
  return new Promise((resolve) => {
    const u = new URL(BRIDGE_URL.replace(/\/complete$/, "/health"));
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: "GET", timeout: 1500 }, (res) => {
      const c: Buffer[] = []; res.on("data", (x: Buffer) => c.push(x));
      res.on("end", () => { try { const j = JSON.parse(Buffer.concat(c).toString()); resolve({ ok: !!j.ok, hasLogin: !!j.hasLogin }); } catch { resolve({ ok: false, hasLogin: false }); } });
    });
    req.on("error", () => resolve({ ok: false, hasLogin: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, hasLogin: false }); });
    req.end();
  });
}

export async function listProviders(pool: pg.Pool): Promise<{ providers: ProviderView[] }> {
  const r = await pool.query<ProviderView>(
    "SELECT id, kind, enabled, model, priority, (api_key <> '') AS has_key FROM web_llm_providers ORDER BY priority, id");
  const sub = r.rows.find((p) => p.kind === "subscription");
  if (sub) { const h = await bridgeHealth(); sub.bridge_ok = h.ok; sub.login_ok = h.hasLogin; }
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
  const r = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM web_llm_providers WHERE enabled = true AND (kind = 'subscription' OR api_key <> '')");
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
  if (kind === "subscription") {
    // Токен не хранится в вебе — вызов исполняет мост на машине (там логин /login).
    const r = await bridge(model, system, user);
    if (!r.ok || !r.text) throw new Error(r.error || "subscription: мост вернул пусто");
    return r.text;
  }
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
    // Подписка ключа в вебе не требует — токен даёт мост машины.
    if (p.kind !== "subscription" && !p.api_key) { errors.push(`${p.kind}: ключ не задан`); continue; }
    if (!p.model) { errors.push(`${p.kind}: модель не выбрана`); continue; }
    try {
      const text = await callProvider(p.kind, p.model, p.api_key, system, user);
      return { ok: true, text, provider: p.kind };
    } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  return { ok: false, errors };
}
