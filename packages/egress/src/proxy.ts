import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { CertificateAuthority } from "./ca.js";
import { permits, type Config } from "./config.js";
import { isLegalHeaderValue } from "./header.js";
import type { Binding, Registry } from "./bindings.js";

/**
 * Прокси — единственный путь исполнителя во внешнюю сеть.
 *
 * Проверка выполняется НА КАЖДОМ ЗАПРОСЕ, а не один раз на соединение: срок
 * лизинга, разрешённый хост и разрешённый метод сверяются перед каждым запросом,
 * включая запросы внутри уже установленного туннеля. Это и означает «запрос после
 * истечения лизинга отклоняется в середине выполнения» (CONTOURS §8.2).
 */
export class Proxy {
  constructor(
    private readonly cfg: Config,
    private readonly reg: Registry,
    private readonly ca: CertificateAuthority,
  ) {}

  /** Внутренний сервер разбирает запросы, идущие внутри терминированного туннеля. */
  private readonly inner = http.createServer();

  private log(b: Binding | undefined, host: string, method: string, path: string, outcome: string): void {
    // Журнал внешних вызовов в одном месте (CONTOURS §8.2). Тела запросов
    // и ответов не записываются: они могут содержать значения секретов.
    console.log(
      `вызов run=${b?.runId ?? "-"} task=${b?.taskId ?? "-"} host=${host} ` +
        `method=${method} path=${path} исход=${outcome}`,
    );
  }

  /**
   * Достаёт привязку по Proxy-Authorization. Для браузера имя пользователя —
   * run_id, пароль — секрет запуска (решение D-019): браузер не добавляет
   * произвольные заголовки к своим запросам, а учётные данные прокси подставляет
   * сам ко всем, включая подресурсы.
   */
  private authenticate(headerValue: string | undefined): Binding {
    if (!headerValue) throw new Error("нет Proxy-Authorization");
    if (!headerValue.startsWith("Basic ")) throw new Error("поддерживается только Basic");
    const decoded = Buffer.from(headerValue.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) throw new Error("Proxy-Authorization без разделителя");
    const runId = decoded.slice(0, idx);
    const secret = decoded.slice(idx + 1);
    const b = this.reg.lookup(runId, secret, new Date());
    if (!b) throw new Error("привязка не найдена, истекла или секрет не совпал");
    return b;
  }

  /**
   * Двойная проверка: запрос обязан удовлетворять и внешней границе политики узла
   * (конфигурация), и набору из токена этого запуска. Пустой перечень в любом
   * из двух означает запрет.
   */
  private permit(b: Binding, host: string, method: string, path?: string): boolean {
    return permits(this.cfg.allow, host, method, path) && permits(b.allow, host, method, path);
  }

  attach(server: http.Server): void {
    server.on("request", (req, res) => this.onPlainRequest(req, res));
    server.on("connect", (req, socket, head) => this.onConnect(req, socket, head));
    this.inner.on("request", (req, res) => this.onTunnelRequest(req, res));

    // Обрыв соединения клиентом — штатное событие, а не отказ прокси. В Node
    // необработанное событие «error» на сокете валит ВЕСЬ процесс, поэтому
    // обработчики обязательны на каждом соединении обоих серверов: иначе
    // закрытая вкладка браузера останавливает механизм принуждения границы
    // для всей системы. (Проверено: без этого ECONNRESET завершал процесс.)
    const drop = (socket: Duplex) => {
      socket.on("error", () => socket.destroy());
    };
    server.on("connection", drop);
    this.inner.on("connection", drop);
    server.on("clientError", (_e, socket) => socket.destroy());
    this.inner.on("clientError", (_e, socket) => socket.destroy());
  }

