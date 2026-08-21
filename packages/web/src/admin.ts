import type pg from "pg";

/**
 * Админ-данные веб-интерфейса — чтение РЕАЛЬНЫХ таблиц политики и custody из
 * схемы pact (по отдельно выданным правам SELECT) и безопасные добавления строк
 * политики (egress_allow / rules / irreversibility). Значения секретов и сессий
 * не читаются и не пишутся: мастер-ключ на веб-сервис намеренно не выносится —
 * их вносит оператор консолью lpmc-admin.
 */

export async function owners(pool: pg.Pool): Promise<unknown> {
  const o = await pool.query(
    `SELECT slug, category, (archived_at IS NOT NULL) AS archived,
            to_char(archived_at,'DD.MM.YYYY') AS archived_on
       FROM pact.owners ORDER BY (archived_at IS NOT NULL), slug`);
  const b = await pool.query(
    "SELECT sender, coalesce(reply_route_id,'*') AS route, owner_slug FROM pact.owner_bindings ORDER BY sender");
  return { owners: o.rows, bindings: b.rows };
}

export async function services(pool: pg.Pool): Promise<unknown> {
  const allow = await pool.query(
    `SELECT id, owner_slug AS owner, host, methods, path_prefixes AS paths, operation_type AS op, ruleset_version AS version
       FROM pact.egress_allow ORDER BY owner_slug, host`);
  const irr = await pool.query(
    `SELECT id, host, operation_type AS op, classification AS cls, ruleset_version AS version
       FROM pact.irreversibility ORDER BY host`);
  const rules = await pool.query(
    `SELECT id, sender, owner_slug AS owner, capabilities AS caps, executor AS exec,
            lease_ttl_seconds AS lease, requires_approval AS appr, ruleset_version AS version
       FROM pact.rules ORDER BY owner_slug, sender`);
  return { allow: allow.rows, irr: irr.rows, rules: rules.rows };
}

export async function secrets(pool: pg.Pool): Promise<unknown> {
  const r = await pool.query(
    "SELECT name, owner_slug AS owner, purpose, to_char(created_at,'DD.MM.YYYY') AS updated FROM pact.secret_names ORDER BY name");
  return { secrets: r.rows };
}

export async function sessions(pool: pg.Pool): Promise<unknown> {
  const r = await pool.query(
    `SELECT owner_slug AS owner, host, domain_filtered AS filtered, blast_radius AS blast,
            (revoked_at IS NOT NULL) AS revoked FROM pact.session_snapshots ORDER BY owner_slug, host`);
  return { sessions: r.rows };
}

export async function approvals(pool: pg.Pool): Promise<unknown> {
  try {
    const r = await pool.query(
      `SELECT approval_id AS id, host, operation_type AS op, state,
              to_char(created_at,'DD.MM HH24:MI') AS created FROM pact.approvals ORDER BY created_at DESC LIMIT 50`);
    return { approvals: r.rows };
  } catch { return { approvals: [] }; }
}

async function maxVersion(pool: pg.Pool, table: string): Promise<number> {
  const r = await pool.query<{ v: number }>(`SELECT COALESCE(MAX(ruleset_version),1) AS v FROM pact.${table}`);
  return r.rows[0]!.v;
}

export async function addAllow(pool: pg.Pool, a: {
  owner: string; host: string; methods: string[]; paths: string[]; op: string;
}): Promise<void> {
  const v = await maxVersion(pool, "egress_allow");
  await pool.query(
    `INSERT INTO pact.egress_allow (ruleset_version, owner_slug, host, methods, path_prefixes, operation_type)
     VALUES ($1,$2,$3,$4,$5,$6)`, [v, a.owner, a.host, a.methods, a.paths, a.op]);
}

