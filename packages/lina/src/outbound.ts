import { isMember } from "@lpmc/contracts";

/**
 * Одобренное к доставке сообщение (SPEC §10.5). Единственный продюсер —
 * egress-часть PACT; LINA в `outbound.*` не публикует никогда (LINA §13.4 п. 2).
 *
 * Отличие от состава SPEC §10.5: адресат назван непрозрачным `reply_route_id`,
 * а не парой «конечная точка + диалог». Источник описывает адресата внешними
 * идентификаторами, но по §10.2 они не покидают контур LINA — значит, Egress
 * Guard их попросту не знает и подставить не может. Канал и адаптер остаются:
 * первый определяет топик доставки, второй — принадлежность адаптеру.
 */
export interface OutboundMessage {
  message_id: string;
  destination: { channel: string; adapter_id: string; reply_route_id: string };
  content: { text: string; attachment_refs?: string[] };
  visibility: string;
  idempotency_key: string;
  /**
   * Непрозрачное срочное значение: доставляется дословно, показывается один раз
   * и не хранится в истории диалога (LINA L-13, W2-LINA-02).
   */
  ephemeral?: boolean;
}

export type OutboundVerdict =
  | { ok: true }
  | { ok: false; reason: string };

const VISIBILITIES = ["external"] as const;

/**
 * Проверка перед доставкой (LINA §10.3 п. 5, §10.4 п. 3).
 *
 * Адаптер сверяет свой `adapter_id` и канал ДО отправки. Событие, адресованное
 * другому адаптеру, не доставляется «на всякий случай» — оно уходит в разбор.
 * Иначе один адаптер мог бы вынести содержимое в чужой канал, и граница между
 * каналами существовала бы только на бумаге.
 *
 * Проверка чистая: она не обращается ни к базе, ни к сети, поэтому её результат
 * воспроизводим по одному лишь событию.
 */
export function validateOutbound(
  msg: Partial<OutboundMessage> & Record<string, unknown>,
  self: { channel: string; adapterId: string },
): OutboundVerdict {
  for (const f of ["message_id", "idempotency_key", "destination", "content", "visibility"] as const) {
    if (!msg[f]) return { ok: false, reason: `outbound.missing_field:${f}` };
  }
  if (!isMember(VISIBILITIES, msg.visibility)) {
    return { ok: false, reason: `outbound.unknown_visibility:${String(msg.visibility)}` };
  }
  const d = msg.destination as OutboundMessage["destination"];
  if (!d.channel || !d.adapter_id || !d.reply_route_id) {
    return { ok: false, reason: "outbound.incomplete_destination" };
  }
  if (d.channel !== self.channel) return { ok: false, reason: `outbound.foreign_channel:${d.channel}` };
  if (d.adapter_id !== self.adapterId) return { ok: false, reason: `outbound.foreign_adapter:${d.adapter_id}` };
  const c = msg.content as OutboundMessage["content"];
  if (typeof c.text !== "string" || c.text === "") return { ok: false, reason: "outbound.empty_text" };
  return { ok: true };
}