  private onPlainRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = hostOnly(req.headers.host ?? "");
    let b: Binding;
    try {
      b = this.authenticate(req.headers["proxy-authorization"]);
    } catch (e) {
      this.log(undefined, host, req.method ?? "-", req.url ?? "-", `отказ: ${msg(e)}`);
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="lpmc-egress"' });
      res.end("407 требуется авторизация прокси");
      return;
    }
    if (!this.permit(b, host, req.method ?? "", req.url)) {
      this.log(b, host, req.method ?? "-", req.url ?? "-", "отказ: вне разрешённого набора");
      res.writeHead(403);
      res.end("403 хост или метод не разрешены");
      return;
    }
    this.forward(b, host, "http:", req, res);
  }

  /**
   * Терминирует TLS собственным сертификатом и обрабатывает каждый запрос внутри
   * туннеля отдельно. Без терминирования прокси видел бы только «CONNECT host:443»
   * и НЕ ВИДЕЛ БЫ МЕТОДА — а allowlist по методу является принятым требованием,
   * поэтому непрозрачный туннель недопустим.
   */
  private onConnect(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const host = hostOnly(req.url ?? "");
    let b: Binding;
    try {
      b = this.authenticate(req.headers["proxy-authorization"]);
    } catch (e) {
      this.log(undefined, host, "CONNECT", "-", `отказ: ${msg(e)}`);
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="lpmc-egress"\r\n\r\n',
      );
      return;
    }
    // На этапе CONNECT метод внутренних запросов ещё неизвестен, поэтому здесь
    // проверяется только хост: он обязан быть разрешён хотя бы для одного метода.
    if (!hostKnown(this.cfg.allow, host) || !hostKnown(b.allow, host)) {
      this.log(b, host, "CONNECT", "-", "отказ: хост вне разрешённого набора");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n403 хост не разрешён");
      return;
    }

    b.sockets.add(socket);
    socket.on("close", () => b.sockets.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const leaf = this.ca.leaf(host);
    // ALPN только http/1.1: HTTP/2 не предлагается сознательно — это убирает
    // самую сложную часть перехвата почти без потерь в работоспособности.
    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
      ALPNProtocols: ["http/1.1"],
    });
    tlsSocket.on("error", () => socket.destroy());
    if (head.length > 0) tlsSocket.unshift(head);

    // Признаки запуска переносятся на сокет: внутренний сервер не видит CONNECT
    // и должен узнать, кому принадлежит соединение и к какому хосту оно ведёт.
    Object.assign(tlsSocket, { lpmcRunId: b.runId, lpmcHost: host });
    this.inner.emit("connection", tlsSocket);
  }

  private onTunnelRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sock = req.socket as unknown as { lpmcRunId?: string; lpmcHost?: string };
    const host = sock.lpmcHost ?? "";
    const runId = sock.lpmcRunId ?? "";
    const method = req.method ?? "";

    // Повторная сверка для КАЖДОГО запроса внутри туннеля: привязка могла быть
    // отозвана, а лизинг — истечь уже после того, как соединение установлено.
    const b = this.reg.get(runId);
    if (!b) {
      this.log(undefined, host, method, req.url ?? "-", "отказ: привязка отозвана");
      res.writeHead(403);
      res.end("403 привязка отозвана");
      req.socket.destroy();
      return;
    }
    if (new Date() > b.expires) {
      this.log(b, host, method, req.url ?? "-", "отказ: лизинг истёк в середине выполнения");
      res.writeHead(403);
      res.end("403 лизинг истёк");
      req.socket.destroy();
      return;
    }
    if (!this.permit(b, host, method, req.url)) {
      this.log(b, host, method, req.url ?? "-", "отказ: метод или путь вне разрешённого набора");
      res.writeHead(403);
      res.end("403 метод или путь не разрешены");
      return;
    }
    this.forward(b, host, "https:", req, res);
  }

  /**
   * Подстановка снимка сессии (W2-MITA-01).
   *
   * Заголовок, пришедший от браузера, ЗАМЕНЯЕТСЯ, а не дополняется: браузер
   * не должен уметь добавить к сессии владельца что-то своё, а исполнитель —
   * подсмотреть подставленное. Если снимка на этот хост нет, заголовок Cookie
   * удаляется вовсе: пустая сессия честнее случайной.
   *
   * Непригодное значение НЕ подставляется, и запрос на этом заканчивается
   * отказом: подставить его означало бы снять процесс целиком (см. `header.ts`),
   * а отправить запрос без сессии — молча сходить наружу от чужого имени и
   * получить чужой ответ. Отказ возвращает `false`; само значение никуда не
   * записывается, в том числе в журнал, потому что оно секрет.
   */
  private applySession(b: Binding, host: string, headers: http.IncomingHttpHeaders): boolean {
    const value = b.cookies?.[host.toLowerCase()];
    if (value === undefined) {
      delete headers.cookie;
      return true;
    }
    if (!isLegalHeaderValue(value)) {
      delete headers.cookie;
      return false;
    }
    headers.cookie = value;
    return true;
  }

  private forward(
    b: Binding,
    host: string,
    protocol: "http:" | "https:",
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const path = req.url ?? "/";
    // Сессия владельца подставляется здесь, на пути запроса: ни исполнитель,
    // ни браузер её значения не видят.
    if (!this.applySession(b, host, headers)) {
      this.log(b, host, req.method ?? "-", path,
        "отказ: снимок сессии непригоден как значение заголовка");
      if (!res.headersSent) res.writeHead(502);
      res.end("502 снимок сессии непригоден");
      return;
    }

    const options: https.RequestOptions = {
      protocol,
      host,
      port: protocol === "https:" ? 443 : 80,
      method: req.method,
      path,
      headers,
      // rejectUnauthorized НЕ выставляется в false ни здесь, ни где-либо ещё:
      // сертификат внешнего узла проверяется по системным корневым центрам всегда,
      // и отключить это конфигурацией нельзя.
      minVersion: "TLSv1.2",
    };
    const client = protocol === "https:" ? https : http;
    res.on("error", () => res.destroy());
    // Построение запроса отделено от его отправки, потому что бросает оно
    // синхронно: `upstream.on("error")` ниже к моменту броска ещё не навешен и
    // такую ошибку не увидит. Перечислять причины здесь незачем — прокси обязан
    // отказывать, а не падать, независимо от того, чем именно плох заголовок.
    let upstream: http.ClientRequest;
    try {
      upstream = client.request(options, (up) => {
        up.on("error", () => res.destroy());
        this.log(b, host, req.method ?? "-", path, String(up.statusCode));
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
    } catch (e) {
      this.log(b, host, req.method ?? "-", path, `отказ: запрос не построен: ${msg(e)}`);
      if (!res.headersSent) res.writeHead(502);
      res.end("502 запрос не построен");
      return;
    }
    upstream.on("error", (e) => {
      this.log(b, host, req.method ?? "-", path, `отказ апстрима: ${msg(e)}`);
      if (!res.headersSent) res.writeHead(502);
      res.end("502 внешний узел недоступен или сертификат не прошёл проверку");
    });
    req.pipe(upstream);
  }
}

function hostOnly(hostport: string): string {
  const i = hostport.lastIndexOf(":");
  if (i > 0 && !hostport.slice(i + 1).includes("]")) return hostport.slice(0, i);
  return hostport;
}

function hostKnown(list: { host: string; methods: string[] }[], host: string): boolean {
  return list.some((a) => a.host.toLowerCase() === host.toLowerCase() && a.methods.length > 0);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
