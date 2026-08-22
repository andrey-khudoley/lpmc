import type pg from "pg";
import * as admin from "./admin.js";
import { addTaskType } from "./store.js";

/**
 * Мастер сценария: собрать работающий сценарий с нуля за один проход.
 *
 * Сценарий в LPMC — это не одна запись, а согласованный набор: владелец, обе
 * границы выхода наружу (таблица PACT и политика узла), правило с полномочиями и
 * исполнителем, при необратимых действиях — отметка необратимости, и инструкция
 * квалификации для Лины. Пропуск любого звена даёт отказ на следующем шаге, а
 * выглядит это как поломка — поэтому здесь всё заводится вместе и проверяется
 * готовность к исполнению.
 *
 * Что мастер НЕ делает и делать не должен: не вносит значения секретов (мастер-ключ
 * на веб не выносится) и не создаёт браузерные инстансы владельцев — это работа
 * развёртывания. Об отсутствии того и другого он честно сообщает в проверке.
 */

export type ScenarioKind = "browser-read" | "browser-extract" | "api-read" | "api-write";

export interface ScenarioSpec {
  kind: ScenarioKind;
  owner: string;              // существующий или новый слаг
  ownerCategory?: string;     // если владельца нужно завести
  host: string;
  methods: string[];
  paths: string[];
  sender: string;             // отправитель для правила и привязки
  lease: number;
  approval: boolean;
  typeName: string;           // название типа задачи (инструкция Лины)
  keywords: string;
  clarify: string;
  dodTemplate: string;
}

/** Полномочия и исполнитель, вытекающие из рода сценария. */
export function shapeOf(kind: ScenarioKind): { caps: string[]; exec: string; op: string; irreversible: boolean } {
  switch (kind) {
    case "browser-read": return { caps: ["page.read", "report.build"], exec: "mita", op: "read", irreversible: false };
    case "browser-extract": return { caps: ["page.read", "report.build"], exec: "mita", op: "read", irreversible: false };
    case "api-read": return { caps: ["api.read"], exec: "cita", op: "read", irreversible: false };
    case "api-write": return { caps: ["api.read", "record.create"], exec: "cita", op: "write", irreversible: true };
  }
}

export interface CheckItem { key: string; ok: boolean; label: string; detail: string; blocking: boolean }

/**
 * Проверка готовности сценария к исполнению. Разделяет то, что мешает работать
 * (blocking), и то, о чём нужно знать (например, отсутствие браузерного инстанса
 * у нового владельца — его заводит развёртывание).
 */
export async function check(pool: pg.Pool, s: Partial<ScenarioSpec>): Promise<{ items: CheckItem[]; ready: boolean }> {
  const items: CheckItem[] = [];
  const owner = (s.owner ?? "").trim();
  const host = (s.host ?? "").trim();
  const kind = (s.kind ?? "browser-read") as ScenarioKind;
  const shape = shapeOf(kind);

  const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    try { const r = await pool.query(sql, params); return r.rows as T[]; } catch { return []; }
  };

  const owners = await q<{ slug: string }>("SELECT slug FROM pact.owners WHERE archived_at IS NULL AND slug = $1", [owner]);
  items.push({ key: "owner", ok: owners.length > 0, blocking: true,
    label: "клиент заведён", detail: owners.length ? owner : "будет создан мастером" });

  const allow = await q<{ host: string }>(
    "SELECT host FROM pact.egress_allow WHERE owner_slug = $1 AND host = $2", [owner, host]);
  items.push({ key: "allow", ok: allow.length > 0, blocking: true,
    label: "хост разрешён владельцу (таблица PACT)", detail: allow.length ? host : "будет добавлен мастером" });

  // Читаем через функцию арбитра: прав на таблицу у веба нет и быть не должно.
  // Базовый перечень роли отсюда не виден — он известен только прокси, поэтому
  // для хостов из роли (например example.com) проверка честно скажет «нет
  // записи», хотя запрос пройдёт. Мастер в таком случае просто добавит запись.
  const policy = await q<{ host: string }>(
    "SELECT host FROM pact.web_policy_list() WHERE host = $1", [host]);
  items.push({ key: "node", ok: policy.length > 0, blocking: true,
    label: "хост разрешён на границе узла", detail: policy.length ? host : "будет добавлен мастером (публикует арбитр)" });

  const rules = await q<{ capabilities: string[]; executor: string }>(
    "SELECT capabilities, executor FROM pact.rules WHERE sender = $1 AND owner_slug = $2", [s.sender ?? "", owner]);
  const capsOk = rules.some((r) => shape.caps.every((c) => r.capabilities.includes(c)) && r.executor === shape.exec);
  items.push({ key: "rule", ok: capsOk, blocking: true,
    label: `правило выдаёт ${shape.caps.join(", ")} исполнителю ${shape.exec}`,
    detail: capsOk ? "есть" : "будет заведено мастером" });

  const bind = await q<{ owner_slug: string }>(
    "SELECT owner_slug FROM pact.owner_bindings WHERE sender = $1", [s.sender ?? ""]);
  const bindOk = bind.some((b) => b.owner_slug === owner);
  items.push({ key: "binding", ok: bindOk, blocking: true,
    label: "отправитель привязан к владельцу", detail: bindOk ? owner : "будет привязан мастером" });

  if (shape.irreversible) {
    const irr = await q<{ host: string }>(
      "SELECT host FROM pact.irreversibility WHERE host = $1", [host]);
    items.push({ key: "irr", ok: irr.length > 0, blocking: false,
      label: "необратимость объявлена", detail: irr.length ? "есть" : "будет добавлена мастером" });
  }

  // Браузерный инстанс владельца: у MITA он задан окружением юнита, поэтому для
  // нового владельца его заводит развёртывание, а не панель.
  if (shape.exec === "mita") {
    const instances = process.env["LPMC_CDP_INSTANCES"] ?? '{"internal":"http://127.0.0.1:9322"}';
    let has = false;
    try { has = Object.prototype.hasOwnProperty.call(JSON.parse(instances) as object, owner); } catch { has = false; }
    // Блокирующее по существу: MITA отклоняет запуск владельца без инстанса до
    // первого действия (W2-MITA-02, чужой профиль использовать нельзя). Панель
    // инстанс не заводит — это работа развёртывания, и честнее сказать об этом,
    // чем показать сценарий готовым.
    items.push({ key: "browser", ok: has, blocking: true,
      label: "браузерный инстанс владельца", detail: has ? "есть"
        : `у владельца «${owner}» инстанса нет — запуск будет отклонён до действия. Заводится развёртыванием (lpmc-browser@${owner}) либо возьмите владельца, у которого инстанс уже есть.` });
  }

  if (shape.exec === "cita") {
    const secrets = await q<{ name: string }>("SELECT name FROM pact.secret_names WHERE owner_slug = $1", [owner]);
    items.push({ key: "secret", ok: secrets.length > 0, blocking: false,
      label: "секрет доступа к внешнему интерфейсу", detail: secrets.length ? secrets.map((x) => x.name).join(", ")
        : "не заведён — значение вносится консолью lpmc-admin (мастер-ключ на веб не выносится)" });
  }

  const llm = await q<{ n: string }>(
    "SELECT count(*)::text AS n FROM web_llm_providers WHERE enabled = true");
  const llmOk = Number(llm[0]?.n ?? 0) > 0;
  items.push({ key: "model", ok: llmOk, blocking: false,
    label: "модель для квалификации Лины", detail: llmOk ? "включена" : "выключена — Лина будет разбирать команды правилами" });

  return { items, ready: items.every((i) => !i.blocking || i.ok) };
}

