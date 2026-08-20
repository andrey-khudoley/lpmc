import http from "node:http";
import type { ProxyCredentials } from "./http.js";

/**
 * Обращения к арбитру по узкому каналу: учётные данные запуска и значения
 * секретов. Оба — по предъявлении лизинга, оба сверяются с реестром.
 */
const SOCKET = process.env["LPMC_LEASE_SOCKET"] ?? "/run/lpmc-pact/lease.sock";

export async function requestCredentials(
  runId: string, leaseId: string,
): Promise<ProxyCredentials & { expiresAt: string }> {
  const res = await call(`/runs/${runId}/proxy`, { lease_id: leaseId });
  if (!res.ok) throw new Error(`арбитр отказал в учётных данных: ${res.text}`);
  const p = JSON.parse(res.text) as { run_id: string; secret: string; proxy: string; expires_at: string };
  return { runId: p.run_id, secret: p.secret, proxy: p.proxy, expiresAt: p.expires_at };
}

export type SecretOutcome = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Отказ в выдаче секрета — обычный исход, а не исключение: на первой волне
 * реестр имён пуст, и это нормальное состояние узла.
 */
export async function requestSecret(
  runId: string, leaseId: string, name: string,
): Promise<SecretOutcome> {
  const res = await call(`/runs/${runId}/secrets/${encodeURIComponent(name)}`, { lease_id: leaseId });
  if (!res.ok) {
    let reason = res.text;
    try { reason = (JSON.parse(res.text) as { error?: string }).error ?? res.text; } catch { /* как есть */ }
    return { ok: false, reason };
  }
  const p = JSON.parse(res.text) as { value: string };
  return { ok: true, value: p.value };
}

function call(path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { socketPath: SOCKET, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          ok: (res.statusCode ?? 0) < 300, text: Buffer.concat(chunks).toString("utf8"),
        }));
      });
    req.on("error", reject);
    req.end(payload);
  });
}
