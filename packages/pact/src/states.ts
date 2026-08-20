import type { TaskState } from "@lpmc/contracts";

/**
 * Автомат состояний задачи (SPEC §13). Состояние ведёт исключительно PACT:
 * исполнитель сообщает факты, отображение факта в состояние выполняется здесь.
 *
 * Переходы заданы перечислением, а не проверкой «не запрещено». Неизвестный
 * переход — ошибка, а не молчаливое присвоение: иначе задача однажды окажется
 * в состоянии, которого никто не назначал.
 */
const ALLOWED: Partial<Record<TaskState, readonly TaskState[]>> = {
  RECEIVED: ["VALIDATED", "REJECTED"],
  VALIDATED: ["POLICY_PENDING", "REJECTED"],
  POLICY_PENDING: ["READY", "APPROVAL_PENDING", "DENIED"],
  APPROVAL_PENDING: ["READY", "DENIED", "EXPIRED", "CANCELLED"],
  READY: ["LEASED", "CANCELLED", "EXPIRED"],
  LEASED: ["RUNNING", "READY", "CANCELLED", "EXPIRED", "FAILED"],
  // Ветка внутризапускового approval: RUNNING → APPROVAL_PENDING → RUNNING
  // с сохранением того же run_id (PACT 5.2 п. 5).
  // EXPIRED достижимо и из RUNNING: лизинг истекает по времени, а не по этапу
  // работы. Без этого перехода запуск с истёкшим лизингом некуда было бы деть —
  // он остался бы RUNNING навсегда, и по состоянию задачи это выглядело бы как
  // продолжающаяся работа.
  RUNNING: ["REVIEW_PENDING", "COMPLETED", "APPROVAL_PENDING", "FAILED", "CANCELLED", "EXPIRED"],
  REVIEW_PENDING: ["COMPLETED", "FAILED"],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export const TERMINAL: readonly TaskState[] = ["COMPLETED", "REJECTED", "DENIED", "FAILED", "CANCELLED", "EXPIRED"];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.includes(state);
}
