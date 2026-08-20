import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, reportMigrations } from "@lpmc/runtime";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

migrate(migrationsDir)
  .then(reportMigrations)
  .catch((e: unknown) => {
    console.error(`миграции не применены: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
