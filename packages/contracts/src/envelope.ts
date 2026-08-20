import { EXECUTORS, isMember, RUN_STATUSES } from "./closed-lists.js";
import { majorFromSchemaVersion, majorFromSubject } from "./events.js";

/** Конверт события (SPEC §9). Секреты и токены в payload не включаются. */
export interface Envelope<T = unknown> {
  event_id: string;
  event_type: string;
  schema_version: string;
  occurred_at: string;
  producer: { service: string; instance: string };
  correlation_id: string;
  causation_id?: string;
  deduplication_key?: string;
  payload: T;
}

export type Verdict =
  | { ok: true }
  | { ok: false; kind: "REJECTED" | "DENIED"; reason: string };

/**
 * Проверка соответствия версий (D-015, D-016). Несовпадение старшей версии
 * в subject и в schema_version — ОШИБКА КОНТРАКТА: событие уходит в DLQ,
 * а не читается по ближайшей известной схеме.
 */
export function checkVersions(subject: string, schemaVersion: string): Verdict {
  const a = majorFromSubject(subject);
  const b = majorFromSchemaVersion(schemaVersion);
  if (a === undefined) return { ok: false, kind: "REJECTED", reason: `subject без версии: ${subject}` };
  if (b === undefined) return { ok: false, kind: "REJECTED", reason: `schema_version не semver: ${schemaVersion}` };
  if (a !== b) {
    return {
      ok: false,
      kind: "REJECTED",
      reason: `старшая версия в subject (${a}) не совпадает со schema_version (${b})`,
    };
  }
  return { ok: true };
}

/** Авторизованная задача (MITA §4.3): обязательные поля перечислены закрыто. */
export interface AuthorizedTask {
  task_id: string;
  run_id: string;
  executor: string;
  owner: string;
  granted_capabilities: string[];
  lease: { id: string; generation: number; expires_at: string };
  reply_route_id: string;
  dod: string[];
}

/**
 * Проверка входа исполнителя (MITA Н-1, Н-2, Н-3). Отказ выдаётся ДО первого
 * внешнего действия. Поле requested_capabilities исполнителю не передаётся вовсе:
 * оно остаётся входом диспетчера внутри PACT.
 */
export function validateAuthorizedTask(
  task: Partial<AuthorizedTask> & Record<string, unknown>,
  knownOwners: readonly string[],
  selfExecutor: string,
): Verdict {
  for (const field of ["task_id", "run_id", "executor", "owner", "reply_route_id"] as const) {
    if (!task[field]) return { ok: false, kind: "REJECTED", reason: `input.missing_field:${field}` };
  }
  if (!task.lease) return { ok: false, kind: "REJECTED", reason: "input.missing_field:lease" };
  if (!task.dod || task.dod.length === 0) return { ok: false, kind: "REJECTED", reason: "input.missing_field:dod" };
  if (!task.granted_capabilities || task.granted_capabilities.length === 0) {
    return { ok: false, kind: "REJECTED", reason: "input.missing_field:granted_capabilities" };
  }
  if ("requested_capabilities" in task) {
    return { ok: false, kind: "REJECTED", reason: "input.unexpected_field:requested_capabilities" };
  }
  if (!isMember(EXECUTORS, task.executor)) {
    return { ok: false, kind: "REJECTED", reason: "input.unknown_executor" };
  }
  if (task.executor !== selfExecutor) {
    return { ok: false, kind: "REJECTED", reason: "input.executor_mismatch" };
  }
  if (!knownOwners.includes(task.owner as string)) {
    return { ok: false, kind: "REJECTED", reason: "input.unknown_owner" };
  }
  return { ok: true };
}

/** Неизвестный статус — ошибка контракта, а не приведение к ближайшему и не успех (MITA Н-26). */
export function validateRunStatus(status: unknown): Verdict {
  if (!isMember(RUN_STATUSES, status)) {
    return { ok: false, kind: "REJECTED", reason: `contract.unknown_status:${String(status)}` };
  }
  return { ok: true };
}
