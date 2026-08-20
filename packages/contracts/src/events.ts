/**
 * Имена событий (D-015).
 *
 * subject — адрес доставки: домен во множественном числе, версия в конце.
 * event_type — тип содержимого: объект в единственном числе, действие в прошедшем
 * времени, без версии. Версия payload — поле конверта schema_version (semver).
 * При расхождении маршрут определяет subject, чтение — schema_version;
 * несовпадение старших версий отправляет событие в DLQ.
 */
export interface EventName {
  subject: string;
  eventType: string;
}

export const EVENTS = {
  messageReceived: { subject: "inbound.raw.cli.v1", eventType: "message.received" },
  requestSubmitted: { subject: "requests.task-candidate.v1", eventType: "request.submitted" },
  requestClarificationNeeded: { subject: "requests.clarification-needed.v1", eventType: "request.clarification_needed" },
  requestCancelled: { subject: "requests.cancelled.v1", eventType: "request.cancelled" },
  taskAccepted: { subject: "tasks.accepted.v1", eventType: "task.accepted" },
  taskRejected: { subject: "tasks.rejected.v1", eventType: "task.rejected" },
  taskAuthorized: { subject: "tasks.authorized.v1", eventType: "task.authorized" },
  policyDecided: { subject: "policy.decided.v1", eventType: "policy.decided" },
  approvalRequested: { subject: "approvals.requested.v1", eventType: "approval.requested" },
  approvalDecided: { subject: "approvals.decided.v1", eventType: "approval.decided" },
  runStarted: { subject: "runs.started.v1", eventType: "run.started" },
  runBlocked: { subject: "runs.blocked.v1", eventType: "run.blocked" },
  runCompleted: { subject: "runs.completed.v1", eventType: "run.completed" },
  runFailed: { subject: "runs.failed.v1", eventType: "run.failed" },
  replyProposed: { subject: "replies.proposed.v1", eventType: "reply.proposed" },
  messageDispatchRequested: { subject: "outbound.cli.v1", eventType: "message.dispatch_requested" },
  deliverySucceeded: { subject: "deliveries.succeeded.v1", eventType: "delivery.succeeded" },
  deliveryFailed: { subject: "deliveries.failed.v1", eventType: "delivery.failed" },
  ownerUpdated: { subject: "owners.updated.v1", eventType: "owner.updated" },
  // Решение человека по результату работы. Продюсер — канальный адаптер: он
  // передаёт факт «человек в этом диалоге принял решение», но не толкует его.
  reviewDecided: { subject: "reviews.decided.v1", eventType: "review.decided" },
} as const satisfies Record<string, EventName>;

/** Запрос запуска адресуется исполнителю суффиксом subject — значением из закрытого перечня, а не именем инструмента. */
export function runRequestedSubject(executor: string): string {
  return `runs.requested.${executor}.v1`;
}

/** Старшая версия из subject: последний сегмент вида vN. */
export function majorFromSubject(subject: string): number | undefined {
  const m = /\.v(\d+)$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

/** Старшая версия из semver поля schema_version. */
export function majorFromSchemaVersion(schemaVersion: string): number | undefined {
  const m = /^(\d+)\.\d+\.\d+$/.exec(schemaVersion);
  return m ? Number(m[1]) : undefined;
}
