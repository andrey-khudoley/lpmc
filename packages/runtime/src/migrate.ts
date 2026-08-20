import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool, inTransaction } from "./db.js";

/**
 * Применение миграций. Каждая применяется один раз и записывается: схема базы —
 * такой же предмет изменения по диффу, как таблицы правил (D-027).
 *
 * Общий код, но не общая таблица: каждый компонент ведёт свой журнал миграций
 * в собственной схеме. Иначе один компонент видел бы историю изменений другого,
 * а права выданы так, что чужая схема недоступна даже на чтение.
 */
export async function migrate(migrationsDir: string): Promise<string[]> {
  const pool = createPool();
  const applied: string[] = [];
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
      if (done.rowCount) continue;
      await inTransaction(pool, async (c) => {
        await c.query(readFileSync(join(migrationsDir, f), "utf8"));
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      });
      applied.push(f);
    }
    return applied;
  } finally {
    await pool.end();
  }
}

/** Печать итога миграций одинакова у всех компонентов, поэтому живёт здесь. */
export function reportMigrations(applied: string[]): void {
  console.log(applied.length ? `применены миграции: ${applied.join(", ")}` : "миграции не требуются");
}
