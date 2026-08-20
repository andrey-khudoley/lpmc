import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chownSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { createPool } from "@lpmc/runtime";
import { signRunToken, type Allow } from "./token-sign.js";
import { permittedMethods, type IrreversibilityRule } from "./irreversibility.js";
import { issueSecret, loadMasterKey, open } from "./secrets.js";
import { digestOf } from "./secret-scan.js";

/**
 * Выдача учётных данных прокси на запуск.
 *
 * Зачем отдельная служба. Право создать привязку в прокси есть только у PACT:
 * административный сокет прокси доступен по группе, в которой состоит арбитр,
 * и не доступен исполнителю. Но предъявлять учётные данные браузеру должен
 * исполнитель — он супервизор запуска. Значит, нужен узкий канал между ними,
 * где арбитр проверяет лизинг и отдаёт ровно одно значение на один запуск.
 *
 * Канал — unix-сокет с правами по группе, а не порт: право обратиться сюда
 * выражается правами файла, а не знанием адреса.
 *
 * Секрет не сохраняется. В прокси он лежит хешем, здесь — не лежит вовсе:
 * хранить его значило бы завести копию, которой можно воспользоваться позже.
 * Повторный запрос выдаёт НОВЫЙ секрет и заменяет привязку — это осознанно:
 * потерявший секрет исполнитель должен получить новый, а не читать старый.
 */
const SOCKET = process.env["LPMC_LEASE_SOCKET"] ?? "/run/lpmc-pact/lease.sock";
const GROUP = process.env["LPMC_LEASE_GROUP"] ?? "lpmc-lease";
/**
 * Второй сокет — для собственных обращений служб к модели, с ДРУГОЙ группой.
 * Разделение не косметическое: право получить доступ к модели и право получить
 * доступ во внешнюю сеть от имени запуска — разные права, и у LINA есть первое,
 * но нет второго. Одна дверь на оба означала бы, что различие существует только
 * в коде, который её открывает.
 */
const MODEL_SOCKET = process.env["LPMC_MODEL_SOCKET"] ?? "/run/lpmc-pact/model.sock";
const MODEL_GROUP = process.env["LPMC_MODEL_GROUP"] ?? "lpmc-model";
const KEY = process.env["LPMC_PACT_SIGNING_KEY"] ?? "/var/lib/lpmc-system/pact/keys/pact-signing.key";
const EGRESS_ADMIN = process.env["LPMC_EGRESS_ADMIN_SOCKET"] ?? "/run/lpmc-egress/admin.sock";
const MASTER_KEY = process.env["LPMC_MASTER_KEY"] ?? "/var/lib/lpmc-system/pact/keys/master.key";

const pool = createPool();

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  const proxyPath = /^\/runs\/([0-9a-f-]{36})\/proxy$/.exec(url);
  if (req.method === "POST" && proxyPath) {
    readBody(req)
      .then((body) => issue(proxyPath[1]!, body, res))
      .catch((e: unknown) => reply(res, 500, { error: String(e) }));
    return;
  }
  // Имя принимается любое: проверку формата делает обработчик, а не маршрут.
  // Отказ на маршруте не попал бы в журнал обращений, и перебор имён секретов
  // остался бы без следа — притом что именно перебор и надо видеть.
  const secretPath = /^\/runs\/([0-9a-f-]{36})\/secrets\/([^/]{1,256})$/.exec(url);
  if (req.method === "POST" && secretPath) {
    readBody(req)
      .then((body) => giveSecret(secretPath[1]!, decodeURIComponent(secretPath[2]!), body, res))
      .catch((e: unknown) => reply(res, 500, { error: String(e) }));
    return;
  }
  reply(res, 404, { error: "нет такого ресурса" });
});

/**
 * Выдача доступа к модели.
 *
 * Служба называет себя и своё намерение; арбитр сверяет их с таблицей
 * разрешённых адресатов, создаёт привязку в прокси и отдаёт вместе с ней ключ
 * из custody. Ключ приходит именно отсюда, а не из конфигурации службы:
 * конфигурация не ведёт журнала и не отзывается.
 */
