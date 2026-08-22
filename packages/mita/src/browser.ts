import http from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/**
 * Браузер как единственный способ MITA выйти наружу.
 *
 * Браузер работает под ОТДЕЛЬНЫМ пользователем и исполнителю недоступен на
 * чтение: в профиле лежат cookie внешних систем, и исполнитель не должен видеть
 * их даже случайно. Связь — по CDP на loopback, порт закрыт правилом файрвола
 * для всех, кроме исполнителя.
 *
 * Учётные данные прокси подставляются НА ЗАПУСК (D-019, вариант A): браузер сам
 * добавляет их ко всем запросам, включая подресурсы, тогда как заголовок,
 * добавленный вручную, к подресурсам не попал бы — и часть трафика пошла бы
 * мимо авторизации.
 */
export interface RunCredentials {
  runId: string;
  secret: string;
  proxy: string;
}

export interface PageObservation {
  url: string;
  status: number | null;
  title: string;
  text: string;
}

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(
    private readonly cdpUrl: string,
    private readonly creds: RunCredentials,
  ) {}

  async open(): Promise<void> {
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    const existing = this.browser.contexts()[0];
    if (!existing) throw new Error("браузер не отдал контекст по CDP");
    this.context = existing;
    // Ответ на запрос прокси об авторизации: имя пользователя — идентификатор
    // запуска, пароль — секрет запуска. Значение живёт только здесь и в памяти
    // прокси (хешем); ни в профиль, ни в тетрадь оно не попадает.
    await this.context.setHTTPCredentials({ username: this.creds.runId, password: this.creds.secret });
  }

  async read(url: string, timeoutMs = 20000): Promise<PageObservation> {
    const page = await this.newPage();
    try {
      const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      return {
        url: page.url(),
        status: response?.status() ?? null,
        title: await page.title(),
        text: (await page.locator("body").innerText()).slice(0, 20000),
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Извлечение значения со страницы. Содержимое остаётся недоверенным: значение
   * возвращается как ДАННЫЕ (и дальше маскируется и передаётся человеку), оно
   * никогда не становится указанием исполнителю.
   *
   * `what.kind === "heading"` — первый непустой заголовок h1…h6 (а если их нет,
   * заголовок документа); `"match"` — первое совпадение регулярного выражения по
   * тексту страницы. Регулярное выражение исполняется в Node, а не в странице:
   * так недоверенная страница не влияет на разбор.
   */
  async extract(url: string, what: { kind: "heading" } | { kind: "match"; pattern: string },
    timeoutMs = 20000): Promise<{ observation: PageObservation; value: string | null }> {
    const page = await this.newPage();
    try {
      const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const title = await page.title();
      const text = (await page.locator("body").innerText()).slice(0, 20000);
      const observation: PageObservation = { url: page.url(), status: response?.status() ?? null, title, text };
      let value: string | null = null;
      if (what.kind === "heading") {
        const heads = await page.$$eval("h1,h2,h3,h4,h5,h6",
          (els) => els.map((e) => (e.textContent ?? "").trim()).filter((s) => s !== ""));
        value = heads[0] ?? (title.trim() !== "" ? title.trim() : null);
      } else {
        let re: RegExp | null = null;
        try { re = new RegExp(what.pattern, "m"); } catch { re = null; }
        const m = re ? re.exec(text) : null;
        value = m ? (m[1] ?? m[0]) : null;
      }
      return { observation, value: value === null ? null : value.slice(0, 500) };
    } finally {
      await page.close();
    }
  }

  async screenshot(url: string, timeoutMs = 20000): Promise<{ observation: PageObservation; png: Buffer }> {
    const page = await this.newPage();
    try {
      const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const png = await page.screenshot({ fullPage: false });
      return {
        observation: {
          url: page.url(),
          status: response?.status() ?? null,
          title: await page.title(),
          text: (await page.locator("body").innerText()).slice(0, 20000),
        },
        png,
      };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
  }

  private async newPage(): Promise<Page> {
    if (!this.context) throw new Error("сессия браузера не открыта");
    return this.context.newPage();
  }
}

/**
 * Запрос учётных данных запуска у арбитра по unix-сокету.
 *
 * Исполнитель не может создать привязку в прокси сам: административный сокет
 * прокси ему недоступен. Он предъявляет лизинг и получает ровно одно значение
 * на один запуск — арбитр сверяет лизинг с реестром, а не верит просящему.
 */
export function requestCredentials(
  socketPath: string, runId: string, leaseId: string,
): Promise<RunCredentials & { expiresAt: string; allow: { host: string; methods: string[] }[] }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ lease_id: leaseId });
    const req = http.request(
      { socketPath, path: `/runs/${runId}/proxy`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) {
            reject(new Error(`арбитр отказал в учётных данных: ${text}`));
            return;
          }
          const p = JSON.parse(text) as {
            run_id: string; secret: string; proxy: string; expires_at: string;
            allow: { host: string; methods: string[] }[];
          };
          resolve({ runId: p.run_id, secret: p.secret, proxy: p.proxy,
            expiresAt: p.expires_at, allow: p.allow });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
