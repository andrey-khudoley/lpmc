import { checkVersions, type Envelope, type Verdict } from "./envelope.js";

/**
 * Проверка конверта на приёме (SPEC §9, D-015, D-016).
 *
 * Потребитель обязан проверить конверт ДО того, как посмотрит в payload:
 * событие без тождества нельзя дедуплицировать, без корреляции — связать
 * с обращением, а при расхождении старших версий его нельзя читать вовсе.
 *
 * Разбор JSON успехом не является: строка `{}` разбирается прекрасно и не
 * содержит ничего. Раньше каждый потребитель проверял конверт по-своему или
 * не проверял вовсе — теперь проверка одна на всех, и её нельзя пропустить,
 * не заметив.
 */
export function checkEnvelope(value: unknown): Verdict {
  if (typeof value !== "object" || value === null) {
    return { ok: false, kind: "REJECTED", reason: "envelope.not_an_object" };
  }
  const e = value as Partial<Envelope> & Record<string, unknown>;
  for (const field of ["event_id", "event_type", "schema_version", "occurred_at",
    "correlation_id"] as const) {
    if (typeof e[field] !== "string" || e[field] === "") {
      return { ok: false, kind: "REJECTED", reason: `envelope.missing_field:${field}` };
    }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.event_id as string)) {
    // Тождество события обязано быть uuid: по нему работает прикладная
    // дедупликация (D-023), а произвольная строка не гарантирует уникальности.
    return { ok: false, kind: "REJECTED", reason: "envelope.event_id_not_uuid" };
  }
  const producer = e["producer"] as { service?: unknown } | undefined;
  if (!producer || typeof producer.service !== "string" || producer.service === "") {
    return { ok: false, kind: "REJECTED", reason: "envelope.missing_field:producer.service" };
  }
  if (!("payload" in e)) {
    return { ok: false, kind: "REJECTED", reason: "envelope.missing_field:payload" };
  }
  return { ok: true };
}

/** Проверка конверта вместе с согласованностью версий темы и схемы. */
export function checkEnvelopeFor(subject: string, value: unknown): Verdict {
  const base = checkEnvelope(value);
  if (!base.ok) return base;
  const e = value as Envelope;
  return checkVersions(subject, e.schema_version);
}