/** Завести всё недостающее одной операцией. Возвращает перечень выполненных шагов. */
/**
 * Хосты, которые нужно разрешить вместе с указанным.
 *
 * Сайты повсеместно отвечают перенаправлением между «голым» доменом и www —
 * например iana.org отдаёт 301 на www.iana.org. Перенаправление ведёт на ДРУГОЙ
 * хост, и запрос упирается в границу, хотя оператор всё сделал верно. Разрешаем
 * обе формы сразу: это то же самое разрешение, выраженное полностью.
 */
function hostVariants(host: string): string[] {
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!h) return [];
  return h.startsWith("www.") ? [h, h.slice(4)] : [h, "www." + h];
}

export async function apply(pool: pg.Pool, s: ScenarioSpec): Promise<{ ok: boolean; steps: string[]; reason?: string }> {
  const steps: string[] = [];
  const shape = shapeOf(s.kind);
  try {
    await admin.addOwner(pool, s.owner, s.ownerCategory || "client");
    steps.push(`клиент ${s.owner}`);

    for (const host of hostVariants(s.host)) {
      const pol = await admin.addNodePolicy(pool, { host, methods: s.methods, paths: s.paths, note: `сценарий: ${s.typeName}` });
      if (!pol.ok) return { ok: false, steps, reason: `граница узла (${host}): ${pol.reason ?? "отказ"}` };
      await admin.addAllow(pool, { owner: s.owner, host, methods: s.methods, paths: s.paths, op: shape.op });
    }
    steps.push(`обе границы → ${hostVariants(s.host).join(", ")} (перенаправление на www не сломает сценарий)`);

    await admin.addRule(pool, { sender: s.sender, owner: s.owner, caps: shape.caps, exec: shape.exec,
      lease: s.lease || 1800, appr: !!s.approval });
    steps.push(`правило ${s.sender} → ${s.owner} [${shape.caps.join(", ")}]`);

    await admin.addBinding(pool, s.sender, s.owner, "");
    steps.push(`привязка ${s.sender} → ${s.owner}`);

    if (shape.irreversible) {
      await admin.addIrr(pool, { host: s.host, op: shape.op, cls: "irreversible" });
      steps.push(`необратимость ${s.host} · ${shape.op}`);
    }

    if (s.typeName.trim()) {
      await addTaskType(pool, { name: s.typeName, keywords: s.keywords, executor: shape.exec,
        clarify: s.clarify, dod_template: s.dodTemplate });
      steps.push(`тип задачи «${s.typeName}»`);
    }
    return { ok: true, steps };
  } catch (e) {
    return { ok: false, steps, reason: e instanceof Error ? e.message : String(e) };
  }
}
