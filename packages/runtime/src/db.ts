import pg from "pg";

/**
 * Подключение к базе. Пароля нет и быть не может: аутентификация peer через
 * unix-сокет (D-024). Личность подключающегося удостоверяет ядро по uid процесса,
 * поэтому красть нечего и ротировать нечего. Отсюда же следует, что процесс,
 * работающий не под своим пользователем, к своей схеме не подключится.
 */
export function createPool(): pg.Pool {
  return new pg.Pool({
    host: "/var/run/postgresql",
    database: process.env.LPMC_DB ?? "lpmc",
    max: 8,
  });
}

/** Транзакция: либо всё, либо ничего. Именно на этом держится outbox. */
export async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
