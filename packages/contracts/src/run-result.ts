import { isMember, RUN_STATUSES, type RunStatus } from "./closed-lists.js";

/**
 * Закрытые перечни результата запуска (MITA §5.2, §5.3, §5.7).
 *
 * Перечни внесены целиком на первой волне, хотя порождать большую их часть
 * начнёт вторая. Причина не в аккуратности: добавление значения в закрытый
 * перечень — несовместимое изменение схемы (D-016), а значит, потребовало бы
 * новой мажорной версии события и выкатки всех потребителей. Полный перечень
 * с самого начала избавляет от этой цены.
 */

/** Класс исхода: терминальный закрывает запуск, приостанавливающий допускает возобновление. */
export const SUSPENDING_STATUSES = [
  "blocked_awaiting_approval", "blocked_awaiting_human", "lease_expired",
] as const;

export function isSuspending(status: RunStatus): boolean {
  return (SUSPENDING_STATUSES as readonly string[]).includes(status);
}

/** Состояние, в котором оставлена внешняя система (MITA §5.6.2, п. 3). */
export const EXTERNAL_STATES = [
  "no_change", "prepared_reversible", "partially_applied", "unknown",
] as const;
export type ExternalState = (typeof EXTERNAL_STATES)[number];

/** Исход проверки пункта DoD (MITA §15.4). */
export const DOD_OUTCOMES = ["verified", "failed", "not_checked"] as const;
export type DodOutcome = (typeof DOD_OUTCOMES)[number];

/**
 * Типизированные причины (MITA §5.7). Причина не заменяет статус и не выводится
 * из него: допустимость пары проверяется по таблице.
 */
export const RUN_REASONS = {
  "input.schema_invalid": ["failed"],
  "input.missing_field": ["failed"],
  "input.unknown_executor": ["failed"],
  "input.executor_mismatch": ["failed"],
  "input.lease_expired_on_arrival": ["failed"],
  "input.lease_generation_stale": ["failed"],
  "input.unknown_owner": ["failed"],
  "input.instance_mismatch": ["failed"],
  "input.dod_not_verifiable": ["failed", "partially_completed"],
  "capability.not_granted": ["failed", "partially_completed"],
  "capability.insufficient_for_action": ["blocked_awaiting_approval", "partially_completed"],
  "irreversibility.unclassifiable": ["blocked_awaiting_approval"],
  "approval.required_not_granted": ["blocked_awaiting_approval"],
  "approval.denied": ["blocked_awaiting_approval"],
  "approval.wait_timeout": ["blocked_awaiting_approval"],
  "approval.mismatched_run": ["blocked_awaiting_approval"],
  "human.captcha": ["blocked_awaiting_human"],
  "human.login_required": ["blocked_awaiting_human"],
  "human.second_factor_out_of_band": ["blocked_awaiting_human"],
  "human.device_binding": ["blocked_awaiting_human"],
  "human.window_expired": ["blocked_awaiting_human"],
  "human.screen_access_denied": ["blocked_awaiting_human"],
  "lease.expired_mid_run": ["lease_expired"],
  "lease.insufficient_for_irreversible": ["lease_expired", "blocked_awaiting_approval"],
  "egress.domain_not_allowed": ["denied_by_egress"],
  "egress.method_not_allowed": ["denied_by_egress"],
  "egress.authorization_invalid": ["lease_expired"],
  "cancelled.by_pact": ["cancelled"],
  "cancelled.lease_revoked": ["cancelled"],
  "execution.interface_changed": ["failed", "partially_completed"],
  "execution.service_unavailable": ["failed", "partially_completed"],
  "execution.scenario_not_converging": ["failed", "partially_completed"],
  "dod.partially_verified": ["partially_completed"],
  "dod.not_verifiable": ["partially_completed", "failed", "blocked_awaiting_human"],
  "content.injection_detected": ["failed", "partially_completed"],
  "dependency.egress_proxy_unavailable": ["failed"],
  "dependency.secret_service_unavailable": ["failed"],
  "dependency.broker_unavailable": ["failed"],
} as const satisfies Record<string, readonly RunStatus[]>;

export type RunReason = keyof typeof RUN_REASONS;

/** Блок приостановки: чего ждём и в каком состоянии оставлена внешняя система. */
export interface Suspension {
  condition: string;
  awaited_decision_id: string | null;
  external_state: ExternalState;
}

export interface DodEntry {
  item: string;
  outcome: DodOutcome;
  method: string;
  artifact_ref: string | null;
}

export interface RunResult {
  status: RunStatus;
  reason: string | null;
  suspension: Suspension | null;
  summary: string;
  artifact_refs: string[];
  changes: unknown[];
  dod: DodEntry[];
  external_calls: unknown[];
  capabilities_used: string[];
  provenance_flags: Record<string, unknown>;
}

export type ResultVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Проверка результата запуска на соответствие контракту.
 *
 * Три правила, которые нельзя выразить перечнями и потому проверяются здесь:
 * причина обязательна для всякого исхода, кроме `completed`; пара «статус +
 * причина» обязана быть допустимой; `completed` требует, чтобы КАЖДЫЙ пункт DoD
 * имел исход `verified`.
 *
 * Последнее правило — не формальность: именно оно не даёт назвать работу
 * сделанной, когда проверить её было нечем.
 */
export function validateRunResult(input: Partial<RunResult> | Record<string, unknown>): ResultVerdict {
  const r = input as Record<string, unknown>;
  const status = r["status"];
  if (!isMember(RUN_STATUSES, status)) {
    return { ok: false, reason: `contract.unknown_status:${String(status)}` };
  }
  const reason = typeof r["reason"] === "string" && r["reason"] !== "" ? r["reason"] : null;
  if (status !== "completed" && reason === null) {
    return { ok: false, reason: "contract.reason_required" };
  }
  if (reason !== null) {
    const allowed = (RUN_REASONS as Record<string, readonly string[]>)[reason];
    if (!allowed) return { ok: false, reason: `contract.unknown_reason:${reason}` };
    if (!allowed.includes(status)) {
      return { ok: false, reason: `contract.reason_not_for_status:${reason}/${status}` };
    }
  }

  const suspension = r["suspension"] as Suspension | null | undefined;
  if (isSuspending(status)) {
    if (!suspension) return { ok: false, reason: "contract.suspension_required" };
    if (!isMember(EXTERNAL_STATES, suspension.external_state)) {
      return { ok: false, reason: `contract.unknown_external_state:${String(suspension.external_state)}` };
    }
    if (!suspension.condition) return { ok: false, reason: "contract.suspension_condition_required" };
  } else if (suspension) {
    // Блок приостановки при терминальном исходе означал бы, что запуск закрыт
    // и одновременно чего-то ждёт.
    return { ok: false, reason: "contract.suspension_on_terminal" };
  }

  const dod = r["dod"];
  if (!Array.isArray(dod)) return { ok: false, reason: "contract.dod_required" };
  for (const entry of dod as DodEntry[]) {
    if (!isMember(DOD_OUTCOMES, entry.outcome)) {
      return { ok: false, reason: `contract.unknown_dod_outcome:${String(entry.outcome)}` };
    }
  }
  if (status === "completed") {
    if (dod.length === 0) return { ok: false, reason: "contract.completed_without_dod" };
    if ((dod as DodEntry[]).some((e) => e.outcome !== "verified")) {
      return { ok: false, reason: "contract.completed_with_unverified_dod" };
    }
  }
  return { ok: true };
}
