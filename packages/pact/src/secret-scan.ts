import { createHash } from "node:crypto";

/**
 * Поиск действующих выдач секретов в исходящем тексте (W1-PACT-09).
 *
 * Хранить значения секретов ради такой сверки нельзя: это была бы вторая копия
 * секретов вне custody, и утечка журнала проверок раскрывала бы ровно то, что
 * проверка защищает. Поэтому хранится солёный хеш и длина, а привратник берёт
 * из текста все подстроки этой длины.
 *
 * Стоимость — длина текста, умноженная на число различных длин выданных
 * секретов; при пустом наборе работы нет вовсе.
 */
export interface SecretDigest {
  salt: string;
  digest: string;
  length: number;
  issuedFor: string;
}

export function digestOf(salt: string, value: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

/**
 * Возвращает `issued_for` первой найденной выдачи или null. Именно
 * `issued_for`, а не сам секрет: в журнал попадает, ЧТО утекло бы, но не само
 * значение.
 */
export function findSecret(text: string, digests: readonly SecretDigest[]): string | null {
  if (digests.length === 0) return null;
  const byLength = new Map<number, SecretDigest[]>();
  for (const d of digests) {
    const list = byLength.get(d.length);
    if (list) list.push(d);
    else byLength.set(d.length, [d]);
  }
  for (const [len, group] of byLength) {
    if (len > text.length) continue;
    for (let i = 0; i + len <= text.length; i += 1) {
      const window = text.slice(i, i + len);
      for (const d of group) {
        if (digestOf(d.salt, window) === d.digest) return d.issuedFor;
      }
    }
  }
  return null;
}
