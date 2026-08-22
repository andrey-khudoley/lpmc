/**
 * lpmc-egress — единственный путь исполнителей системы LPMC во внешнюю сеть.
 *
 * Роль в архитектуре: механизм принуждения границы. У исполнителя нет прямого
 * исходящего доступа, весь его трафик проходит здесь, и на КАЖДОМ запросе
 * проверяются действующая привязка запуска, разрешённый хост и разрешённый метод —
 * в том числе внутри уже установленного туннеля, поэтому истечение лизинга или
 * его отзыв прекращают работу в середине выполнения.
 *
 * Чего в этой программе нет намеренно:
 *   - опции отключения проверки сертификата внешнего узла;
 *   - умолчания «разрешено»: пустой перечень запрещает всё;
 *   - обращения к PACT на каждом запросе: подпись проверяется один раз при
 *     создании привязки, иначе внешний вызов зависел бы от доступности арбитра.
 */
import http from "node:http";
import { dirname, join } from "node:path";
import { createAdminServer, listenOnSocket } from "./admin.js";
import { Registry } from "./bindings.js";
import { CertificateAuthority } from "./ca.js";
import { loadConfig } from "./config.js";
import { NodePolicy } from "./policy.js";
import { Proxy } from "./proxy.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const configPath = arg("config", "/etc/lpmc-system/egress.json");
const adminGroup = arg("admin-group", "");

const { config, pactPublicKey } = loadConfig(configPath);
const ca = CertificateAuthority.loadOrCreate(config.caCert, config.caKey);
const registry = new Registry();

// Снимок опубликованной политики лежит рядом с ключами прокси: каталог уже
// принадлежит пользователю прокси, а /etc принадлежит развёртыванию.
const policy = new NodePolicy(config.allow, join(dirname(config.caCert), "node-policy.json"));

const admin = createAdminServer(registry, pactPublicKey, policy);
listenOnSocket(admin, config.adminSocket, adminGroup || undefined);

// Истёкшие привязки снимаются и их соединения рвутся, даже если отзыв не пришёл:
// истечение лизинга обязано прекращать доступ само.
setInterval(() => registry.expireStale(new Date()), 5000).unref();

const server = http.createServer();
new Proxy(config, registry, ca, policy).attach(server);

const [host, port] = config.listen.split(":") as [string, string];
server.listen(Number(port), host, () => {
  console.log(
    `прокси слушает ${config.listen}; разрешённых хостов в политике узла: ${policy.current().length}`,
  );
  if (policy.current().length === 0) {
    console.log("политика узла пуста — запрещены все внешние обращения");
  }
});
