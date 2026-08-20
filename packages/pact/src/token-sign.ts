import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

/**
 * Подпись токена авторизации запуска (D-019).
 *
 * Формат — JWT с Ed25519, разбирает его прокси (files/egress/src/token.ts).
 * Библиотека JWT не используется по обе стороны намеренно: формат прост,
 * а лишняя зависимость в доверенном пути дороже сорока строк.
 */
export interface Allow {
  host: string;
  methods: string[];
  /** Разрешённые префиксы пути; пустой перечень означает «любой путь». */
  paths?: string[];
}

export interface RunToken {
  task_id: string;
  run_id: string;
  /** Принципал: исполнитель для запуска, имя службы для собственного обращения. */
  executor: string;
  lease_generation: number;
  exp: number;
  allow: Allow[];
  /** Запуск исполнителя или собственное обращение службы (например, к модели). */
  kind?: "run" | "service";
}

function b64url(b: Buffer): string {
  return b.toString("base64url");
}

export function signRunToken(payload: RunToken, keyPath: string): string {
  const key = createPrivateKey(readFileSync(keyPath, "utf8"));
  // Алгоритм фиксирован здесь и сверяется на стороне прокси: выбор алгоритма
  // не должен зависеть от содержимого токена.
  const header = b64url(Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const signature = sign(null, Buffer.from(`${header}.${body}`), key);
  return `${header}.${body}.${b64url(signature)}`;
}
