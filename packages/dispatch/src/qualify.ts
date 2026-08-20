/**
 * Диспетчер приёма: превращает кандидата в задачу из недоверенного сообщения
 * в набор значений закрытых типов.
 *
 * Разделение по свойствам (PACT §4.4). Всё, что ниже, работает с текстом; всё,
 * что после — gate — текста не видит вовсе. Граница проходит по типу: результат
 * этого модуля не содержит ни одной строки свободной формы, кроме тех, что
 * хранятся как данные задачи (цель, критерии приёмки) и в решение не входят.
 *
 * Разделение по правам появится вместе с квалификатором на модели: он получит
 * собственную учётную запись брокера без права публикации. Сегодня диспетчер
 * детерминирован, и разделять процессы нечего — но входные типы уже такие,
 * какими они останутся.
 */
export interface Candidate {
  requestId: string;
  sender: string;
  replyRouteId: string;
  channel: string;
  adapterId: string;
  objective: string;
  dod: string[];
  ownerHint: string | null;
}

export type CandidateParse =
  | { ok: true; candidate: Candidate }
  | { ok: false; reason: string };

/**
 * Разбор полезной нагрузки. Отказ здесь — REJECTED: сообщение не соответствует
 * контракту, и до правил дело не доходит (D-022).
 */
export function parseCandidate(payload: Record<string, unknown>): CandidateParse {
  const task = (payload["task"] ?? {}) as Record<string, unknown>;
  const requestId = str(payload["request_id"]);
  const replyRouteId = str(payload["reply_route_id"]);
  const channel = str(payload["channel"]);
  const adapterId = str(payload["adapter_id"]);
  const objective = str(task["objective"]);
  const dodRaw = task["dod"];
  const recipient = (payload["recipient_candidate"] ?? {}) as Record<string, unknown>;
  const actor = str(recipient["user_id"]);

  if (!requestId) return { ok: false, reason: "input.missing_field:request_id" };
  if (!replyRouteId) return { ok: false, reason: "input.missing_field:reply_route_id" };
  if (!channel || !adapterId) return { ok: false, reason: "input.missing_field:channel" };
  if (!actor) return { ok: false, reason: "input.missing_field:recipient_candidate.user_id" };
  if (!objective) return { ok: false, reason: "input.missing_field:task.objective" };
  if (!Array.isArray(dodRaw) || dodRaw.length === 0 || !dodRaw.every((x) => typeof x === "string")) {
    return { ok: false, reason: "input.missing_field:task.dod" };
  }
  // Предложение прав из недоверенного сообщения не читается вовсе: набор
  // предлагает диспетчер, а не отправитель. Присутствие поля — признак
  // продюсера, работающего по другому контракту.
  if ("granted_capabilities" in task) {
    return { ok: false, reason: "input.unexpected_field:granted_capabilities" };
  }
  return {
    ok: true,
    candidate: {
      requestId,
      // Отправитель — личность В КАНАЛЕ, которую утверждает адаптер: канал плюс
      // идентификатор участника. Из текста сообщения он не берётся: содержимое
      // не может назвать отправителя (L-10). Право утверждать эту личность есть
      // только у адаптера, и только он может опубликовать это событие — состав
      // прав на брокере делает подделку невозможной, а не соглашение в коде.
      sender: `${channel}:${actor}`,
      replyRouteId, channel, adapterId,
      objective, dod: dodRaw as string[],
      ownerHint: typeof task["owner"] === "string" ? task["owner"] : null,
    },
  };
}

/**
 * Набор capability, предлагаемый диспетчером (D-017).
 *
 * Сценариев стало два — браузерный и контрактный, — а различить их можно только
 * по смыслу обращения. Смысл читает модель, которой здесь пока нет, и делать
 * вид, что различие понято, квалификатор не станет: он предлагает ОБЪЕДИНЕНИЕ
 * известных наборов, а сужает таблица правил.
 *
 * Права от этого не расширяются: выдаётся пересечение предложенного
 * с разрешённым, поэтому предложить лишнее — значит не выдать ничего лишнего.
 * Теряется другое — способность предложения сузить разрешённое; вернётся она
 * вместе с квалификатором на модели.
 */
export const BROWSER_SCENARIO_CAPABILITIES = ["page.read", "page.screenshot", "report.build"] as const;
export const CONTRACT_SCENARIO_CAPABILITIES = [
  "dataset.query",
  // Необратимая возможность: предлагается, но выдаётся только там, где её
  // разрешает правило, и применяется только после подтверждения человеком
  // (P2-DEC-04). Предложение не есть выдача — иначе список предложенного
  // и был бы политикой.
  "record.create",
  "report.build",
] as const;

/** Прежнее имя набора первого сценария; оставлено для читаемости решений D-017. */
export const FIRST_SCENARIO_CAPABILITIES = BROWSER_SCENARIO_CAPABILITIES;

/**
 * Версия квалификатора попадает в разбор и оттуда — в аудит: по ней постфактум
 * видно, ЧЕМ был получен предложенный набор. Когда предлагать начнёт модель,
 * версия сменится, и старые решения останутся объяснимыми.
 */
export const QUALIFIER_VERSION = "rules-2";

export function proposeCapabilities(_candidate: Candidate): string[] {
  return [...new Set([...BROWSER_SCENARIO_CAPABILITIES, ...CONTRACT_SCENARIO_CAPABILITIES])];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
