import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type pg from "pg";
import { createPool } from "@lpmc/runtime";
import { seal, loadMasterKey, isLegalHeaderValue } from "@lpmc/pact";
import { EXECUTORS, isMember } from "@lpmc/contracts";

/**
 * lpmc-admin — операторская консоль расширения системы.
 *
 * ЭТО ПРИВИЛЕГИРОВАННЫЙ ИНСТРУМЕНТ. Он пишет таблицы политики PACT (владельцы,
 * привязки, правила, allowlist, необратимость) и custody (секреты, сессии),
 * поэтому запускается под пользователем арбитра (lpmc-pact), у которого есть
 * схема PACT и мастер-ключ. Недоверенный диалоговый интерфейс (lpmc-tui) сюда
 * доступа не имеет и иметь не должен: полномочия выдаёт оператор, а не контур,
 * читающий внешний ввод.
 *
 * Ничего не «понимает» и не решает за человека: значения приходят от оператора,
 * проверяются на форму и кладутся в таблицы. Это тот же путь, что у put-secret и
 * put-session, только пошаговый и над всеми таблицами расширения сразу.
 */

const MASTER_KEY = process.env["LPMC_MASTER_KEY"] ?? "/var/lib/lpmc-system/pact/keys/master.key";
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type RL = ReturnType<typeof createInterface>;
type Opts = { def?: string; validate?: (v: string) => string | null };

async function ask(rl: RL, question: string, opts: Opts = {}): Promise<string> {
  for (;;) {
    const suffix = opts.def !== undefined ? ` [${opts.def}]` : "";
    const raw = (await rl.question(`${question}${suffix}: `)).trim();
    const v = raw === "" && opts.def !== undefined ? opts.def : raw;
    if (opts.validate) {
      const err = opts.validate(v);
      if (err) { console.log(`  ✗ ${err}`); continue; }
    }
    return v;
  }
}

