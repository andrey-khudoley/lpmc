import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";

/**
 * Конвертное шифрование секретов (D-024).
 *
 * Значение шифруется ключом данных, ключ данных — главным ключом. Главный ключ
 * лежит файлом 0600 вне базы и вне её резервных копий: дамп базы не раскрывает
 * ни одного значения, а ротация главного ключа перешифровывает только ключи
 * данных и потому занимает секунды.
 *
 * AES-256-GCM, а не CBC: режим с проверкой целостности не позволяет подменить
 * шифротекст незаметно. Подмена значения секрета — это подмена того, чем
 * система удостоверяется во внешней системе.
 */
const ALGO = "aes-256-gcm";

export interface SealedValue {
  wrappedKey: Buffer;
  wrappedKeyIv: Buffer;
  wrappedKeyTag: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function loadMasterKey(path: string): Buffer {
  const key = readFileSync(path);
  if (key.length !== 32) {
    throw new Error(`главный ключ обязан быть 32 байта, получено ${key.length}`);
  }
  return key;
}

export function seal(value: string, masterKey: Buffer): SealedValue {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, dataKey, iv);
  const ciphertext = Buffer.concat([c.update(value, "utf8"), c.final()]);

  const wrappedKeyIv = randomBytes(12);
  const w = createCipheriv(ALGO, masterKey, wrappedKeyIv);
  const wrappedKey = Buffer.concat([w.update(dataKey), w.final()]);

  return {
    wrappedKey, wrappedKeyIv, wrappedKeyTag: w.getAuthTag(),
    ciphertext, iv, tag: c.getAuthTag(),
  };
}

export function open(sealed: SealedValue, masterKey: Buffer): string {
  const w = createDecipheriv(ALGO, masterKey, sealed.wrappedKeyIv);
  w.setAuthTag(sealed.wrappedKeyTag);
  const dataKey = Buffer.concat([w.update(sealed.wrappedKey), w.final()]);

  const c = createDecipheriv(ALGO, dataKey, sealed.iv);
  c.setAuthTag(sealed.tag);
  return Buffer.concat([c.update(sealed.ciphertext), c.final()]).toString("utf8");
}

export type SecretOutcome =
  | { granted: true; value: string }
  | { granted: false; reason: string };

/**
 * Выдача значения секрета исполнителю.
 *
 * Порядок здесь важнее содержания: запись в журнал делается ДО ответа и
 * одинаково при выдаче и при отказе. Журнал, который пишется только при успехе,
 * не отличает «никто не просил» от «просили и не дали».
 *
 * На первой волне реестр имён пуст, поэтому любой запрос заканчивается отказом.
 * Это не заглушка: путь целиком настоящий, включая расшифровку, — не хватает
 * только записей.
 */
export async function issueSecret(
  pool: pg.Pool,
  req: { name: string; runId: string | null; leaseId: string | null; requestedBy: string; ownerSlug: string },
  masterKeyPath: string,
): Promise<SecretOutcome> {
  const log = async (outcome: string, reason: string): Promise<void> => {
    await pool.query(
      `INSERT INTO secret_access_log (name, run_id, lease_id, requested_by, outcome, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.name, req.runId, req.leaseId, req.requestedBy, outcome, reason]);
  };

  const registered = await pool.query<{ owner_slug: string }>(
    "SELECT owner_slug FROM secret_names WHERE name = $1", [req.name]);
  const row = registered.rows[0];
  if (!row) {
    await log("DENIED", "secret.unknown_name");
    return { granted: false, reason: "secret.unknown_name" };
  }
  // Секрет принадлежит владельцу. Запуск в скоупе одного владельца не получает
  // секрет другого, даже если знает его имя.
  if (row.owner_slug !== req.ownerSlug) {
    await log("DENIED", "secret.foreign_owner");
    return { granted: false, reason: "secret.foreign_owner" };
  }

  const stored = await pool.query<{
    wrapped_key: Buffer; wrapped_key_iv: Buffer; wrapped_key_tag: Buffer;
    ciphertext: Buffer; iv: Buffer; tag: Buffer;
  }>(
    `SELECT wrapped_key, wrapped_key_iv, wrapped_key_tag, ciphertext, iv, tag
       FROM secret_values WHERE name = $1`, [req.name]);
  const v = stored.rows[0];
  if (!v) {
    // Имя зарегистрировано, значения нет: отказ, а не пустая строка. Пустая
    // строка выглядела бы как выданный секрет и молча ломала бы внешний вызов.
    await log("DENIED", "secret.no_value");
    return { granted: false, reason: "secret.no_value" };
  }

  const value = open({
    wrappedKey: v.wrapped_key, wrappedKeyIv: v.wrapped_key_iv, wrappedKeyTag: v.wrapped_key_tag,
    ciphertext: v.ciphertext, iv: v.iv, tag: v.tag,
  }, loadMasterKey(masterKeyPath));
  await log("GRANTED", "secret.issued");
  return { granted: true, value };
}
