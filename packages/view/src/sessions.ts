import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * Сеанс просмотра экрана.
 *
 * Одноразовость требует состояния, поэтому она живёт здесь, а не в nginx:
 * токен «заявляется» первым обращением и с этого момента привязан к одному
 * зрителю. Второй зритель с той же ссылкой получает отказ — это и есть
 * требование «ссылка не дублируется в другой канал» (MITA §11).
 */
export interface ViewSession {
  token: string;
  owner: string;
  expires: Date;
  /** Кем заявлен: пусто — ещё никем. */
  claimedBy?: string;
  sockets: Set<Duplex>;
}

export class SessionRegistry {
  private readonly byToken = new Map<string, ViewSession>();

  create(owner: string, ttlSeconds: number): ViewSession {
    const s: ViewSession = {
      token: randomBytes(24).toString("base64url"),
      owner,
      expires: new Date(Date.now() + ttlSeconds * 1000),
      sockets: new Set<Duplex>(),
    };
    this.byToken.set(s.token, s);
    return s;
  }

  /**
   * Возвращает сеанс, если токен действителен и зритель имеет на него право.
   * Первое обращение заявляет сеанс; последующие обязаны предъявить тот же
   * идентификатор зрителя. Сравнение — за постоянное время.
   */
  claim(token: string, viewerId: string | undefined, now: Date): ViewSession | undefined {
    const s = this.byToken.get(token);
    if (!s) return undefined;
    if (now > s.expires) return undefined;
    if (!s.claimedBy) {
      s.claimedBy = viewerId ?? randomBytes(16).toString("base64url");
      return s;
    }
    if (!viewerId) return undefined;
    const a = Buffer.from(s.claimedBy);
    const b = Buffer.from(viewerId);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    return s;
  }

  /**
   * Гасит сеанс и рвёт его соединения. Гасится ТОЛЬКО названный сеанс:
   * массовое гашение не предусмотрено интерфейсом вовсе (MITA Н-24).
   */
  revoke(token: string): number {
    const s = this.byToken.get(token);
    this.byToken.delete(token);
    if (!s) return 0;
    let n = 0;
    for (const sock of s.sockets) { sock.destroy(); n += 1; }
    s.sockets.clear();
    return n;
  }

  /** Истечение прекращает просмотр так же, как гашение: продление не предусмотрено. */
  expireStale(now: Date): void {
    for (const [t, s] of this.byToken) if (now > s.expires) this.revoke(t);
  }
}