async function menu(rl: RL, title: string, options: { key: string; label: string }[]): Promise<string> {
  console.log(`\n${title}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  for (;;) {
    const n = Number((await rl.question("Выбор: ")).trim());
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.key;
    console.log("  ✗ введите номер из списка");
  }
}

async function yesno(rl: RL, question: string, def = false): Promise<boolean> {
  const v = (await ask(rl, `${question} (да/нет)`, { def: def ? "да" : "нет" })).toLowerCase();
  return v === "да" || v === "д" || v === "yes" || v === "y";
}

// Валидаторы формы (закрытые перечни и синтаксис — из решений D-017/D-018).
const vSlug = (v: string): string | null =>
  /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "слаг: строчная латиница/цифры/дефис";
const vHost = (v: string): string | null =>
  /^[a-z0-9.-]+$/.test(v) ? null : "хост: латиница, цифры, точки, дефис";
const vCap = (v: string): string | null =>
  /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(v) ? null : "capability вида <объект>.<действие>, строчная латиница";
const vSecretName = (v: string): string | null =>
  /^[A-Za-z0-9_.-]{1,128}$/.test(v) ? null : "имя: латиница/цифры/._- (до 128 символов)";
const vNonEmpty = (v: string): string | null => (v !== "" ? null : "пустое значение не принимается");
const vSender = (v: string): string | null =>
  /^[a-z0-9]+:\S+$/.test(v) ? null : "вид «канал:идентификатор», например cli:operator";
const vPosInt = (v: string): string | null =>
  Number.isInteger(Number(v)) && Number(v) > 0 ? null : "целое число больше нуля";

async function currentVersion(pool: pg.Pool, table: string): Promise<number> {
  // table — фиксированный литерал из кода, не пользовательский ввод.
  const r = await pool.query<{ v: number }>(`SELECT COALESCE(MAX(ruleset_version), 1) AS v FROM ${table}`);
  return r.rows[0]!.v;
}

async function pickOwner(rl: RL, pool: pg.Pool, allowAny = false): Promise<string | null> {
  const r = await pool.query<{ slug: string; category: string }>(
    "SELECT slug, category FROM owners ORDER BY slug");
  if (r.rows.length === 0 && !allowAny) {
    console.log("  (владельцев ещё нет — сначала добавьте в разделе «Клиенты»)");
    return null;
  }
  r.rows.forEach((o, i) => console.log(`  ${i + 1}) ${o.slug} (${o.category})`));
  if (allowAny) console.log("  *) любой владелец");
  const v = await ask(rl, "Владелец (номер или слаг)", { validate: vNonEmpty });
  if (allowAny && v === "*") return "*";
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= r.rows.length) return r.rows[n - 1]!.slug;
  return v;
}

function csv(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

// ---- Клиенты (владельцы и привязки) ----------------------------------------
async function clients(rl: RL, pool: pg.Pool): Promise<void> {
  for (;;) {
    const a = await menu(rl, "Клиенты", [
      { key: "list", label: "Показать владельцев и привязки" },
      { key: "owner", label: "Добавить владельца" },
      { key: "bind", label: "Добавить привязку отправитель → владелец" },
      { key: "back", label: "Назад" },
    ]);
    if (a === "back") return;
    if (a === "list") {
      const o = await pool.query<{ slug: string; category: string }>(
        "SELECT slug, category FROM owners ORDER BY slug");
      console.log("\nВладельцы:");
      if (o.rows.length === 0) console.log("  (нет)");
      o.rows.forEach((r) => console.log(`  • ${r.slug} (${r.category})`));
      const b = await pool.query<{ sender: string; route: string; owner_slug: string }>(
        "SELECT sender, coalesce(reply_route_id, '*') AS route, owner_slug FROM owner_bindings ORDER BY sender");
      console.log("Привязки (отправитель + маршрут → владелец):");
      if (b.rows.length === 0) console.log("  (нет)");
      b.rows.forEach((r) => console.log(`  • ${r.sender}  [${r.route}]  →  ${r.owner_slug}`));
    } else if (a === "owner") {
      const slug = await ask(rl, "Слаг владельца", { validate: vSlug });
      const category = await menu(rl, "Категория владельца", [
        { key: "client", label: "client — клиент" },
        { key: "project", label: "project — проект" },
        { key: "internal", label: "internal — внутренний контур" },
      ]);
      await pool.query(
        `INSERT INTO owners (slug, category) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET category = EXCLUDED.category`, [slug, category]);
      console.log(`  ✓ владелец ${slug} (${category})`);
    } else if (a === "bind") {
      const sender = await ask(rl, "Отправитель (канал:идентификатор)", { validate: vSender });
      const owner = await pickOwner(rl, pool);
      if (owner === null) continue;
      const route = await ask(rl, "Маршрут ответа (пусто = любой маршрут этого отправителя)", { def: "" });
      await pool.query(
        `INSERT INTO owner_bindings (sender, reply_route_id, owner_slug) VALUES ($1, $2, $3)
         ON CONFLICT (sender, coalesce(reply_route_id, '')) DO UPDATE SET owner_slug = EXCLUDED.owner_slug`,
        [sender, route === "" ? null : route, owner]);
      console.log(`  ✓ ${sender} [${route === "" ? "*" : route}] → ${owner}`);
    }
  }
}

// ---- Сервисы (allowlist и необратимость) -----------------------------------
async function services(rl: RL, pool: pg.Pool): Promise<void> {
  for (;;) {
    const a = await menu(rl, "Сервисы (внешние хосты)", [
      { key: "list", label: "Показать allowlist и необратимость" },
      { key: "allow", label: "Добавить разрешённый эндпоинт (хост, методы, пути)" },
      { key: "irr", label: "Задать необратимость операции" },
      { key: "back", label: "Назад" },
    ]);
    if (a === "back") return;
    if (a === "list") {
      const e = await pool.query<{ owner_slug: string; host: string; methods: string[];
        path_prefixes: string[]; operation_type: string; ruleset_version: number }>(
        "SELECT owner_slug, host, methods, path_prefixes, operation_type, ruleset_version FROM egress_allow ORDER BY owner_slug, host");
      console.log("\nРазрешённые эндпоинты (граница узла):");
      if (e.rows.length === 0) console.log("  (нет — по умолчанию всё запрещено)");
      e.rows.forEach((r) => console.log(
        `  • [${r.owner_slug}] ${r.host} ${r.methods.join(",")}`
        + `${r.path_prefixes.length ? " пути=" + r.path_prefixes.join(",") : ""} (${r.operation_type}, v${r.ruleset_version})`));
      const i = await pool.query<{ host: string; operation_type: string; classification: string; ruleset_version: number }>(
        "SELECT host, operation_type, classification, ruleset_version FROM irreversibility ORDER BY host");
      console.log("Необратимость:");
      if (i.rows.length === 0) console.log("  (нет)");
      i.rows.forEach((r) => console.log(`  • ${r.host} ${r.operation_type} → ${r.classification} (v${r.ruleset_version})`));
    } else if (a === "allow") {
      const owner = await pickOwner(rl, pool, true);
      if (owner === null) continue;
      const host = await ask(rl, "Хост", { validate: vHost });
      const methods = csv((await ask(rl, "Методы через запятую (GET,POST,…)", {
        validate: (v) => csv(v).every((m) => HTTP_METHODS.includes(m.toUpperCase()))
          ? null : `методы из набора: ${HTTP_METHODS.join(", ")}`,
      })).toUpperCase());
      const paths = csv(await ask(rl, "Префиксы путей через запятую (пусто = любой путь)", { def: "" }));
      const op = await menu(rl, "Тип операции (для классификации необратимости)", [
        { key: "auto", label: "auto — вывести по методу" },
        { key: "read", label: "read — чтение" },
        { key: "write", label: "write — запись/создание" },
        { key: "delete", label: "delete — удаление" },
      ]);
      const v = await currentVersion(pool, "egress_allow");
      await pool.query(
        `INSERT INTO egress_allow (ruleset_version, owner_slug, host, methods, path_prefixes, operation_type)
         VALUES ($1, $2, $3, $4, $5, $6)`, [v, owner, host, methods, paths, op]);
      console.log(`  ✓ [${owner}] ${host} ${methods.join(",")} (${op}, v${v})`);
    } else if (a === "irr") {
      const host = await ask(rl, "Хост", { validate: vHost });
      const op = await menu(rl, "Тип операции", [
        { key: "read", label: "read" }, { key: "write", label: "write" }, { key: "delete", label: "delete" },
      ]);
      const cls = await menu(rl, "Классификация", [
        { key: "irreversible", label: "irreversible — необратимо (по умолчанию требует approval)" },
        { key: "reversible", label: "reversible — обратимо" },
      ]);
      const v = await currentVersion(pool, "irreversibility");
      await pool.query(
        `INSERT INTO irreversibility (ruleset_version, host, operation_type, classification)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ruleset_version, host, operation_type) DO UPDATE SET classification = EXCLUDED.classification`,
        [v, host, op, cls]);
      console.log(`  ✓ ${host} ${op} → ${cls} (v${v})`);
    }
  }
}

// ---- Правила и capability --------------------------------------------------
async function rules(rl: RL, pool: pg.Pool): Promise<void> {
  for (;;) {
    const a = await menu(rl, "Правила и capability", [
      { key: "list", label: "Показать правила" },
      { key: "add", label: "Добавить правило" },
      { key: "back", label: "Назад" },
    ]);
    if (a === "back") return;
    if (a === "list") {
      const r = await pool.query<{ sender: string; owner_slug: string; capabilities: string[];
        executor: string; lease_ttl_seconds: number; requires_approval: boolean; ruleset_version: number }>(
        "SELECT sender, owner_slug, capabilities, executor, lease_ttl_seconds, requires_approval, ruleset_version FROM rules ORDER BY owner_slug, sender");
      console.log("\nПравила (отправитель + владелец → полномочия):");
      if (r.rows.length === 0) console.log("  (нет — по умолчанию отказ)");
      r.rows.forEach((x) => console.log(
        `  • [${x.sender} → ${x.owner_slug}] ${x.capabilities.join(",")} | ${x.executor}`
        + ` | лизинг ${x.lease_ttl_seconds}s | approval=${x.requires_approval ? "да" : "нет"} (v${x.ruleset_version})`));
    } else if (a === "add") {
      const sender = await ask(rl, "Отправитель (канал:идентификатор)", { validate: vSender });
      const owner = await pickOwner(rl, pool);
      if (owner === null) continue;
      const caps = csv(await ask(rl, "Capabilities через запятую (объект.действие)", {
        validate: (v) => { const c = csv(v); return c.length && c.every((x) => vCap(x) === null) ? null : "каждая — вида объект.действие, строчная латиница"; },
      }));
      const executor = await menu(rl, "Исполнитель", EXECUTORS.map((e) => ({ key: e, label: e })));
      if (!isMember(EXECUTORS, executor)) { console.log("  ✗ неизвестный исполнитель"); continue; }
      const ttl = Number(await ask(rl, "Лизинг, секунд", { def: "1800", validate: vPosInt }));
      const approval = await yesno(rl, "Требовать approval", false);
      const v = await currentVersion(pool, "rules");
      await pool.query(
        `INSERT INTO rules (ruleset_version, sender, owner_slug, capabilities, executor, lease_ttl_seconds, requires_approval)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [v, sender, owner, caps, executor, ttl, approval]);
      console.log(`  ✓ [${sender} → ${owner}] ${caps.join(",")} | ${executor} | v${v}`);
    }
  }
}

