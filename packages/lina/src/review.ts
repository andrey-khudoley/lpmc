import { isMember, REVIEW_DECISIONS, type ReviewDecision } from "@lpmc/contracts";

/**
 * Решение человека по результату работы.
 *
 * LINA передаёт ФАКТ решения, а не толкует его. Различить «принято» и «нет,
 * переделай» в свободном тексте — это суждение о содержимом, а суждений,
 * влияющих на обработку, у LINA ровно одно: полнота запроса (L-6). Поэтому
 * решение выражается командой канала, а не разбором сообщения: человек
 * нажимает «принять», а не пишет слово, которое кто-то потом истолкует.
 *
 * Задачу здесь не называют. Идентификатор задачи непрозрачен для канала, и его
 * подстановка из сообщения означала бы, что человек (или содержимое) выбирает,
 * какую задачу закрыть. Связь восстанавливает арбитр — по маршруту ответа.
 */
export interface ReviewInput {
  decision: string;
  note: string;
}

export type ReviewParse =
  | { ok: true; decision: ReviewDecision; note: string }
  | { ok: false; reason: string };

export function parseReview(input: ReviewInput): ReviewParse {
  if (!isMember(REVIEW_DECISIONS, input.decision)) {
    return { ok: false, reason: `review.unknown_decision:${input.decision}` };
  }
  const note = input.note.trim();
  // Отказ без причины запрещён: «переделай» без объяснения не даёт исполнителю
  // ничего, кроме повторения того же самого.
  if (input.decision === "rejected" && note === "") {
    return { ok: false, reason: "review.rejection_without_reason" };
  }
  return { ok: true, decision: input.decision, note };
}
