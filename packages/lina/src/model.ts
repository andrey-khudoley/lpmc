import http from "node:http";
import { estimateTokens } from "./budget.js";

/**
 * Клиент модели.
 *
 * Три свойства, которые важнее самого вызова.
 *
 * 1. Обращение идёт ЧЕРЕЗ ПРОКСИ (D-026). Исключения для «своей» модели нет:
 *    иначе единственный путь наружу перестал бы быть единственным, и запись
 *    в журнале прокси перестала бы означать «весь исходящий трафик узла».
 * 2. Ключ приходит от арбитра вместе с доступом, а не из конфигурации службы.
 *    Конфигурация не ведёт журнала и не отзывается; custody делает и то, и другое.
 * 3. Недоступность модели — не отказ человеку. Диалог обязан продолжаться
 *    правилами: беседа, которая обрывается из-за внешней службы, хуже беседы,
 *    в которой вопросы формулируются суше.
 */
export interface ModelAccess {
  runId: string;
  secret: string;
  proxy: string;
  apiKey: string;
  allow: { host: string; methods: string[] }[];
}

export type ModelOutcome =
  | { ok: true; text: string; tokens: number }
  | { ok: false; reason: string };

const MODEL_SOCKET = process.env["LPMC_MODEL_SOCKET"] ?? "/run/lpmc-pact/model.sock";

/** Запрос доступа к модели у арбитра. Отказ — обычный исход, а не сбой. */
export function requestModelAccess(service: string, purpose: string): Promise<ModelAccess | { error: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ service, purpose });
    const req = http.request(
      { socketPath: MODEL_SOCKET, path: "/model-access", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) {
            let reason = text;
            try { reason = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* как есть */ }
            resolve({ error: reason });
            return;
          }
          const p = JSON.parse(text) as {
            run_id: string; secret: string; proxy: string; api_key: string;
            allow: { host: string; methods: string[] }[];
          };
          resolve({ runId: p.run_id, secret: p.secret, proxy: p.proxy, apiKey: p.api_key, allow: p.allow });
        });
      },
    );
    req.on("error", (e) => resolve({ error: `model.socket_unavailable:${e.message}` }));
    req.end(body);
  });
}

/**
 * Обращение к модели через прокси.
 *
 * Учётные данные прокси предъявляются заголовком: это HTTP-клиент, а не браузер,
 * и он добавляет заголовки ко всем своим запросам сам (D-019, первый способ
 * предъявления).
 */
export function ask(
  access: ModelAccess, system: string, prompt: string, maxTokens = 512,
): Promise<ModelOutcome> {
  const host = access.allow[0]?.host;
  if (!host) return Promise.resolve({ ok: false, reason: "model.no_allowed_host" });

  const payload = JSON.stringify({
    model: process.env["LPMC_MODEL_ID"] ?? "claude-sonnet-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  // Значение ключа уходит заголовком, а заголовки HTTP не переносят ничего,
  // кроме латиницы. Непригодное значение — это отказ с понятной причиной,
  // а не исключение внутри клиента: секрет мог быть внесён с опечаткой,
  // и узнать об этом надо из журнала, а не по падению процесса.
  if (!/^[\x20-\x7e]+$/.test(access.apiKey)) {
    return Promise.resolve({ ok: false, reason: "model.key_not_header_safe" });
  }
  const [proxyHost, proxyPort] = access.proxy.split(":");
  const auth = Buffer.from(`${access.runId}:${access.secret}`).toString("base64");

  return new Promise((resolve) => {
    const req = http.request({
      host: proxyHost, port: Number(proxyPort ?? 3128), method: "POST",
      // Абсолютный URL в строке запроса — обычная форма обращения к прокси.
      path: `https://${host}/v1/messages`,
      headers: {
        "Proxy-Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": access.apiKey,
        "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) >= 300) {
          resolve({ ok: false, reason: `model.http_${res.statusCode}` });
          return;
        }
        try {
          const parsed = JSON.parse(text) as {
            content?: { text?: string }[];
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          const answer = parsed.content?.map((c) => c.text ?? "").join("") ?? "";
          const tokens = (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0)
            || estimateTokens(prompt + answer);
          resolve({ ok: true, text: answer, tokens });
        } catch {
          resolve({ ok: false, reason: "model.unreadable_response" });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, reason: `model.request_failed:${e.message}` }));
    req.end(payload);
  });
}
