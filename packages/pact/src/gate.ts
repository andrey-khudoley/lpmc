import { EXECUTORS, isMember, type RefusalKind } from "@lpmc/contracts";

/**
 * Детерминированный gate — та часть арбитра, которая выдаёт полномочия.
 *
 * Правило контура: LLM выбирает маршрут, LLM не выбирает полномочия (D-003).
 * Отсюда три свойства, которые видно прямо в типах:
 *
 *   1. На вход поступают ТОЛЬКО значения закрытых типов: идентификаторы,
 *      перечисления, множества строк. Свободного текста здесь нет вовсе —
 *      ни постановки задачи, ни обоснования диспетчера. Их нельзя одновременно
 *      дать модели на оценку и защитить её от них, поэтому сюда они не попадают
 *      (PACT §4.4 п. 1).
 *   2. Функция чистая: тот же вход и та же версия таблиц дают тот же вердикт
 *      (PACT §4.4 п. 3). Ни времени, ни случайности, ни обращений к сети.
 *   3. Отсутствие правила означает отказ. Умолчания «разрешено» не существует
 *      (PACT §4.4 п. 6).
 */

/** Строка таблицы правил. Данные, а не код: меняется без выкатки (D-027). */
export interface Rule {
  rulesetVersion: number;
  sender: string;
  ownerSlug: string;
  capabilities: readonly string[];
  executor: string;
  leaseTtlSeconds: number;
  requiresApproval: boolean;
}

/**
 * Вход gate. Обратите внимание, чего здесь НЕТ: текста задачи, обоснования
 * диспетчера, уверенности модели. Диспетчер предлагает набор capabilities,
 * и это предложение служит фильтром запрошенного, а не источником прав.
 */
export interface GateInput {
  sender: string;
  ownerSlug: string;
  requestedCapabilities: readonly string[];
  rulesetVersion: number;
}

export type GateVerdict =
  | {
      ok: true;
      grantedCapabilities: string[];
      executor: string;
      leaseTtlSeconds: number;
      requiresApproval: boolean;
      rulesetVersion: number;
    }
  | { ok: false; kind: RefusalKind; reason: string; rulesetVersion: number };

export function decide(input: GateInput, rules: readonly Rule[], knownOwners: readonly string[]): GateVerdict {
  const v = input.rulesetVersion;

  // Неизвестные значения перечислений — отказ на валидации, а не отказ политики:
  // ошибка в сообщении, до правил дело не дошло (D-022).
  if (!knownOwners.includes(input.ownerSlug)) {
    return { ok: false, kind: "REJECTED", reason: "input.unknown_owner", rulesetVersion: v };
  }
  if (input.requestedCapabilities.length === 0) {
    return { ok: false, kind: "REJECTED", reason: "input.empty_requested_capabilities", rulesetVersion: v };
  }

  const applicable = rules.filter(
    (r) => r.rulesetVersion === v && r.sender === input.sender && r.ownerSlug === input.ownerSlug,
  );
  if (applicable.length === 0) {
    // Отсутствие правила — отказ ПОЛИТИКИ: вход корректен, разрешения нет.
    return { ok: false, kind: "DENIED", reason: "policy.no_matching_rule", rulesetVersion: v };
  }

  const allowed = new Set(applicable.flatMap((r) => r.capabilities));
  // granted ⊆ allowed_by_rules ∩ requested. Предложение диспетчера не может
  // расширить результат: оно только сужает разрешённое (PACT §4.4 п. 4).
  const granted = [...new Set(input.requestedCapabilities)].filter((c) => allowed.has(c)).sort();
  if (granted.length === 0) {
    return { ok: false, kind: "DENIED", reason: "policy.no_capability_granted", rulesetVersion: v };
  }

  const executors = [...new Set(applicable.map((r) => r.executor))];
  if (executors.length !== 1) {
    // Расхождение в правилах не разрешается «выбором по умолчанию».
    return { ok: false, kind: "DENIED", reason: "policy.ambiguous_executor", rulesetVersion: v };
  }
  const executor = executors[0]!;
  if (!isMember(EXECUTORS, executor)) {
    return { ok: false, kind: "REJECTED", reason: "input.unknown_executor", rulesetVersion: v };
  }

  return {
    ok: true,
    grantedCapabilities: granted,
    executor,
    leaseTtlSeconds: Math.min(...applicable.map((r) => r.leaseTtlSeconds)),
    requiresApproval: applicable.some((r) => r.requiresApproval),
    rulesetVersion: v,
  };
}
