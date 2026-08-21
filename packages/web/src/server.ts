import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "@lpmc/runtime";
import * as store from "./store.js";
import * as admin from "./admin.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "..", "..", "public");
const [HOST, PORT] = (process.env["LPMC_WEB_LISTEN"] ?? "127.0.0.1:6200").split(":") as [string, string];
const pool = createPool();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
};

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const t = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(t);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  if (s.trim() === "") return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

async function serveStatic(res: http.ServerResponse, path: string): Promise<void> {
  // Только файлы из PUBLIC; путь нормализуется, выход за пределы запрещён.
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA-фолбэк: неизвестный путь → index.html.
    try {
      const idx = await readFile(join(PUBLIC, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"]! }); res.end(idx);
    } catch { res.writeHead(404); res.end("not found"); }
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x !== "") : []);

async function api(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
  const m = req.method ?? "GET";
  const body = m === "GET" ? {} : await readBody(req);
  const seg = path.split("/").filter(Boolean); // ["api", ...]

  // ---- Задачи и диалоги ----
  if (path === "/api/tasks" && m === "GET") return json(res, 200, { tasks: await store.listTasks(pool) });
  if (path === "/api/tasks" && m === "POST") {
    const title = str(body["title"]).trim() || "Новая задача";
    const owner = str(body["owner"]).trim() || "internal";
    const t = await store.createTask(pool, title, owner);
    return json(res, 201, await store.getTaskFull(pool, t.id));
  }
  if (seg[0] === "api" && seg[1] === "tasks" && seg[2]) {
    const id = seg[2];
    const action = seg[3];
    if (!action && m === "GET") { const t = await store.getTaskFull(pool, id); return t ? json(res, 200, t) : json(res, 404, { error: "нет задачи" }); }
    if (!action && m === "DELETE") return json(res, 200, await store.deleteTask(pool, id));
    if (!action && m === "PATCH") {
      const patch: import("./lina.js").Patch = {};
      for (const k of ["title", "owner", "status", "prio", "due_date", "dod"] as const) {
        if (typeof body[k] === "string") patch[k] = body[k] as string;
      }
      return json(res, 200, await store.patchTask(pool, id, patch) ?? { error: "нет задачи" });
    }
    if (action === "message" && m === "POST") { const r = await store.postMessage(pool, id, str(body["text"])); return r ? json(res, 200, r) : json(res, 404, { error: "нет задачи" }); }
    if (action === "comment" && m === "POST") return json(res, 200, await store.addComment(pool, id, str(body["author"]) || "оператор", str(body["text"])) ?? { error: "нет задачи" });
    if (action === "handover" && m === "POST") { const r = await store.handover(pool, id); return json(res, r.ok ? 200 : 409, r); }
    if (action === "result-decision" && m === "POST") return json(res, 200, await store.reviewDecision(pool, id, str(body["decision"]) || "accepted", str(body["note"])));
    if (action === "move" && m === "POST") return json(res, 200, await store.moveTask(pool, id, Number(body["dir"] ?? 1)) ?? { error: "нет задачи" });
  }

  // ---- Общий диалог Лины («входящие») ----
  if (path === "/api/lina/inbox" && m === "GET") return json(res, 200, await store.getInbox(pool));
  if (path === "/api/lina/inbox" && m === "POST") return json(res, 200, await store.inboxMessage(pool, str(body["text"])));

  // ---- Инструкции Лины: типы задач ----
  if (path === "/api/tasktypes" && m === "GET") return json(res, 200, await store.listTaskTypes(pool));
  if (path === "/api/tasktypes" && m === "POST") { await store.addTaskType(pool, { name: str(body["name"]), keywords: str(body["keywords"]), executor: str(body["executor"]), clarify: str(body["clarify"]), dod_template: str(body["dod_template"]) }); return json(res, 201, { ok: true }); }
  if (seg[0] === "api" && seg[1] === "tasktypes" && seg[2] && m === "POST") { await store.updateTaskType(pool, Number(seg[2]), { name: str(body["name"]), keywords: str(body["keywords"]), executor: str(body["executor"]), clarify: str(body["clarify"]), dod_template: str(body["dod_template"]) }); return json(res, 200, { ok: true }); }
  if (seg[0] === "api" && seg[1] === "tasktypes" && seg[2] && m === "DELETE") { await store.delTaskType(pool, Number(seg[2])); return json(res, 200, { ok: true }); }

  // ---- Админ ----
  if (path === "/api/admin/owners" && m === "GET") return json(res, 200, await admin.owners(pool));
  if (path === "/api/admin/services" && m === "GET") return json(res, 200, await admin.services(pool));
  if (path === "/api/admin/secrets" && m === "GET") return json(res, 200, await admin.secrets(pool));
  if (path === "/api/admin/sessions" && m === "GET") return json(res, 200, await admin.sessions(pool));
  if (path === "/api/admin/approvals" && m === "GET") return json(res, 200, await admin.approvals(pool));
  if (path === "/api/admin/allow" && m === "POST") { await admin.addAllow(pool, { owner: str(body["owner"]) || "*", host: str(body["host"]), methods: arr(body["methods"]), paths: arr(body["paths"]), op: str(body["op"]) || "auto" }); return json(res, 201, { ok: true }); }
  if (path === "/api/admin/rule" && m === "POST") { await admin.addRule(pool, { sender: str(body["sender"]), owner: str(body["owner"]), caps: arr(body["caps"]), exec: str(body["exec"]) || "mita", lease: Number(body["lease"] ?? 1800), appr: Boolean(body["appr"]) }); return json(res, 201, { ok: true }); }
  if (seg[0] === "api" && seg[1] === "admin" && seg[2] === "rule" && seg[3] && m === "POST") { await admin.updateRule(pool, Number(seg[3]), { sender: str(body["sender"]), owner: str(body["owner"]), caps: arr(body["caps"]), exec: str(body["exec"]) || "mita", lease: Number(body["lease"] ?? 1800), appr: Boolean(body["appr"]) }); return json(res, 200, { ok: true }); }
  if (path === "/api/admin/irr" && m === "POST") { await admin.addIrr(pool, { host: str(body["host"]), op: str(body["op"]) || "write", cls: str(body["cls"]) || "irreversible" }); return json(res, 201, { ok: true }); }
  if (path === "/api/admin/owner" && m === "POST") { await admin.addOwner(pool, str(body["slug"]), str(body["category"]) || "client"); return json(res, 201, { ok: true }); }
  if (path === "/api/admin/binding" && m === "POST") { await admin.addBinding(pool, str(body["sender"]), str(body["owner"]), str(body["route"])); return json(res, 201, { ok: true }); }
  if (path === "/api/admin/owner-archive" && m === "POST") return json(res, 200, await admin.archiveOwner(pool, str(body["slug"])));
  if (path === "/api/admin/owner-unarchive" && m === "POST") return json(res, 200, await admin.unarchiveOwner(pool, str(body["slug"])));
  if (seg[0] === "api" && seg[1] === "admin" && seg[3] && m === "DELETE") {
    const kind = seg[2]; const key = decodeURIComponent(seg[3]);
    // Удаление владельца стирает и его аудит — см. admin.purgeOwner и D-042.
    if (kind === "owner") return json(res, 200, await admin.purgeOwner(pool, key));
    if (kind === "secret") { await admin.delSecret(pool, key); return json(res, 200, { ok: true }); }
    if (kind === "allow") { await admin.delAllow(pool, Number(key)); return json(res, 200, { ok: true }); }
    if (kind === "rule") { await admin.delRule(pool, Number(key)); return json(res, 200, { ok: true }); }
    if (kind === "irr") { await admin.delIrr(pool, Number(key)); return json(res, 200, { ok: true }); }
  }

  json(res, 404, { error: "нет такого метода" });
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  const p = url.startsWith("/api/") || url === "/api" ? url : url;
  (p.startsWith("/api") ? api(req, res, p) : serveStatic(res, p))
    .catch((e: unknown) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
});

server.listen(Number(PORT), HOST, () => console.log(`lpmc-web слушает ${HOST}:${PORT}, статика из ${PUBLIC}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { server.close(); void pool.end().then(() => process.exit(0)); });