const modelServer = http.createServer((req, res) => {
  if (req.method !== "POST" || (req.url ?? "") !== "/model-access") {
    reply(res, 404, { error: "нет такого ресурса" });
    return;
  }
  readBody(req)
    .then((body) => giveModelAccess(body, res))
    .catch((e: unknown) => reply(res, 500, { error: String(e) }));
});

async function giveModelAccess(body: string, res: http.ServerResponse): Promise<void> {
  let parsed: { service?: string; purpose?: string };
  try {
    parsed = JSON.parse(body || "{}") as { service?: string; purpose?: string };
  } catch {
    reply(res, 400, { error: "тело не JSON" });
    return;
  }
  const service = parsed.service ?? "";
  const logAccess = async (host: string | null, outcome: string, reason: string,
    expires: Date | null): Promise<void> => {
    await pool.query(
      `INSERT INTO model_access_log (service, host, outcome, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5)`, [service || "неизвестная", host, outcome, reason, expires]);
  };
  if (!/^[a-z]{2,16}$/.test(service)) {
    await logAccess(null, "DENIED", "model.invalid_service", null);
    reply(res, 400, { error: "model.invalid_service" });
    return;
  }

  const r = await pool.query<{ host: string; methods: string[]; secret_name: string; ttl_seconds: number }>(
    `SELECT host, methods, secret_name, ttl_seconds FROM model_endpoints
      WHERE ruleset_version = (SELECT max(ruleset_version) FROM model_endpoints)
        AND service = $1`, [service]);
  if (r.rowCount === 0) {
    // Пустая таблица и отсутствие строки — одно и то же: обращаться некуда.
    await logAccess(null, "DENIED", "model.no_endpoint", null);
    reply(res, 403, { error: "model.no_endpoint" });
    return;
  }

  const endpoints = r.rows;
  const first = endpoints[0]!;
  const key = await issueSecret(pool, {
    name: first.secret_name, runId: null, leaseId: null,
    requestedBy: service, ownerSlug: "internal",
  }, MASTER_KEY);
  if (!key.granted) {
    // Разрешение есть, ключа нет. Привязку в этом случае не создаём: доступ
    // без ключа даёт службе выход наружу, которым она не сможет
    // воспользоваться по назначению, — но сможет иначе.
    await logAccess(first.host, "DENIED", key.reason, null);
    reply(res, 403, { error: key.reason });
    return;
  }

  const runId = randomUUID();
  const expires = new Date(Date.now() + first.ttl_seconds * 1000);
  const token = signRunToken({
    task_id: "", run_id: runId, executor: service, lease_generation: 0,
    exp: Math.floor(expires.getTime() / 1000),
    allow: endpoints.map((e) => ({ host: e.host, methods: e.methods })),
    kind: "service",
  }, KEY);
  const secret = randomBytes(24).toString("base64url");
  const created = await postBinding(token, secret, []);
  if (!created.ok) {
    await logAccess(first.host, "DENIED", `proxy.rejected:${created.text}`, null);
    reply(res, 502, { error: `прокси отклонил привязку: ${created.text}` });
    return;
  }
  await logAccess(first.host, "GRANTED", "model.access_issued", expires);
  console.log(`служба ${service}: выдан доступ к модели до ${expires.toISOString()}`);
  reply(res, 201, {
    run_id: runId, secret, proxy: process.env["LPMC_EGRESS_LISTEN"] ?? "127.0.0.1:3128",
    expires_at: expires.toISOString(),
    allow: endpoints.map((e) => ({ host: e.host, methods: e.methods })),
    api_key: key.value,
  });
}

