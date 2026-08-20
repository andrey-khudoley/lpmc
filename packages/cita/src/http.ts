import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";

/**
 * HTTP-клиент контрактной модальности.
 *
 * Обращение идёт туннелем CONNECT — так же, как у браузера, и по той же причине:
 * адресат работает по TLS, а прокси обязан видеть метод и путь каждого запроса,
 * иначе allowlist по методу и пути ничего не значит. Прокси терминирует TLS
 * собственным сертификатом, поэтому клиент обязан доверять его удостоверяющему
 * центру (`NODE_EXTRA_CA_CERTS` в юните).
 *
 * Учётные данные прокси предъявляются на CONNECT — заголовком, потому что это
 * HTTP-клиент и он добавляет заголовки сам (D-019, первый способ). Дальше прокси
 * сверяет каждый запрос внутри туннеля с привязкой запуска.
 *
 * Опции «не проверять сертификат» здесь нет: её отсутствие — часть конструкции,
 * а не забывчивость (см. обоснование в конфигурации прокси).
 */
export interface ProxyCredentials {
  runId: string;
  secret: string;
  proxy: string;
}

export interface HttpOutcome {
  status: number;
  body: string;
}

export async function request(
  creds: ProxyCredentials,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 20000,
): Promise<HttpOutcome> {
  const target = new URL(url);
  const port = target.port !== "" ? Number(target.port) : 443;
  const socket = await connectTunnel(creds, target.hostname, port, timeoutMs);
  const payload = body === undefined ? undefined : Buffer.from(body, "utf8");

  return new Promise<HttpOutcome>((resolve, reject) => {
    // Готовый сокет туннеля передаётся запросу: в объявлениях Node это поле
    // описано для http, но не для https, хотя механизм один и тот же.
    const options = {
      socket,
      // Соединение уже установлено к нужному узлу; имя нужно для SNI и проверки
      // сертификата, который выпускает прокси на этот хост.
      servername: target.hostname,
      path: `${target.pathname}${target.search}`,
      method,
      agent: false,
      timeout: timeoutMs,
      headers: {
        ...headers,
        Host: target.host,
        ...(payload ? { "Content-Length": String(payload.length) } : {}),
      },
    } as https.RequestOptions & { socket: Socket };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("timeout", () => req.destroy(new Error("превышено время ожидания")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function connectTunnel(
  creds: ProxyCredentials, host: string, port: number, timeoutMs: number,
): Promise<Socket> {
  const [proxyHost, proxyPort] = creds.proxy.split(":");
  const auth = Buffer.from(`${creds.runId}:${creds.secret}`).toString("base64");
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyHost,
      port: Number(proxyPort ?? 3128),
      method: "CONNECT",
      path: `${host}:${port}`,
      timeout: timeoutMs,
      headers: { "Proxy-Authorization": `Basic ${auth}`, Host: `${host}:${port}` },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`прокси отказал в туннеле: ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on("timeout", () => req.destroy(new Error("превышено время ожидания туннеля")));
    req.on("error", reject);
    req.end();
  });
}
