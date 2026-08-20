import { readFileSync } from "node:fs";

export interface Config {
  /** Адрес привратника: слушает только loopback, наружу его выставляет nginx. */
  listen: string;
  adminSocket: string;
  /** Владелец → адрес websockify его браузерного инстанса. */
  owners: Record<string, string>;
  /** Срок сеанса по умолчанию. Продление не предусмотрено: нужен новый сеанс. */
  sessionTtlSeconds: number;
  /** Внешний путь, по которому nginx отдаёт привратника. */
  publicPathPrefix: string;
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  if (!raw.listen || !raw.adminSocket || !raw.owners || !raw.publicPathPrefix) {
    throw new Error(`${path}: обязательны listen, adminSocket, owners, publicPathPrefix`);
  }
  return {
    listen: raw.listen,
    adminSocket: raw.adminSocket,
    owners: raw.owners,
    sessionTtlSeconds: raw.sessionTtlSeconds ?? 1800,
    publicPathPrefix: raw.publicPathPrefix,
  };
}
