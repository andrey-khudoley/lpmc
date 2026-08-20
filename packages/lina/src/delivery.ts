import type pg from "pg";
import { EVENTS } from "@lpmc/contracts";
import { inTransaction } from "@lpmc/runtime";
import { validateOutbound, type OutboundMessage } from "./outbound.js";
import type { AdapterIdentity } from "./adapter.js";

export type DeliveryOutcome =
  | { kind: "delivered"; conversationId: string }
  | { kind: "duplicate"; conversationId: string }
  | { kind: "refused"; reason: string };

const SCHEMA_VERSION = "1.0.0";

/**
 * Доставка одобренного сообщения в канал.
 *
 * Состояние доставки ведётся отдельно от состояния задачи и никогда не читается
 * как состояние задачи (L-12): «не доставлено» не означает «не выполнено».
 * Результат доставки возвращается в брокер ВСЕГДА — и успех, и отказ.
 */
export class Delivery {
  constructor(
    private readonly pool: pg.Pool,
    private readonly self: AdapterIdentity,
  ) {}

  async deliver(msg: Partial<OutboundMessage> & Record<string, unknown>): Promise<DeliveryOutcome> {
    const verdict = validateOutbound(msg, self(this.self));
    if (!verdict.ok) {
      await this.toDlq(msg, verdict.reason);
      return { kind: "refused", reason: verdict.reason };
    }
    const m = msg as OutboundMessage;

    return inTransaction(this.pool, async (c) => {
      // Маршрут обязан принадлежать этому адаптеру и не быть отозванным.
      // Проверка по хранилищу, а не по содержимому события: событие могло быть
      // составлено кем угодно, а таблица маршрутов принадлежит только нам.
      const route = await c.query<{ id: string; conversation_id: string }>(
        `SELECT id, conversation_id FROM reply_routes
          WHERE id = $1 AND channel = $2 AND adapter_id = $3 AND revoked_at IS NULL`,
        [m.destination.reply_route_id, this.self.channel, this.self.adapterId],
      );
      if (route.rowCount === 0) {
        await this.toDlqIn(c, m, "outbound.unknown_route");
        return { kind: "refused", reason: "outbound.unknown_route" } as const;
      }
      const conversationId = route.rows[0]!.conversation_id;

      // Повторная доставка одного события не создаёт второго сообщения в чате
      // (§5.3 п. 4). Ключ приходит от Egress Guard и потому одинаков у повторов.
      const ins = await c.query(
        `INSERT INTO deliveries
           (idempotency_key, message_id, conversation_id, reply_route_id, text, status,
            attempts, delivered_at, ephemeral)
         VALUES ($1, $2, $3, $4, $5, 'delivered', 1, now(), $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [m.idempotency_key, m.message_id, conversationId, m.destination.reply_route_id,
         m.content.text, m.ephemeral === true],
      );
      if (ins.rowCount === 0) return { kind: "duplicate", conversationId } as const;

      await this.publish(c, {
        subject: EVENTS.deliverySucceeded.subject,
        eventType: EVENTS.deliverySucceeded.eventType,
        payload: {
          message_id: m.message_id,
          channel: this.self.channel,
          adapter_id: this.self.adapterId,
          // Для CLI внешний идентификатор сообщения — ключ идемпотентности:
          // канал не выдаёт своего, а выдумывать второй значило бы завести
          // тождество, которое ни с чем не сопоставляется.
          external_message_id: m.idempotency_key,
          delivered_at: new Date().toISOString(),
        },
        correlationId: conversationId,
        causationId: m.message_id,
        dedupKey: m.idempotency_key,
      });
      return { kind: "delivered", conversationId } as const;
    });
  }

  /**
   * Отказ в доставке уходит в разбор, а не в доставку по умолчанию (§10.4 п. 3).
   * Событие с чужим адресом не является отказом канала: канала оно даже
   * не достигло, поэтому это `delivery.dlq`, а не `delivery.failed`.
   */
  private async toDlq(msg: unknown, reason: string): Promise<void> {
    await inTransaction(this.pool, async (c) => { await this.toDlqIn(c, msg, reason); });
  }

  private async toDlqIn(c: pg.PoolClient, msg: unknown, reason: string): Promise<void> {
    await this.publish(c, {
      subject: "delivery.dlq.v1",
      eventType: EVENTS.messageDispatchRequested.eventType,
      payload: { reason, rejected: msg },
      correlationId: "delivery-dlq",
    });
  }

  private async publish(
    c: pg.PoolClient,
    e: { subject: string; eventType: string; payload: unknown; correlationId: string;
         causationId?: string; dedupKey?: string },
  ): Promise<void> {
    await c.query(
      `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, causation_id, dedup_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [e.subject, e.eventType, SCHEMA_VERSION, JSON.stringify(e.payload),
       e.correlationId, e.causationId ?? null, e.dedupKey ?? null],
    );
  }
}

function self(id: AdapterIdentity): { channel: string; adapterId: string } {
  return { channel: id.channel, adapterId: id.adapterId };
}
