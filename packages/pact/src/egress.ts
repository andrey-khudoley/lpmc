import { isMember, REPLY_CLASSES, type ReplyClass } from "@lpmc/contracts";

/**
 * Проверка исходящего содержимого (SPEC §5.7, §12; инвариант 12 списка §23).
 *
 * Функция чистая: она получает разобранное предложение и таблицу правил, и не
 * ходит ни в базу, ни в сеть. Это позволяет доказать её поведение тестами —
 * а доказывать здесь есть что: именно она решает, что покидает систему.
 *
 * Свободного текста на входе решения нет. Текст участвует ровно одним числом —
 * своей длиной. Иначе содержимое, которое проверяют, влияло бы на решение
 * о самом себе.
 */
export interface EgressProposal {
  proposalId: string;
  replyRouteId: string;
  channel: string;
  adapterId: string;
  contentClass: string;
  chars: number;
  ownerSlug: string | null;
  taskId: string | null;
}

export interface EgressRule {
  rulesetVersion: number;
  ownerSlug: string;
  channel: string;
  contentClass: ReplyClass;
  maxChars: number;
  decision: "allow" | "deny";
}

export type EgressVerdict =
  | { decision: "ALLOWED"; reason: string; rulesetVersion: number }
  | { decision: "REJECTED" | "DENIED"; reason: string; rulesetVersion?: number };

/**
 * Различение отказов (D-022): REJECTED — событие не соответствует контракту,
 * DENIED — соответствует, но правило его не разрешает. Смешение этих двух
 * означало бы, что по журналу нельзя отличить сломанного продюсера от попытки
 * вынести наружу то, что не разрешено.
 */
export function decideEgress(
  p: EgressProposal,
  rules: readonly EgressRule[],
  routeBelongsToTask: (routeId: string, taskId: string) => boolean,
): EgressVerdict {
  if (!p.proposalId || !p.replyRouteId || !p.channel || !p.adapterId) {
    return { decision: "REJECTED", reason: "egress.missing_field" };
  }
  if (!isMember(REPLY_CLASSES, p.contentClass)) {
    // Неизвестное значение закрытого перечня — отказ, а не приведение
    // к ближайшему известному классу (D-022).
    return { decision: "REJECTED", reason: `egress.unknown_class:${p.contentClass}` };
  }
  if (p.chars <= 0) return { decision: "REJECTED", reason: "egress.empty_content" };

  // Ответ по задаче уходит только по маршруту этой задачи (SPEC §11 п. 3).
  // Предложение, названное ответом на задачу, но адресованное другому маршруту,
  // — это попытка вынести содержимое в чужой диалог.
  if (p.taskId !== null && !routeBelongsToTask(p.replyRouteId, p.taskId)) {
    return { decision: "DENIED", reason: "egress.route_not_of_task" };
  }

  const version = rules.length > 0 ? Math.max(...rules.map((r) => r.rulesetVersion)) : 0;
  const applicable = rules.filter(
    (r) => r.rulesetVersion === version
      && r.channel === p.channel
      && r.contentClass === p.contentClass
      && (r.ownerSlug === "*" || r.ownerSlug === p.ownerSlug),
  );
  if (applicable.length === 0) {
    // Пустая таблица и отсутствие подходящей строки — одно и то же: наружу
    // не уходит ничего, чему не выдано разрешение.
    return { decision: "DENIED", reason: "egress.no_rule", rulesetVersion: version };
  }
  // Точное совпадение владельца сильнее «*»: иначе общее разрешение перекрывало
  // бы частный запрет, и запрет нельзя было бы выразить вовсе.
  const exact = applicable.filter((r) => r.ownerSlug !== "*");
  const chosen = exact.length > 0 ? exact : applicable;
  if (chosen.some((r) => r.decision === "deny")) {
    return { decision: "DENIED", reason: "egress.rule_denies", rulesetVersion: version };
  }
  const limit = Math.min(...chosen.map((r) => r.maxChars));
  if (p.chars > limit) {
    return { decision: "DENIED", reason: `egress.too_long:${p.chars}>${limit}`, rulesetVersion: version };
  }
  return { decision: "ALLOWED", reason: "egress.rule_allows", rulesetVersion: version };
}
