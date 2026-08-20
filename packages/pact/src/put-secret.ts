import { createPool } from "@lpmc/runtime";
import { loadMasterKey, seal } from "./secrets.js";

/**
 * Внесение секрета в custody. Инструмент оператора, а не службы: значение
 * приходит от человека и никогда не появляется само.
 *
 * Значение читается со стандартного ввода, а не из аргумента: аргументы видны
 * в списке процессов всем пользователям узла и попадают в историю оболочки.
 */
async function main(): Promise<void> {
  const [name, owner, purpose] = process.argv.slice(2);
  if (!name || !owner) {
    console.error("использование: put-secret <имя> <владелец> [назначение] < значение");
    process.exit(2);
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const value = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
  if (value === "") {
    console.error("пустое значение не принимается: отсутствие секрета выражается его отсутствием");
    process.exit(2);
  }

  const pool = createPool();
  try {
    const sealed = seal(value, loadMasterKey(
      process.env["LPMC_MASTER_KEY"] ?? "/var/lib/lpmc-system/pact/keys/master.key"));
    await pool.query(
      `INSERT INTO secret_names (name, owner_slug, purpose) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET owner_slug = EXCLUDED.owner_slug, purpose = EXCLUDED.purpose`,
      [name, owner, purpose ?? "не указано"]);
    await pool.query(
      `INSERT INTO secret_values (name, wrapped_key, wrapped_key_iv, wrapped_key_tag, ciphertext, iv, tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (name) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key,
         wrapped_key_iv = EXCLUDED.wrapped_key_iv, wrapped_key_tag = EXCLUDED.wrapped_key_tag,
         ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()`,
      [name, sealed.wrappedKey, sealed.wrappedKeyIv, sealed.wrappedKeyTag,
       sealed.ciphertext, sealed.iv, sealed.tag]);
    console.log(`секрет ${name} внесён для владельца ${owner}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`секрет не внесён: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
