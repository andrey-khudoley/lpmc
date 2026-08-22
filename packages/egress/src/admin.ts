import { createHash } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { Registry } from "./bindings.js";
import { verifyToken } from "./token.js";

/**
 * Административный интерфейс живёт на unix-сокете, а не на порту: право создавать
 * привязки выражается правами файла. Сокет принадлежит пользователю прокси, группа —
 * пользователь PACT, режим 0660. Ни исполнитель, ни браузер обратиться к нему
 * не могут — а это единственный способ получить доступ во внешнюю сеть.
 */
export function createAdminServer(reg: Registry, pactPublicKey: Buffer,
  policy?: { apply(list: { host: string; methods: string[]; paths?: string[] }[]): { hosts: number } }): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? "";
    // Публикация политики узла арбитром. Право на неё выражено правами сокета
    // (группа админ-сокета — пользователь PACT), тем же способом, что и право
    // создавать привязки: исполнитель и браузер сюда не достучатся.
    if (req.method === "PUT" && url === "/policy") {
      if (!policy) { reply(res, 501, "501 публикация политики не включена"); return; }
      readBody(req)
        .then((body) => {
          let parsed: { allow?: { host: string; methods: string[]; paths?: string[] }[] };
          try { parsed = JSON.parse(body) as typeof parsed; } catch { reply(res, 400, "400 тело не JSON"); return; }
          if (!Array.isArray(parsed.allow)) { reply(res, 400, "400 обязателен allow"); return; }
          const r = policy.apply(parsed.allow);
          console.log(`политика узла опубликована: хостов сверх базовых ${r.hosts}`);
          reply(res, 200, JSON.stringify(r));
        })
        .catch(() => reply(res, 400, "400 тело не прочитано"));
      return;
    }
    if (req.method === "POST" && url === "/bindings") {
      readBody(req)
        .then((body) => createBinding(reg, pactPublicKey, body, res))
        .catch(() => reply(res, 400, "400 тело не прочитано"));
      return;
    }
    const m = /^\/bindings\/([^/]+)$/.exec(url);
    if (req.method === "DELETE" && m) {
      const runId = decodeURIComponent(m[1]!);
      const n = reg.revoke(runId);
      console.log(`привязка отозвана run=${runId} разорвано_соединений=${n}`);
      reply(res, 204, "");
      return;
    }
    reply(res, 404, "404 нет такого ресурса");
  });
}

function createBinding(reg: Registry, pub: Buffer, body: string, res: http.ServerResponse): void {
  let parsed: { token?: string; secret?: string; cookies?: { host: string; value: string }[] };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    reply(res, 400, "400 тело не JSON");
    return;
  }
  if (!parsed.secret) {
    reply(res, 400, "400 обязателен secret");
    return;
  }
  let t;
  try {
    // Токен, подписанный PACT (D-019), предъявляется супервизором запуска один раз,
    // при создании привязки; дальше прокси проверяет каждый запрос локально и к PACT
    // не обращается — иначе каждый внешний вызов упирался бы в доступность арбитра.
    t = verifyToken(parsed.token ?? "", pub, new Date());
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    console.log(`привязка отклонена: ${text}`);
    reply(res, 403, `403 ${text}`);
    return;
  }
  reg.put(
    reg.makeBinding({
      runId: t.run_id,
      taskId: t.task_id,
      executor: t.executor,
      generation: t.lease_generation,
      secretHash: createHash("sha256").update(parsed.secret).digest(),
      cookies: Object.fromEntries((parsed.cookies ?? []).map((c) => [c.host.toLowerCase(), c.value])),
      allow: t.allow,
      expires: new Date(t.exp * 1000),
    }),
  );
  console.log(
    `привязка создана вид=${t.kind} run=${t.run_id} task=${t.task_id || "-"} ` +
      `принципал=${t.executor} поколение=${t.lease_generation} ` +
      `до=${new Date(t.exp * 1000).toISOString()}`,
  );
  reply(res, 201, "");
}

export function listenOnSocket(server: http.Server, path: string, group: string | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  server.listen(path, () => {
    // Права выставляются сразу после привязки сокета: до этого файла не существует.
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

function reply(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
