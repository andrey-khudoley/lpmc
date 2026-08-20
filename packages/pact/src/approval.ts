import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Одноразовость ссылки подтверждения.
 *
 * Подписанная ссылка со сроком дала бы ограничение по времени, но не
 * одноразовость: ею можно воспользоваться дважды. Поэтому состояние ведётся
 * в базе, а первое обращение «заявляет» ссылку за одним зрителем.
 *
 * Сравнение идентификатора зрителя — за постоянное время: иначе по задержке
 * ответа значение подбиралось бы побайтно.
 */
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function newViewerId(): string {
  return randomBytes(16).toString("base64url");
}

export function sameViewer(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type ClaimVerdict =
  | { ok: true; viewer: string; fresh: boolean }
  | { ok: false; reason: string };

/**
 * Проверка права открыть ссылку.
 *
 * Никем не заявленная ссылка заявляется за обратившимся. Заявленная — открывается
 * только тем же зрителем. Просроченная и уже решённая не открываются вовсе:
 * подтверждение не пересматривается, потому что действие уже могло произойти.
 */
export function claim(
  state: string, claimedBy: string | null, expiresAt: Date, viewer: string | undefined, now: Date,
): ClaimVerdict {
  if (state !== "pending") return { ok: false, reason: `approval.already_${state}` };
  if (now > expiresAt) return { ok: false, reason: "approval.expired" };
  if (claimedBy === null) return { ok: true, viewer: viewer ?? newViewerId(), fresh: true };
  if (!viewer || !sameViewer(claimedBy, viewer)) {
    return { ok: false, reason: "approval.claimed_by_other" };
  }
  return { ok: true, viewer, fresh: false };
}