// ---- Секреты (custody) -----------------------------------------------------
async function secrets(rl: RL, pool: pg.Pool): Promise<void> {
  for (;;) {
    const a = await menu(rl, "Секреты (custody)", [
      { key: "list", label: "Показать имена секретов (без значений)" },
      { key: "put", label: "Внести / обновить секрет" },
      { key: "del", label: "Удалить секрет" },
      { key: "back", label: "Назад" },
    ]);
    if (a === "back") return;
    if (a === "list") {
      const r = await pool.query<{ name: string; owner_slug: string; purpose: string }>(
        "SELECT name, owner_slug, purpose FROM secret_names ORDER BY name");
      console.log("\nСекреты (значения не хранятся в открытом виде и здесь не показываются):");
      if (r.rows.length === 0) console.log("  (нет)");
      r.rows.forEach((x) => console.log(`  • ${x.name} | владелец=${x.owner_slug} | ${x.purpose}`));
    } else if (a === "put") {
      const name = await ask(rl, "Имя секрета", { validate: vSecretName });
      const owner = await pickOwner(rl, pool);
      if (owner === null) continue;
      const purpose = await ask(rl, "Назначение", { def: "не указано" });
      const value = await ask(rl, "Значение секрета (видно вам на экране, но не попадает в argv/логи)", { validate: vNonEmpty });
      const sealed = seal(value, loadMasterKey(MASTER_KEY));
      await pool.query(
        `INSERT INTO secret_names (name, owner_slug, purpose) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET owner_slug = EXCLUDED.owner_slug, purpose = EXCLUDED.purpose`,
        [name, owner, purpose]);
      await pool.query(
        `INSERT INTO secret_values (name, wrapped_key, wrapped_key_iv, wrapped_key_tag, ciphertext, iv, tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (name) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key,
           wrapped_key_iv = EXCLUDED.wrapped_key_iv, wrapped_key_tag = EXCLUDED.wrapped_key_tag,
           ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()`,
        [name, sealed.wrappedKey, sealed.wrappedKeyIv, sealed.wrappedKeyTag,
         sealed.ciphertext, sealed.iv, sealed.tag]);
      console.log(`  ✓ секрет ${name} внесён для владельца ${owner}`);
    } else if (a === "del") {
      const name = await ask(rl, "Имя секрета для удаления", { validate: vSecretName });
      if (!(await yesno(rl, `Удалить секрет ${name} безвозвратно`, false))) continue;
      const r = await pool.query("DELETE FROM secret_names WHERE name = $1", [name]);
      console.log(r.rowCount ? `  ✓ секрет ${name} удалён` : "  ✗ такого имени нет");
    }
  }
}

