import { createHash, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import type { Allow } from "./config.js";

/**
 * Привязка запуска: секрет предъявления, разрешённый набор и срок. Секрет
 * хранится хешем — содержимое памяти прокси не выдаёт значение, которым
 * браузер удостоверяется.
 */
export interface Binding {
  runId: string;
  /**
   * Снимки сессий по хостам: прокси подставляет их сам, на пути запроса
   * (W2-MITA-01). Исполнитель и браузер этих значений не видят — именно поэтому
   * подстановка живёт здесь, а не в профиле браузера.
   */
  cookies?: Record<string, string>;
  taskId: string;
  executor: string;
  generation: number;
  secretHash: Buffer;
  allow: Allow[];
  expires: Date;
  sockets: Set<Duplex>;
}

export class Registry {
  private readonly map = new Map<string, Binding>();

  put(b: Binding): void {
    this.map.set(b.runId, b);
  }

  /** Привязка без проверки секрета: для повторной сверки внутри уже открытого туннеля. */
  get(runId: string): Binding | undefined {
    return this.map.get(runId);
  }

  /**
   * Возвращает привязку, если секрет совпал и срок не истёк. Сравнение секрета
   * выполняется за постоянное время: иначе по задержке ответа значение
   * подбиралось бы побайтно.
   */
  lookup(runId: string, secret: string, now: Date): Binding | undefined {
    const b = this.map.get(runId);
    if (!b) return undefined;
    if (now > b.expires) return undefined;
    const h = createHash("sha256").update(secret).digest();
    if (h.length !== b.secretHash.length || !timingSafeEqual(h, b.secretHash)) return undefined;
    return b;
  }

  /**
   * Удаляет привязку и рвёт её открытые соединения. Немедленность здесь — смысл
   * механизма: по решению D-019 отзыв лизинга обрывает работу в середине
   * выполнения, а не ждёт истечения срока.
   */
  revoke(runId: string): number {
    const b = this.map.get(runId);
    this.map.delete(runId);
    if (!b) return 0;
    let n = 0;
    for (const s of b.sockets) {
      s.destroy();
      n += 1;
    }
    b.sockets.clear();
    return n;
  }

  /** Снимает привязки с истёкшим сроком: истечение обязано прекращать доступ так же, как отзыв. */
  expireStale(now: Date): void {
    for (const [id, b] of this.map) {
      if (now > b.expires) this.revoke(id);
    }
  }

  makeBinding(fields: Omit<Binding, "sockets">): Binding {
    return { ...fields, sockets: new Set<Duplex>() };
  }
}
