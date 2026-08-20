/**
 * Критерий полноты запроса (LINA §6).
 *
 * Полнота — единственное решение, которое LINA принимает и которое влияет на
 * дальнейшую обработку (L-6). Она НЕ означает ни выполнимости, ни допустимости,
 * ни классификации: отклонить кандидата вправе приём задачи и политика PACT.
 *
 * Функция чистая и не видит текста сообщения: она смотрит только на собранные
 * поля. Это не удобство, а требование — решение о полноте не должно зависеть от
 * формулировок во входящем тексте.
 */
export const REQUIRED_FIELDS = ["objective", "owner", "dod"] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export interface Draft {
  objective: string | null;
  ownerHint: string | null;
  dod: string[] | null;
  replyRouteId: string | null;
}

/**
 * Чего не хватает. Порядок важен: спрашиваем в том же порядке, в каком поля
 * перечислены, чтобы диалог был предсказуем и воспроизводим в тестах.
 *
 * `dod` требуется всегда. Источник (§6.2) допускает его отсутствие, если задача
 * не предполагает фактически проверяемого результата, но определить это можно
 * лишь суждением, которого у первой версии нет. Требовать всегда — строже
 * источника и потому безопасно: лишний вопрос человеку хуже, чем задача без
 * критерия приёмки, только по удобству.
 */
export function missingFields(d: Draft): RequiredField[] {
  const missing: RequiredField[] = [];
  if (!d.objective || d.objective.trim() === "") missing.push("objective");
  if (!d.ownerHint || d.ownerHint.trim() === "") missing.push("owner");
  if (!d.dod || d.dod.length === 0) missing.push("dod");
  return missing;
}

/** Запрос полон, когда нет недостающих полей И есть маршрут ответа. */
export function isComplete(d: Draft): boolean {
  return missingFields(d).length === 0 && d.replyRouteId !== null;
}

/**
 * Вопрос по недостающему полю. Текст фиксирован и не собирается моделью:
 * первая версия обязана быть воспроизводимой, а вопрос — одинаковым при
 * одинаковом состоянии диалога.
 */
export function questionFor(field: RequiredField): string {
  switch (field) {
    case "objective":
      return "Что нужно сделать? Сформулируйте цель обращения.";
    case "owner":
      return "К какому владельцу относится обращение: клиент, проект или внутренний контур? Укажите слаг.";
    case "dod":
      return "По какому признаку считать работу выполненной? Перечислите критерии приёмки.";
  }
}
