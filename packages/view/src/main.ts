/**
 * lpmc-view — привратник одноразового просмотра экрана браузера.
 *
 * Зачем он существует. Требование «ссылка одноразовая и не дублируется в другой
 * канал» (MITA §11) требует состояния, а nginx его не имеет. Дешёвая альтернатива
 * — подписанная ссылка со сроком — даёт ограничение по времени, но не
 * одноразовость: ею можно воспользоваться дважды. Заменять её потом означало бы
 * переделку, запрещённую D-013.
 *
 * Чего здесь нет намеренно: продления сеанса (нужно новое решение арбитра)
 * и массового гашения — интерфейс позволяет погасить только названный сеанс.
 */
import http from "node:http";
import { createAdminServer, listenOnSocket } from "./admin.js";
import { loadConfig } from "./config.js";
import { Gate } from "./gate.js";
import { SessionRegistry } from "./sessions.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const cfg = loadConfig(arg("config", "/etc/lpmc-system/view.json"));
const adminGroup = arg("admin-group", "");
const registry = new SessionRegistry();

listenOnSocket(createAdminServer(cfg, registry), cfg.adminSocket, adminGroup || undefined);
setInterval(() => registry.expireStale(new Date()), 5000).unref();

const server = http.createServer();
new Gate(cfg, registry).attach(server);
const [host, port] = cfg.listen.split(":") as [string, string];
server.listen(Number(port), host, () => {
  console.log(`привратник просмотра слушает ${cfg.listen}; владельцев: ${Object.keys(cfg.owners).length}`);
});