async function issue(runId: string, body: string, res: http.ServerResponse): Promise<void> {
  let parsed: { lease_id?: string };
  try {
    parsed = JSON.parse(body || "{}") as { lease_id?: string };
  } catch {
    reply(res, 400, { error: "тело не JSON" });
    return;
  }
  if (!parsed.lease_id) {
    reply(res, 400, { error: "обязателен lease_id" });
    return;
  }

  // Лизинг проверяется по реестру, а не по словам просящего: совпадение запуска,
  // лизинга и срока — и только действующее поколение. Истёкший лизинг не
  // продлевается выдачей учётных данных.
  const r = await pool.query<{
    task_id: string; executor: string; generation: number; granted_capabilities: string[];
    expires_at: Date; owner_slug: string; state: string;
  }>(
    `SELECT l.task_id, l.executor, l.generation, l.granted_capabilities, l.expires_at,
            t.owner_slug, t.state
       FROM leases l JOIN tasks t ON t.task_id = l.task_id
      WHERE l.run_id = $1 AND l.lease_id = $2 AND l.expires_at > now()
        AND l.generation = (SELECT max(generation) FROM leases WHERE task_id = l.task_id)`,
    [runId, parsed.lease_id],
  );
  const lease = r.rows[0];
  if (!lease) {
    reply(res, 403, { error: "лизинг не найден, истёк или не действует" });
    return;
  }
  if (lease.state !== "LEASED" && lease.state !== "RUNNING") {
    reply(res, 403, { error: `задача в состоянии ${lease.state}: запуск не разрешён` });
    return;
  }

  const declared = await loadAllow(lease.owner_slug);
  // Подтверждение, выданное человеком на ЭТОТ запуск, снимает запрет
  // необратимости — но только для названного в нём хоста и типа операции.
  const approval = await approvalFor(runId);
  // Из разрешённых адресатов в токен попадают только те методы, которые
  // не являются необратимыми. Подтверждения человеком на первой волне нет,
  // поэтому необратимое не откладывается на подтверждение, а не выдаётся вовсе.
  const rules = await loadIrreversibility();
  const allow: Allow[] = [];
  for (const a of declared) {
    const approved = approval !== null && approval.host === a.host;
    const { allowed, refused } = approved
      ? { allowed: [...a.methods], refused: [] as { method: string; reason: string }[] }
      : permittedMethods(a.host, a.methods, rules,
        a.operationType as "auto" | "read" | "write" | "delete");
    if (approved) {
      console.log(`запуск ${runId}: методы на ${a.host} выданы по подтверждению ${approval.approvalId}`);
    }
    for (const r of refused) {
      console.log(`запуск ${runId}: метод ${r.method} на ${a.host} не выдан — ${r.reason}`);
    }
    if (allowed.length > 0) {
      allow.push(a.paths.length > 0
        ? { host: a.host, methods: allowed, paths: a.paths }
        : { host: a.host, methods: allowed });
    }
  }
  if (allow.length === 0) {
    // Пустой allowlist — не ошибка, а состояние политики. Привязка всё равно
    // создаётся: браузер должен получить отказ ОТ ПРОКСИ, с записью в его
    // журнале, а не остаться без учётных данных и молча упасть.
    console.log(`запуск ${runId}: allowlist владельца ${lease.owner_slug} пуст`);
  }

  // Снимки сессий разрешённых хостов передаются ПРОКСИ, а не исполнителю:
  // подстановка происходит на пути запроса, и значение не проходит через
  // память исполнителя ни разу (W2-MITA-01).
  const sessions = await loadSessions(lease.owner_slug, allow.map((a) => a.host));
  const secret = randomBytes(24).toString("base64url");
  const exp = Math.floor(lease.expires_at.getTime() / 1000);
  const token = signRunToken({
    task_id: lease.task_id,
    run_id: runId,
    executor: lease.executor,
    lease_generation: lease.generation,
    exp,
    allow,
  }, KEY);

  const created = await postBinding(token, secret, sessions.cookies);
  if (!created.ok) {
    reply(res, 502, { error: `прокси отклонил привязку: ${created.text}` });
    return;
  }

  await pool.query(
    `INSERT INTO proxy_issuances (run_id, task_id, lease_id, generation, executor, allow, expires_at,
                                  issued_to, session_hosts, blast_radius)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
    [runId, lease.task_id, parsed.lease_id, lease.generation, lease.executor,
     JSON.stringify(allow), lease.expires_at, lease.executor,
     sessions.cookies.map((c) => c.host), sessions.blastRadius],
  );
  if (sessions.blastRadius !== null) {
    console.log(`запуск ${runId}: выданы сессии (${sessions.cookies.map((c) => c.host).join(", ")}); `
      + `радиус поражения: ${sessions.blastRadius}`);
  }
  console.log(`запуск ${runId}: выданы учётные данные прокси до ${lease.expires_at.toISOString()}`);
  reply(res, 201, {
    run_id: runId,
    secret,
    proxy: process.env["LPMC_EGRESS_LISTEN"] ?? "127.0.0.1:3128",
    expires_at: lease.expires_at.toISOString(),
    allow,
  });
}

/**
 * Выдача значения секрета исполнителю по предъявлении лизинга.
 *
 * На первой волне реестр имён пуст, поэтому любой запрос заканчивается отказом.
 * Путь при этом настоящий целиком: проверка лизинга, принадлежность владельцу,
 * расшифровка, журнал обращений — не хватает только записей. Строить его позже
 * означало бы встраивать выдачу секретов в уже работающие пути.
 */
async function giveSecret(
  runId: string, name: string, body: string, res: http.ServerResponse,
): Promise<void> {
  let parsed: { lease_id?: string };
  try {
    parsed = JSON.parse(body || "{}") as { lease_id?: string };
  } catch {
    reply(res, 400, { error: "тело не JSON" });
    return;
  }
  // Имена секретов — идентификаторы, а не текст: только латиница, цифры и три
  // разделителя. Ограничение здесь, а не в маршруте, чтобы отказ был записан.
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    await pool.query(
      `INSERT INTO secret_access_log (name, run_id, lease_id, requested_by, outcome, reason)
       VALUES ($1, $2, NULL, $3, 'DENIED', 'secret.invalid_name')`,
      [name.slice(0, 128), runId, "неизвестный"]);
    reply(res, 403, { error: "secret.invalid_name" });
    return;
  }

  const r = await pool.query<{ executor: string; owner_slug: string; lease_id: string }>(
    `SELECT l.executor, t.owner_slug, l.lease_id
       FROM leases l JOIN tasks t ON t.task_id = l.task_id
      WHERE l.run_id = $1 AND l.lease_id = $2 AND l.expires_at > now()`,
    [runId, parsed.lease_id ?? ""]);
  const lease = r.rows[0];
  if (!lease) {
    // Отказ по лизингу тоже попадает в журнал: иначе перебор имён секретов
    // без действующего лизинга не оставлял бы следа.
    await pool.query(
      `INSERT INTO secret_access_log (name, run_id, lease_id, requested_by, outcome, reason)
       VALUES ($1, $2, NULL, $3, 'DENIED', 'lease.invalid')`,
      [name, runId, "неизвестный"]);
    reply(res, 403, { error: "лизинг не найден или истёк" });
    return;
  }

  const outcome = await issueSecret(pool, {
    name, runId, leaseId: lease.lease_id, requestedBy: lease.executor, ownerSlug: lease.owner_slug,
  }, MASTER_KEY);
  if (!outcome.granted) {
    reply(res, 403, { error: outcome.reason });
    return;
  }

  // Выдача получает срок и попадает в набор сверки проверки исходящего
  // (W2-PACT-01, W2-PACT-02). Отозванная выдача проверяется ещё некоторое время:
  // значение, утёкшее до отзыва, не перестаёт быть опасным в момент отзыва.
  const issuanceId = randomUUID();
  const ttl = Number(process.env["LPMC_SECRET_TTL_SECONDS"] ?? 900);
  const grace = Number(process.env["LPMC_SECRET_DIGEST_GRACE_SECONDS"] ?? 86400);
  const salt = randomBytes(16).toString("base64url");
  await pool.query(
    `INSERT INTO secret_issuances (issuance_id, name, run_id, lease_id, issued_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [issuanceId, name, runId, lease.lease_id, lease.executor, ttl]);
  await pool.query(
    `INSERT INTO egress_secret_digests (salt, digest, length, issued_for, issuance_id, check_until)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [salt, digestOf(salt, outcome.value), outcome.value.length,
     `${name}@${issuanceId.slice(0, 8)}`, issuanceId, ttl + grace]);

  reply(res, 200, { name, value: outcome.value, issuance_id: issuanceId,
    expires_in_seconds: ttl });
}

/** Подтверждение, привязанное к лизингу этого запуска. */
async function approvalFor(runId: string): Promise<{ approvalId: string; host: string;
  operationType: string } | null> {
  const r = await pool.query<{ approval_id: string; host: string; operation_type: string }>(
    `SELECT a.approval_id, a.host, a.operation_type
       FROM leases l JOIN approvals a ON a.approval_id = l.approval_id
      WHERE l.run_id = $1 AND a.state = 'approved'`, [runId]);
  const row = r.rows[0];
  return row ? { approvalId: row.approval_id, host: row.host, operationType: row.operation_type } : null;
}

async function loadIrreversibility(): Promise<IrreversibilityRule[]> {
  const r = await pool.query<{
    ruleset_version: number; host: string; operation_type: string;
    classification: "reversible" | "irreversible";
  }>("SELECT ruleset_version, host, operation_type, classification FROM irreversibility");
  return r.rows.map((x) => ({
    rulesetVersion: x.ruleset_version, host: x.host,
    operationType: x.operation_type, classification: x.classification,
  }));
}

interface AllowRow { host: string; methods: string[]; paths: string[]; operationType: string }

async function loadAllow(ownerSlug: string): Promise<AllowRow[]> {
  const r = await pool.query<{ host: string; methods: string[]; path_prefixes: string[];
    operation_type: string }>(
    `SELECT host, methods, path_prefixes, operation_type FROM egress_allow
      WHERE ruleset_version = (SELECT max(ruleset_version) FROM egress_allow)
        AND (owner_slug = $1 OR owner_slug = '*')`,
    [ownerSlug],
  );
  return r.rows.map((x) => ({ host: x.host, methods: x.methods,
    paths: x.path_prefixes, operationType: x.operation_type }));
}

/**
 * Снимки сессий для хостов запуска.
 *
 * Неотфильтрованный снимок допускается (P2-DEC-02), но его расширенный радиус
 * поражения возвращается вместе с ним и записывается в журнал выдачи: решение
 * работать с таким сервисом принято осознанно, и след этого решения обязан
 * оставаться на каждой выдаче, а не только в документе.
 */
async function loadSessions(ownerSlug: string, hosts: string[]): Promise<{
  cookies: { host: string; value: string }[]; blastRadius: string | null;
}> {
  if (hosts.length === 0) return { cookies: [], blastRadius: null };
  const r = await pool.query<{
    host: string; domain_filtered: boolean; blast_radius: string;
    wrapped_key: Buffer; wrapped_key_iv: Buffer; wrapped_key_tag: Buffer;
    ciphertext: Buffer; iv: Buffer; tag: Buffer;
  }>(
    `SELECT host, domain_filtered, blast_radius, wrapped_key, wrapped_key_iv, wrapped_key_tag,
            ciphertext, iv, tag
       FROM session_snapshots
      WHERE owner_slug = $1 AND host = ANY($2) AND revoked_at IS NULL`,
    [ownerSlug, hosts]);
  const master = loadMasterKey(MASTER_KEY);
  const cookies: { host: string; value: string }[] = [];
  const wide: string[] = [];
  for (const row of r.rows) {
    cookies.push({ host: row.host, value: open({
      wrappedKey: row.wrapped_key, wrappedKeyIv: row.wrapped_key_iv,
      wrappedKeyTag: row.wrapped_key_tag, ciphertext: row.ciphertext, iv: row.iv, tag: row.tag,
    }, master) });
    if (!row.domain_filtered) wide.push(`${row.host}: ${row.blast_radius}`);
  }
  return { cookies, blastRadius: wide.length > 0 ? wide.join("; ") : null };
}

function postBinding(
  token: string, secret: string, cookies: { host: string; value: string }[],
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token, secret, cookies });
    const req = http.request(
      { socketPath: EGRESS_ADMIN, path: "/bindings", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          ok: (res.statusCode ?? 0) < 300,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", (e) => resolve({ ok: false, text: e.message }));
    req.end(body);
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function reply(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function listenOn(srv: http.Server, path: string, group: string, what: string): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  srv.listen(path, () => {
    // Права выставляются сразу после привязки: до этого файла не существует.
    chmodSync(path, 0o660);
    const gid = Number(execFileSync("getent", ["group", group], { encoding: "utf8" }).split(":")[2]);
    chownSync(path, -1, gid);
    console.log(`${what} слушает ${path}, группа ${group}`);
  });
}

listenOn(server, SOCKET, GROUP, "выдача учётных данных запуска");
listenOn(modelServer, MODEL_SOCKET, MODEL_GROUP, "выдача доступа к модели");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`получен ${sig}: останавливаемся`);
    server.close();
    modelServer.close(() => { void pool.end().then(() => process.exit(0)); });
  });
}