export async function addRule(pool: pg.Pool, r: {
  sender: string; owner: string; caps: string[]; exec: string; lease: number; appr: boolean;
}): Promise<void> {
  const v = await maxVersion(pool, "rules");
  await pool.query(
    `INSERT INTO pact.rules (ruleset_version, sender, owner_slug, capabilities, executor, lease_ttl_seconds, requires_approval)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [v, r.sender, r.owner, r.caps, r.exec, r.lease, r.appr]);
}

export async function addIrr(pool: pg.Pool, i: { host: string; op: string; cls: string }): Promise<void> {
  const v = await maxVersion(pool, "irreversibility");
  await pool.query(
    `INSERT INTO pact.irreversibility (ruleset_version, host, operation_type, classification)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (ruleset_version, host, operation_type) DO UPDATE SET classification = EXCLUDED.classification`,
    [v, i.host, i.op, i.cls]);
}

// ---- Владельцы и привязки ---------------------------------------------------
//
// Три операции жизненного цикла (архив, возврат, удаление) идут через функции
// SECURITY DEFINER схемы pact: веб-роли намеренно не выдан DELETE на журналах
// (verdicts, leases, approvals) — она получает только право вызова. Тела функций
// и обоснование — pact/migrations/015_owner_lifecycle.sql.

type OwnerOpResult = { ok: boolean; reason?: string; revoked?: unknown; deleted?: unknown; tasks_restored?: number };

/** Заведение владельца. Повторное заведение архивного слага возвращает его из архива. */
export async function addOwner(pool: pg.Pool, slug: string, category: string): Promise<void> {
  const cat = ["client", "project", "internal"].includes(category) ? category : "client";
  await inTx(pool, async (c) => {
    await c.query(
      `INSERT INTO pact.owners (slug, category) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET category = EXCLUDED.category`, [slug, cat]);
    await c.query("SELECT pact.web_unarchive_owner($1)", [slug]);
    await c.query("UPDATE web_tasks SET archived_at = NULL WHERE owner = $1 AND archived_at IS NOT NULL", [slug]);
  });
}

/**
 * Обе схемы правятся ОДНОЙ транзакцией на ОДНОМ соединении: задача веб-интерфейса
 * и задача арбитра описывают одно и то же, и промежуточное состояние, где скрыта
 * только одна сторона, недопустимо. Вызванная внутри BEGIN функция SECURITY
 * DEFINER участвует в этой же транзакции, а не открывает свою.
 */
async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

/** Архив: скрыть владельца и его задачи, отозвать правила, привязки, секреты и сессии. */
export async function archiveOwner(pool: pg.Pool, slug: string): Promise<OwnerOpResult> {
  try {
    return await inTx(pool, async (c) => {
      const pact = await c.query<{ r: OwnerOpResult }>("SELECT pact.web_archive_owner($1) AS r", [slug]);
      const r = pact.rows[0]!.r;
      if (!r.ok) return r;
      const web = await c.query(
        "UPDATE web_tasks SET archived_at = now() WHERE owner = $1 AND archived_at IS NULL", [slug]);
      return { ...r, revoked: { ...(r.revoked as object), web_tasks_hidden: web.rowCount ?? 0 } };
    });
  } catch (e) {
    return { ok: false, reason: "архивирование не выполнено: " + (e instanceof Error ? e.message : String(e)) };
  }
}

/** Возврат из архива. Отозванное не восстанавливается — правила и секреты заводятся заново. */
export async function unarchiveOwner(pool: pg.Pool, slug: string): Promise<OwnerOpResult> {
  try {
    return await inTx(pool, async (c) => {
      const pact = await c.query<{ r: OwnerOpResult }>("SELECT pact.web_unarchive_owner($1) AS r", [slug]);
      const r = pact.rows[0]!.r;
      if (!r.ok) return r;
      await c.query("UPDATE web_tasks SET archived_at = NULL WHERE owner = $1 AND archived_at IS NOT NULL", [slug]);
      return r;
    });
  } catch (e) {
    return { ok: false, reason: "возврат из архива не выполнен: " + (e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Полное удаление владельца — вместе с задачами и аудитом (вердикты, лизинги,
 * подтверждения, решения о выдаче). Операция раздела администрирования,
 * необратимая: восстановить основание выданных прав после неё будет нечем.
 */
export async function purgeOwner(pool: pg.Pool, slug: string): Promise<OwnerOpResult> {
  try {
    return await inTx(pool, async (c) => {
      const pact = await c.query<{ r: OwnerOpResult }>("SELECT pact.web_purge_owner($1) AS r", [slug]);
      const r = pact.rows[0]!.r;
      if (!r.ok) return r;
      const web = await c.query("DELETE FROM web_tasks WHERE owner = $1", [slug]);
      return { ...r, deleted: { ...(r.deleted as object), web_tasks: web.rowCount ?? 0 } };
    });
  } catch (e) {
    return { ok: false, reason: "удаление не выполнено: " + (e instanceof Error ? e.message : String(e)) };
  }
}
export async function addBinding(pool: pg.Pool, sender: string, owner: string, route: string): Promise<void> {
  await pool.query(
    `INSERT INTO pact.owner_bindings (sender, reply_route_id, owner_slug) VALUES ($1, $2, $3)
     ON CONFLICT (sender, coalesce(reply_route_id, '')) DO UPDATE SET owner_slug = EXCLUDED.owner_slug`,
    [sender, route === "" ? null : route, owner]);
}

// ---- Удаление строк политики и имён секретов -------------------------------
export async function delAllow(pool: pg.Pool, id: number): Promise<void> {
  await pool.query("DELETE FROM pact.egress_allow WHERE id = $1", [id]);
}
export async function delRule(pool: pg.Pool, id: number): Promise<void> {
  await pool.query("DELETE FROM pact.rules WHERE id = $1", [id]);
}
/** Правка правила на месте (в т.ч. набора capabilities). Версию набора не трогаем:
 *  это операторская корректировка действующей строки, а не новый набор правил. */
export async function updateRule(pool: pg.Pool, id: number, r: {
  sender: string; owner: string; caps: string[]; exec: string; lease: number; appr: boolean;
}): Promise<void> {
  await pool.query(
    `UPDATE pact.rules SET sender = $2, owner_slug = $3, capabilities = $4,
       executor = $5, lease_ttl_seconds = $6, requires_approval = $7 WHERE id = $1`,
    [id, r.sender, r.owner, r.caps, r.exec, r.lease, r.appr]);
}
export async function delIrr(pool: pg.Pool, id: number): Promise<void> {
  await pool.query("DELETE FROM pact.irreversibility WHERE id = $1", [id]);
}
// Удаление ИМЕНИ секрета (и значения по каскаду). Мастер-ключ не нужен.
export async function delSecret(pool: pg.Pool, name: string): Promise<void> {
  await pool.query("DELETE FROM pact.secret_names WHERE name = $1", [name]);
}