// ---- Сессии (снимки логина) ------------------------------------------------
async function sessions(rl: RL, pool: pg.Pool): Promise<void> {
  for (;;) {
    const a = await menu(rl, "Сессии (снимки логина)", [
      { key: "list", label: "Показать снимки сессий" },
      { key: "put", label: "Внести / обновить снимок сессии" },
      { key: "revoke", label: "Отозвать снимок сессии" },
      { key: "back", label: "Назад" },
    ]);
    if (a === "back") return;
    if (a === "list") {
      const r = await pool.query<{ owner_slug: string; host: string; domain_filtered: boolean;
        blast_radius: string; revoked_at: Date | null }>(
        "SELECT owner_slug, host, domain_filtered, blast_radius, revoked_at FROM session_snapshots ORDER BY owner_slug, host");
      console.log("\nСнимки сессий (значения зашифрованы, здесь не показываются):");
      if (r.rows.length === 0) console.log("  (нет)");
      r.rows.forEach((x) => console.log(
        `  • [${x.owner_slug}] ${x.host} | фильтр по домену=${x.domain_filtered ? "да" : "нет"}`
        + ` | радиус: ${x.blast_radius}${x.revoked_at ? " | ОТОЗВАН" : ""}`));
    } else if (a === "put") {
      const owner = await pickOwner(rl, pool);
      if (owner === null) continue;
      const host = await ask(rl, "Хост", { validate: vHost });
      const filtered = await yesno(rl, "Снимок отфильтрован до одного домена", false);
      const blast = filtered ? "один домен"
        : await ask(rl, "Радиус поражения словами (снимок шире одного домена)", { validate: vNonEmpty });
      const value = await ask(rl, "Снимок сессии (значение Cookie, одной строкой)", {
        validate: (v) => vNonEmpty(v) ?? (isLegalHeaderValue(v) ? null
          : "непригодно как значение Cookie: только табуляция и печатные символы latin1, без перевода строки"),
      });
      const sealed = seal(value, loadMasterKey(MASTER_KEY));
      await pool.query(
        `INSERT INTO session_snapshots (owner_slug, host, domain_filtered, blast_radius,
           wrapped_key, wrapped_key_iv, wrapped_key_tag, ciphertext, iv, tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (owner_slug, host) DO UPDATE SET
           domain_filtered = EXCLUDED.domain_filtered, blast_radius = EXCLUDED.blast_radius,
           wrapped_key = EXCLUDED.wrapped_key, wrapped_key_iv = EXCLUDED.wrapped_key_iv,
           wrapped_key_tag = EXCLUDED.wrapped_key_tag, ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv, tag = EXCLUDED.tag, revoked_at = NULL`,
        [owner, host, filtered, blast, sealed.wrappedKey, sealed.wrappedKeyIv, sealed.wrappedKeyTag,
         sealed.ciphertext, sealed.iv, sealed.tag]);
      console.log(`  ✓ снимок сессии ${host} внесён для владельца ${owner}`);
    } else if (a === "revoke") {
      const owner = await pickOwner(rl, pool);
      if (owner === null) continue;
      const host = await ask(rl, "Хост", { validate: vHost });
      if (!(await yesno(rl, `Отозвать снимок ${host} для ${owner}`, false))) continue;
      const r = await pool.query(
        "UPDATE session_snapshots SET revoked_at = now() WHERE owner_slug = $1 AND host = $2 AND revoked_at IS NULL",
        [owner, host]);
      console.log(r.rowCount ? "  ✓ снимок отозван" : "  ✗ действующего снимка не найдено");
    }
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  const pool = createPool();
  console.log("LPMC · операторская консоль расширения");
  console.log("Пишет политику PACT и custody. Значения приходят от вас и проверяются на форму.\n");
  try {
    for (;;) {
      const a = await menu(rl, "Главное меню", [
        { key: "clients", label: "Клиенты — владельцы и привязки" },
        { key: "services", label: "Сервисы — разрешённые хосты и необратимость" },
        { key: "rules", label: "Правила и capability — что кому разрешено" },
        { key: "secrets", label: "Секреты — custody" },
        { key: "sessions", label: "Сессии — снимки логина" },
        { key: "quit", label: "Выход" },
      ]);
      if (a === "quit") break;
      if (a === "clients") await clients(rl, pool);
      else if (a === "services") await services(rl, pool);
      else if (a === "rules") await rules(rl, pool);
      else if (a === "secrets") await secrets(rl, pool);
      else if (a === "sessions") await sessions(rl, pool);
    }
  } finally {
    rl.close();
    await pool.end().catch(() => undefined);
  }
}

main().catch((e: unknown) => {
  console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
