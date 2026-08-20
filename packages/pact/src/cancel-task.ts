import { createPool } from "@lpmc/runtime";
import { TaskRegistry } from "./registry.js";
import { isTerminal } from "./states.js";
import type { TaskState } from "@lpmc/contracts";

/**
 * Отмена задачи человеком.
 *
 * Переход выполняется тем же механизмом, что и любой другой: через автомат
 * состояний и с записью в журнале вердиктов. Прямое обновление таблицы было бы
 * короче, но оставило бы задачу в состоянии, которого никто не назначал,
 * и без причины — а весь смысл журнала в том, чтобы на вопрос «почему задача
 * в этом состоянии» отвечал он, а не память человека.
 *
 * Причина обязательна и записывается дословно. События отмены задачи в контракте
 * нет: `requests.cancelled.v1` — это отмена ОБРАЩЕНИЯ со стороны канала, а не
 * решение арбитра по задаче. Поэтому наружу отсюда ничего не публикуется,
 * и человек, приславший обращение, уведомления не получит.
 */
async function main(): Promise<void> {
  const [taskId, ...rest] = process.argv.slice(2);
  const reason = rest.join(" ").trim();
  if (!taskId || !reason) {
    console.error("использование: cancel-task <task_id> <причина>");
    process.exit(2);
  }
  const pool = createPool();
  try {
    const r = await pool.query<{ state: TaskState }>(
      "SELECT state FROM tasks WHERE task_id = $1", [taskId]);
    const state = r.rows[0]?.state;
    if (!state) {
      console.error(`задача ${taskId} не найдена`);
      process.exit(1);
    }
    if (isTerminal(state)) {
      console.log(`задача ${taskId} уже в терминальном состоянии ${state}: ничего не делаем`);
      return;
    }
    const registry = new TaskRegistry(pool);
    await registry.transition(taskId, "CANCELLED", {
      toState: "CANCELLED",
      reason: `operator.cancelled: ${reason}`,
    });
    console.log(`задача ${taskId}: ${state} → CANCELLED (${reason})`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`отмена не выполнена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
