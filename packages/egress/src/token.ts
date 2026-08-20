import { createPublicKey, verify } from "node:crypto";
import type { Allow } from "./config.js";

/**
 * Полезная нагрузка подписанного PACT токена авторизации запуска (решение D-019).
 * Состав полей закреплён там же: задача, запуск, исполнитель, поколение лизинга,
 * момент истечения и отпечаток разрешённого набора.
 */
export interface Token {
  task_id: string;
  run_id: string;
  executor: string;
  lease_generation: number;
  exp: number;
  allow: Allow[];
  /** Вид принципала: запуск исполнителя или собственное обращение службы. */
  kind: "run" | "service";
}

/**
 * Закрытый перечень исполнителей (решение D-018). Нормализация запрещена:
 * приведение регистра, обрезка пробелов и исправление опечаток отменяют смысл
 * перечня, потому что снова делают опечатку тихой.
 */
const KNOWN_EXECUTORS = new Set(["mita", "cita"]);

/**
 * Закрытый перечень служб, которым разрешены СОБСТВЕННЫЕ внешние обращения —
 * в первую очередь к API модели (D-026: исключений из правила «через прокси» нет).
 *
 * Перечень отдельный от исполнителей намеренно. Служба не исполняет задачу, у неё
 * нет лизинга и нет владельца; смешать её с исполнителями означало бы разрешить
 * обращение «от имени запуска», которого не существует, — и тогда запись
 * в журнале прокси перестала бы указывать на настоящий источник.
 */
const KNOWN_SERVICES = new Set(["lina", "pact", "mita", "cita"]);

/** Фиксированный префикс SPKI для Ed25519: так «сырые» 32 байта становятся ключом. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519PublicKey(raw: Buffer) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Разбор и проверка токена формата JWT с подписью Ed25519. Библиотека проверки
 * JWT не используется: формат достаточно прост, а лишняя зависимость в доверенном
 * пути дороже сорока строк разбора.
 */
export function verifyToken(rawToken: string, pub: Buffer, now: Date): Token {
  const parts = rawToken.split(".");
  if (parts.length !== 3) {
    throw new Error(`токен: ожидались три части, получено ${parts.length}`);
  }
  const [h, p, s] = parts as [string, string, string];

  const header = JSON.parse(b64urlToBuffer(h).toString("utf8")) as { alg?: string };
  // Алгоритм сверяется с ожидаемым, а не берётся из токена: иначе предъявивший
  // токен выбирал бы способ его проверки, включая «alg: none».
  if (header.alg !== "EdDSA") {
    throw new Error(`токен: алгоритм ${String(header.alg)} не поддерживается, ожидается EdDSA`);
  }

  const ok = verify(null, Buffer.from(`${h}.${p}`), ed25519PublicKey(pub), b64urlToBuffer(s));
  if (!ok) {
    throw new Error("токен: подпись не соответствует ключу PACT");
  }

  const t = JSON.parse(b64urlToBuffer(p).toString("utf8")) as Partial<Token>;
  const kind = t.kind ?? "run";
  if (kind !== "run" && kind !== "service") {
    throw new Error(`токен: вид принципала ${String(t.kind)} неизвестен`);
  }
  if (!t.run_id) throw new Error("токен: обязателен run_id");
  if (kind === "run") {
    if (!t.task_id) throw new Error("токен: для запуска обязателен task_id");
    if (!t.executor || !KNOWN_EXECUTORS.has(t.executor)) {
      throw new Error(`токен: исполнитель ${String(t.executor)} вне закрытого перечня`);
    }
  } else if (!t.executor || !KNOWN_SERVICES.has(t.executor)) {
    throw new Error(`токен: служба ${String(t.executor)} вне закрытого перечня`);
  }
  if (!t.exp) throw new Error("токен: обязателен exp");
  if (Math.floor(now.getTime() / 1000) >= t.exp) throw new Error("токен: истёк");
  if (!t.allow || t.allow.length === 0) {
    throw new Error("токен: пустой разрешённый набор — исполнять нечего");
  }
  return {
    task_id: t.task_id ?? "",
    run_id: t.run_id,
    executor: t.executor,
    lease_generation: t.lease_generation ?? 0,
    exp: t.exp,
    allow: t.allow,
    kind,
  };
}
