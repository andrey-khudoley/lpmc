import { isMember, RUN_STATUSES, type RunStatus, type TaskState } from "@lpmc/contracts";

/**
 * Отображение факта, сообщённого исполнителем, в состояние задачи.
 *
 * Состояние ведёт исключительно PACT (SPEC §13). Исполнитель сообщает, ЧТО
 * произошло; чем это является для задачи, решает арбитр. Поэтому здесь нет
 * ни одного поля, приходящего из события, кроме статуса из закрытого перечня:
 * исполнитель не называет состояние задачи и не может его назвать.
 */
export type RunOutcome =
  | { ok: true; to: TaskState; reason: string }
  | { ok: false; reason: string };

export function stateForRunStatus(status: unknown): RunOutcome {
  if (!isMember(RUN_STATUSES, status)) {
    // Неизвестный статус — ошибка контракта, а не «наверное, завершился»
    // (MITA Н-26).
    return { ok: false, reason: `contract.unknown_status:${String(status)}` };
  }
  const s: RunStatus = status;
  switch (s) {
    case "completed":
      // Не COMPLETED: результат исполнителя ещё не проверен человеком или
      // правилом приёмки. Задача завершается отдельным решением.
      return { ok: true, to: "REVIEW_PENDING", reason: "run.completed" };
    case "partially_completed":
      return { ok: true, to: "REVIEW_PENDING", reason: "run.partially_completed" };
    case "blocked_awaiting_approval":
      return { ok: true, to: "APPROVAL_PENDING", reason: "run.blocked_awaiting_approval" };
    case "blocked_awaiting_human":
      return { ok: true, to: "REVIEW_PENDING", reason: "run.blocked_awaiting_human" };
    case "lease_expired":
      return { ok: true, to: "EXPIRED", reason: "run.lease_expired" };
    case "cancelled":
      return { ok: true, to: "CANCELLED", reason: "run.cancelled" };
    case "denied_by_egress":
      return { ok: true, to: "FAILED", reason: "run.denied_by_egress" };
    case "failed":
      return { ok: true, to: "FAILED", reason: "run.failed" };
  }
}
