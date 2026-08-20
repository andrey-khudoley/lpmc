import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Config } from "./config.js";
import type { SessionRegistry, ViewSession } from "./sessions.js";

const COOKIE = "lpmc_view";

/**
 * Привратник. Между человеком и экраном браузера стоит ровно он: nginx отдаёт
 * наружу один фиксированный путь и проксирует сюда, а решение «пустить или нет»
 * принимается здесь, по одноразовому токену.
 */
export class Gate {
  constructor(private readonly cfg: Config, private readonly reg: SessionRegistry) {}

  private parse(url: string): { token: string; rest: string } | undefined {
    const p = this.cfg.publicPathPrefix.replace(/\/$/, "");
    if (!url.startsWith(`${p}/`)) return undefined;
    const tail = url.slice(p.length + 1);
    const slash = tail.indexOf("/");
    const token = slash < 0 ? tail : tail.slice(0, slash);
    const rest = slash < 0 ? "/" : tail.slice(slash);
    return token ? { token, rest } : undefined;
  }

  private viewerId(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(";")) {
      const [k, v] = part.trim().split("=");
      if (k === COOKIE && v) return v;
    }
    return undefined;
  }

  private upstream(s: ViewSession): { host: string; port: number } | undefined {
    const addr = this.cfg.owners[s.owner];
    if (!addr) return undefined;
    const [host, port] = addr.split(":") as [string, string];
    return { host, port: Number(port) };
  }

  attach(server: http.Server): void {
    server.on("request", (req, res) => this.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    // Обрыв соединения зрителем — штатное событие. Без обработчика он завершил бы
    // весь процесс: в Node необработанное «error» на сокете фатально.
    server.on("connection", (s) => s.on("error", () => s.destroy()));
    server.on("clientError", (_e, s) => s.destroy());
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = this.parse(req.url ?? "");
    if (!parsed) { deny(res, 404, "404 нет такого пути"); return; }
    const viewer = this.viewerId(req.headers.cookie);
    const s = this.reg.claim(parsed.token, viewer, new Date());
    if (!s) {
      console.log(`просмотр отклонён token=${parsed.token.slice(0, 8)}… причина=недействителен_или_занят`);
      deny(res, 403, "403 ссылка недействительна, истекла или уже используется");
      return;
    }
    // Идентификатор зрителя выставляется СРАЗУ после заявки, до обращения
    // к апстриму, и потому попадает даже в ответ об ошибке. Иначе временная
    // недоступность просмотра сжигала бы одноразовую ссылку: сеанс уже заявлен
    // на сервере, а зритель не получил ничего, чем это подтвердить.
    if (!viewer && s.claimedBy) {
      res.setHeader(
        "Set-Cookie",
        `${COOKIE}=${s.claimedBy}; Path=${this.cfg.publicPathPrefix}${s.token}/; HttpOnly; SameSite=Strict`,
      );
      console.log(`просмотр заявлен владелец=${s.owner} до=${s.expires.toISOString()}`);
    }
    const up = this.upstream(s);
    if (!up) { deny(res, 503, "503 инстанс владельца недоступен"); return; }
    const proxied = http.request(
      { host: up.host, port: up.port, method: req.method, path: parsed.rest, headers: req.headers },
      (u) => { res.writeHead(u.statusCode ?? 502, u.headers); u.pipe(res); },
    );
    proxied.on("error", () => deny(res, 502, "502 просмотр недоступен"));
    req.pipe(proxied);
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const parsed = this.parse(req.url ?? "");
    const viewer = this.viewerId(req.headers.cookie);
    const s = parsed ? this.reg.claim(parsed.token, viewer, new Date()) : undefined;
    const up = s ? this.upstream(s) : undefined;
    if (!parsed || !s || !up) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }

    // Соединение учитывается за сеансом: гашение обязано рвать именно его,
    // а не ждать, пока зритель уйдёт сам.
    s.sockets.add(socket);
    socket.on("close", () => s.sockets.delete(socket));

    const upstream = net.connect(up.port, up.host, () => {
      const lines = [`GET ${parsed.rest} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => lines.push(`${k}: ${x}`));
        else if (v !== undefined) lines.push(`${k}: ${v}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  }
}

function deny(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
