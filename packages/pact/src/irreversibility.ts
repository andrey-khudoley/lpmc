/**
 * Обратимость операций (SPEC §12.3, W1-PACT-06).
 *
 * Тип операции вычисляется из НАБЛЮДАЕМЫХ признаков запроса, а не из намерения
 * исполнителя и не из описания задачи: намерение нельзя проверить, метод
 * запроса — можно.
 *
 * Правило умолчания перевёрнуто относительно привычного: отсутствие строки
 * означает «неизвестно», а неизвестное считается НЕОБРАТИМЫМ. Обычное умолчание
 * («не запрещено — значит можно») здесь означало бы, что любая операция, о
 * которой никто не подумал, выполняется без подтверждения.
 */
export type OperationType = "read" | "write" | "delete" | "unknown";

export interface IrreversibilityRule {
  rulesetVersion: number;
  host: string;
  operationType: string;
  classification: "reversible" | "irreversible";
}

/**
 * Чтение не меняет состояния и потому не может быть необратимым: обратимость
 * относится к изменению, а его здесь нет. Всё остальное считается изменением
 * до тех пор, пока таблица не скажет иного.
 */
export function operationType(method: string): OperationType {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return "read";
    case "POST":
    case "PUT":
    case "PATCH":
      return "write";
    case "DELETE":
      return "delete";
    default:
      return "unknown";
  }
}

export type Permission =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string };

/**
 * Разрешена ли операция на первой волне.
 *
 * Подтверждения человеком (approval) на W1 нет, поэтому необратимая операция
 * не откладывается на подтверждение, а запрещается. Когда approval появится,
 * изменится ЭТА функция, а не устройство таблицы — состав правил уже верный.
 */
export function permit(
  host: string, method: string, rules: readonly IrreversibilityRule[],
  statedType?: OperationType | "auto",
): Permission {
  // Тип берётся из таблицы разрешений, если он там назван явно: путь запроса —
  // такой же наблюдаемый признак, как метод, и «POST по пути .../query —
  // чтение» есть утверждение человека, а не догадка кода.
  const type = statedType !== undefined && statedType !== "auto"
    ? statedType : operationType(method);
  if (type === "read") return { allowed: true, reason: "operation.read" };

  const version = rules.length > 0 ? Math.max(...rules.map((r) => r.rulesetVersion)) : 0;
  const row = rules.find(
    (r) => r.rulesetVersion === version && r.host === host && r.operationType === type,
  );
  if (!row) {
    return { allowed: false, reason: `irreversibility.unknown:${host}:${type}` };
  }
  if (row.classification === "irreversible") {
    return { allowed: false, reason: `irreversibility.irreversible:${host}:${type}` };
  }
  return { allowed: true, reason: `irreversibility.reversible:${host}:${type}` };
}

/** Методы, которые можно включить в токен запуска для данного хоста. */
export function permittedMethods(
  host: string, methods: readonly string[], rules: readonly IrreversibilityRule[],
  statedType?: OperationType | "auto",
): { allowed: string[]; refused: { method: string; reason: string }[] } {
  const allowed: string[] = [];
  const refused: { method: string; reason: string }[] = [];
  for (const m of methods) {
    const p = permit(host, m, rules, statedType);
    if (p.allowed) allowed.push(m);
    else refused.push({ method: m, reason: p.reason });
  }
  return { allowed, refused };
}
