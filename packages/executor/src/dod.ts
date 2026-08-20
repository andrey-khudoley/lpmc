import type { DodEntry, DodOutcome } from "@lpmc/contracts";

/**
 * Проверка критериев приёмки фактическим наблюдением (MITA §15, W1-MITA-06).
 *
 * Правило M-7: пункт не отмечается выполненным без фактической проверки
 * в целевой системе. Отсюда три следствия, определяющие устройство модуля.
 *
 * 1. Проверка выполняется ПОСЛЕ действия и НЕЗАВИСИМО от него. Наблюдение,
 *    собранное по ходу работы, для проверки не годится: оно относится
 *    к моменту действия, а проверять надо результирующее состояние.
 * 2. Косвенные признаки не считаются. Адрес страницы, отсутствие ошибки,
 *    «кнопка нажалась» — интерфейсы возвращают и ложноположительные,
 *    и ложноотрицательные признаки.
 * 3. Отсутствие возможности проверить — это `not_checked`, а не `verified`.
 *    Итог такого запуска не может быть `completed`.
 *
 * Пункт, написанный человеком свободным текстом, машинно не проверяется. Здесь
 * нет попытки его «понять»: понимание было бы догадкой, а догадка в проверке
 * означает отметку по косвенному признаку. Проверяются только пункты, выраженные
 * закрытым набором форм ниже.
 */
export type Check =
  | { kind: "http-status"; url: string; expect: number }
  | { kind: "page-contains"; url: string; text: string }
  | { kind: "artifact-exists"; artifactKind: string }
  // Форма контрактной модальности: собранных записей не меньше указанного числа.
  // Модальность-нейтральна по существу — счётчик записей одинаково осмыслен
  // и для страницы, и для внешнего интерфейса.
  | { kind: "rows-at-least"; count: number }
  // Запись создана во внешней системе. Форма служит двум целям сразу: она
  // объявляет НАМЕРЕНИЕ совершить необратимое действие (и потому запускает
  // остановку на подтверждение) и она же проверяется наблюдением после него.
  | { kind: "record-created"; title: string };

/**
 * Разбор пункта DoD в проверку.
 *
 * Формы закрыты и записываются явно — человек (или LINA вместе с ним) пишет их
 * сознательно. Всё, что не разобрано, остаётся непроверяемым, и это нормальный
 * исход, а не ошибка человека.
 */
export function parseCheck(item: string): Check | null {
  const line = item.trim();
  let m = /^http-status\s+(\S+)\s*=\s*(\d{3})$/.exec(line);
  if (m) return { kind: "http-status", url: m[1]!, expect: Number(m[2]) };
  m = /^page-contains\s+(\S+)\s+"(.+)"$/.exec(line);
  if (m) return { kind: "page-contains", url: m[1]!, text: m[2]! };
  m = /^artifact-exists\s+([a-z-]+)$/.exec(line);
  if (m) return { kind: "artifact-exists", artifactKind: m[1]! };
  m = /^rows-at-least\s+(\d{1,6})$/.exec(line);
  if (m) return { kind: "rows-at-least", count: Number(m[1]) };
  m = /^record-created\s+"(.+)"$/.exec(line);
  if (m) return { kind: "record-created", title: m[1]! };
  return null;
}

export interface Observation {
  outcome: DodOutcome;
  method: string;
  artifactRef: string | null;
}

/** Наблюдатель: выполняет ОТДЕЛЬНЫЙ запрос состояния и возвращает исход. */
export type Observer = (check: Check) => Promise<Observation>;

export interface DodReport {
  entries: DodEntry[];
  allVerified: boolean;
  anyVerified: boolean;
  anyFailed: boolean;
}

export async function verifyDod(items: readonly string[], observe: Observer): Promise<DodReport> {
  const entries: DodEntry[] = [];
  for (const item of items) {
    const check = parseCheck(item);
    if (!check) {
      entries.push({
        item, outcome: "not_checked",
        method: "проверка не выражена машинно: требуется человек",
        artifact_ref: null,
      });
      continue;
    }
    const observed = await observe(check);
    entries.push({
      item, outcome: observed.outcome, method: observed.method, artifact_ref: observed.artifactRef,
    });
  }
  return {
    entries,
    allVerified: entries.length > 0 && entries.every((e) => e.outcome === "verified"),
    anyVerified: entries.some((e) => e.outcome === "verified"),
    anyFailed: entries.some((e) => e.outcome === "failed"),
  };
}

/**
 * Итоговый статус и причина по результатам проверки.
 *
 * `completed` требует, чтобы каждый пункт был подтверждён наблюдением; иначе
 * запуск не закрывается сам и доходит до человека. Причина обязательна для
 * всякого исхода, кроме `completed`, — она из закрытого перечня и говорит,
 * ЧТО именно помешало.
 */
export function outcomeFor(report: DodReport, actionsSucceeded: boolean): {
  status: "completed" | "partially_completed" | "blocked_awaiting_human" | "failed";
  reason: string | null;
} {
  if (!actionsSucceeded) return { status: "failed", reason: "execution.service_unavailable" };
  if (report.allVerified) return { status: "completed", reason: null };
  if (report.anyFailed && report.anyVerified) {
    return { status: "partially_completed", reason: "dod.partially_verified" };
  }
  if (report.anyFailed) return { status: "failed", reason: "dod.not_verifiable" };
  if (report.anyVerified) return { status: "partially_completed", reason: "dod.partially_verified" };
  return { status: "blocked_awaiting_human", reason: "dod.not_verifiable" };
}
