import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import type { SessionRegistry } from "./sessions.js";

/**
 * Административный интерфейс: выдача и гашение сеансов просмотра.
 *
 * Живёт на unix-сокете с группой PACT — решение о допуске человека к экрану
 * принимает арбитр (MITA §11), а не исполнитель и не сам человек. Исполнителю
 * сокет недоступен: MITA не может выдать себе просмотр, даже когда это удобно.
 * Пока арбитр не написан, тот же интерфейс дёргает оператор от имени PACT —
 * меняется вызывающий, а не механизм.
 */
export function createAdminServer(cfg: Config, reg: SessionRegistry): http.Server {
  return http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/sessions") {
      readBody(req).then((body) => {
        let owner: string | undefined;
        let ttl = cfg.sessionTtlSeconds;
        try {
          const p = JSON.parse(body || "{}") as { owner?: string; ttl_seconds?: number };
          owner = p.owner;
          if (p.ttl_seconds) ttl = p.ttl_seconds;
        } catch {
          reply(res, 400, { error: "тело не JSON" });
          return;
        }
        if (!owner || !cfg.owners[owner]) {
          reply(res, 400, { error: `владелец ${String(owner)} неизвестен` });
          return;
        }
        const s = reg.create(owner, ttl);
        console.log(`сеанс выдан владелец=${owner} до=${s.expires.toISOString()}`);
        reply(res, 201, {
          token: s.token,
          path: `${cfg.publicPathPrefix}${s.token}/vnc.html?path=${encodeURIComponent(
            `${cfg.publicPathPrefix}${s.token}/websockify`,
          )}&autoconnect=1&resize=scale`,
          expires: s.expires.toISOString(),
        });
      }).catch(() => reply(res, 400, { error: "тело не прочитано" }));
      return;
    }
    const m = /^\/sessions\/([^/]+)$/.exec(req.url ?? "");
    if (req.method === "DELETE" && m) {
      const n = reg.revoke(decodeURIComponent(m[1]!));
      console.log(`сеанс погашен разорвано_соединений=${n}`);
      reply(res, 204, null);
      return;
    }
    reply(res, 404, { error: "нет такого ресурса" });
  });
}

export function listenOnSocket(server: http.Server, path: string, group?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  server.listen(path, () => {
    chmodSync(path, 0o660);
    if (group) {
      const gid = Number(execFileSync("getent", ["group", group], { encoding: "utf8" }).split(":")[2]);
      chownSync(path, -1, gid);
    }
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function reply(res: http.ServerResponse, code: number, body: unknown): void {
  if (body === null) { res.writeHead(code); res.end(); return; }
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
