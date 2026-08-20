import { readFileSync } from "node:fs";
import { connect, nkeyAuthenticator, type NatsConnection } from "nats";

export const DEFAULT_SERVER = "127.0.0.1:4222";

/**
 * Подключение к брокеру по nkey. Семя лежит в файле 0600, доступном только
 * системному пользователю компонента: права в брокере привязаны к учётной
 * записи, поэтому чтение семени равносильно получению этих прав.
 *
 * Имя подключения попадает в журнал брокера и в `nats server report connections`
 * — по нему видно, кто именно держит связь.
 */
export async function connectAs(
  name: string,
  seedPath: string,
  server: string = DEFAULT_SERVER,
): Promise<NatsConnection> {
  const seed = readFileSync(seedPath, "utf8").trim();
  return connect({
    servers: server,
    name,
    authenticator: nkeyAuthenticator(new TextEncoder().encode(seed)),
    // Разрыв связи с брокером не должен ронять процесс: ретранслятор обязан
    // пережить перезапуск брокера и продолжить с неотправленных строк.
    reconnect: true,
    maxReconnectAttempts: -1,
    waitOnFirstConnect: false,
  });
}
