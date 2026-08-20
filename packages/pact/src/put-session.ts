import { createPool } from "@lpmc/runtime";
import { isLegalHeaderValue } from "./header-value.js";
import { loadMasterKey, seal } from "./secrets.js";

/**
 * Внесение снимка сессии внешней системы. Инструмент оператора.
 *
 * Значение читается со стандартного ввода: аргументы командной строки видны
 * в списке процессов всем пользователям узла.
 *
 * Признак «отфильтрован по домену» указывается явно и не угадывается. Если
 * снимок сузить до одного домена не удалось, это допускается (P2-DEC-02), но
 * расширенный радиус поражения обязан быть назван словами — он попадёт
 * в журнал каждой выдачи и в вердикт.
 */
async function main(): Promise<void> {
  const [owner, host, filteredRaw, ...rest] = process.argv.slice(2);
  const blastRadius = rest.join(" ").trim();
  if (!owner || !host || (filteredRaw !== "да" && filteredRaw !== "нет")) {
    console.error("использование: put-session <владелец> <хост> <да|нет> [радиус поражения] < снимок");
    process.exit(2);
  }
  const filtered = filteredRaw === "да";
  if (!filtered && blastRadius === "") {
    console.error("снимок не отфильтрован по домену: назовите радиус поражения словами");
    process.exit(2);
  }

  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value === "") {
    console.error("пустой снимок не принимается");
    process.exit(2);
  }
  // Отказ здесь, а не у прокси в середине запуска. Само значение в сообщении
  // не приводится: оно секрет, а оператор и так держит его перед глазами.
  if (!isLegalHeaderValue(value)) {
    console.error("снимок непригоден как значение заголовка Cookie:"
      + " допустимы табуляция и печатные символы latin1."
      + " Перевод строки, управляющие символы и буквы вне latin1 недопустимы");
    process.exit(2);
  }

  const pool = createPool();
  try {
    const sealed = seal(value, loadMasterKey(
      process.env["LPMC_MASTER_KEY"] ?? "/var/lib/lpmc-system/pact/keys/master.key"));
    await pool.query(
      `INSERT INTO session_snapshots (owner_slug, host, domain_filtered, blast_radius,
         wrapped_key, wrapped_key_iv, wrapped_key_tag, ciphertext, iv, tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (owner_slug, host) DO UPDATE SET
         domain_filtered = EXCLUDED.domain_filtered, blast_radius = EXCLUDED.blast_radius,
         wrapped_key = EXCLUDED.wrapped_key, wrapped_key_iv = EXCLUDED.wrapped_key_iv,
         wrapped_key_tag = EXCLUDED.wrapped_key_tag, ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv, tag = EXCLUDED.tag, revoked_at = NULL`,
      [owner, host, filtered, filtered ? "один домен" : blastRadius,
       sealed.wrappedKey, sealed.wrappedKeyIv, sealed.wrappedKeyTag,
       sealed.ciphertext, sealed.iv, sealed.tag]);
    console.log(`снимок сессии ${host} внесён для владельца ${owner}`
      + (filtered ? "" : `; радиус поражения: ${blastRadius}`));
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`снимок не внесён: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
