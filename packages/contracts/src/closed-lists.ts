/**
 * Закрытые перечни системы.
 *
 * Главное свойство здесь — не состав, а поведение при неизвестном значении:
 * оно приводит к ОТКАЗУ, а не к выбору по умолчанию и не к приведению
 * к ближайшему известному. Нормализация запрещена: приведение регистра, обрезка
 * пробелов и исправление опечаток снова сделали бы опечатку тихой, а перечень
 * существует именно ради того, чтобы она была громкой (D-018, CONTOURS §2.1).
 */

/** Идентификаторы исполнителей (D-018). Ровно два, нижний регистр, без разделителей. */
export const EXECUTORS = ["mita", "cita"] as const;
export type Executor = (typeof EXECUTORS)[number];

/** Статусы запуска (MITA §5.3). Терминальные закрывают run_id, приостанавливающие допускают возобновление. */
export const RUN_STATUSES = [
  "completed",
  "partially_completed",
  "blocked_awaiting_approval",
  "blocked_awaiting_human",
  "lease_expired",
  "cancelled",
  "denied_by_egress",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Состояния задачи (SPEC §13): девять основных и пять терминальных. */
export const TASK_STATES = [
  "RECEIVED", "VALIDATED", "POLICY_PENDING", "APPROVAL_PENDING", "READY",
  "LEASED", "RUNNING", "REVIEW_PENDING", "COMPLETED",
  "REJECTED", "DENIED", "FAILED", "CANCELLED", "EXPIRED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Проверка принадлежности закрытому перечню. Сравнение точное: ни приведения
 * регистра, ни обрезки пробелов здесь нет и быть не должно.
 */
export function isMember<T extends readonly string[]>(list: T, value: unknown): value is T[number] {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * `REJECTED` — отказ на валидации: ошибка в сообщении, таблицы правил не рассматривались.
 * `DENIED` — отказ политики при корректном входе: решение арбитра (D-022).
 * Неизвестное значение закрытого перечня относится к REJECTED: перечень проверяется
 * до применения правил, и такой отказ означает поломку отправителя, а не намерение.
 */
export type RefusalKind = "REJECTED" | "DENIED";

/**
 * Классы исходящего содержимого (LINA L-7).
 *
 * Всё, что система порождает сама, принадлежит одному из этих классов. Класс —
 * не украшение события, а предмет правила: разрешение выдаётся классу, а не
 * конкретному тексту, потому что текст проверить нечем, а класс проверяем.
 *
 * `clarification` — уточняющий вопрос человеку; `notification` — служебное
 * уведомление о состоянии; `result` — результат работы исполнителя.
 */
export const REPLY_CLASSES = ["clarification", "notification", "result"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

/**
 * Решение человека по результату работы (приёмка).
 *
 * Перечень закрыт и состоит из двух значений. Третьего — «частично» — здесь
 * намеренно нет: частичность выражается новой задачей, а не половинчатым
 * решением по старой, иначе задача осталась бы в состоянии, из которого нет
 * выхода.
 */
export const REVIEW_DECISIONS = ["accepted", "rejected"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
