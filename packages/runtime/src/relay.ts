import type pg from "pg";
import { headers, type JetStreamClient, type NatsConnection } from "nats";
import { streamFor, type Envelope } from "@lpmc/contracts";
import { inTransaction } from "./db.js";

export interface RelayRow {
  id: string;
  event_id: string;
  subject: string;
  event_type: string;
  schema_version: string;
  payload: unknown;
  correlation_id: string;
  causation_id: string | null;
  dedup_key: string | null;
  created_at: Date;
}

export interface RelayResult {
  published: number;
  failed: number;
  lastError?: string;
}

/**
 * Тождество сообщения для окна дедупликации брокера.
 *
 * Если у события есть деловой ключ, схлопывать надо по нему: два обращения
 * с одним ключом — это один факт, записанный дважды. Тип события в ключе
 * обязателен, иначе разные события одной задачи схлопнутся в одно.
 * Без делового ключа тождество — сама строка outbox, и тогда окно защищает
 * только от повторной отправки той же строки.
 *
 * Окно брокера остаётся оптимизацией: гарантию даёт потребитель по event_id (D-023).
 */
export function msgId(row: Pick<RelayRow, "event_id" | "event_type" | "dedup_key">): string {
  return row.dedup_key ? `${row.event_type}:${row.dedup_key}` : row.event_id;
}

export function toEnvelope(row: RelayRow, service: string, instance: string): Envelope {
  const e: Envelope = {
    event_id: row.event_id,
    event_type: row.event_type,
    schema_version: row.schema_version,
    // Момент факта, а не момент отправки: задержка ретранслятора не должна
    // сдвигать время события в журналах потребителей.
    occurred_at: row.created_at.toISOString(),
    producer: { service, instance },
    correlation_id: row.correlation_id,
    payload: row.payload,
  };
  if (row.causation_id) e.causation_id = row.causation_id;
  if (row.dedup_key) e.deduplication_key = row.dedup_key;
  return e;
}

/**
 * Ретранслятор outbox → JetStream.
 *
 * Отметка о публикации ставится ПОСЛЕ подтверждения брокера и в той же
 * транзакции, что и выборка строки: строка заблокирована на время отправки,
 * поэтому второй экземпляр ретранслятора возьмёт следующие, а не эти же.
 * Падение между подтверждением и фиксацией даёт повторную отправку той же
 * строки — доставка «не менее одного раза», как и заявлено; тождество
 * сообщения при этом не меняется.
 */
export class OutboxRelay {
  private readonly js: JetStreamClient;

  constructor(
    private readonly pool: pg.Pool,
    nc: NatsConnection,
    private readonly service: string,
    private readonly instance: string,
  ) {
    this.js = nc.jetstream();
  }

  async pump(batch = 50): Promise<RelayResult> {
    return inTransaction(this.pool, async (c) => {
      const { rows } = await c.query<RelayRow>(
        `SELECT id, event_id, subject, event_type, schema_version, payload,
                correlation_id, causation_id, dedup_key, created_at
           FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
            FOR UPDATE SKIP LOCKED`,
        [batch],
      );
      const result: RelayResult = { published: 0, failed: 0 };
      for (const row of rows) {
        const h = headers();
        h.set("Nats-Msg-Id", msgId(row));
        try {
          await this.js.publish(
            row.subject,
            new TextEncoder().encode(JSON.stringify(toEnvelope(row, this.service, this.instance))),
            { headers: h, expect: { streamName: streamFor(row.subject) } },
          );
        } catch (e) {
          // Останавливаемся на первой неудаче: события одной задачи должны
          // уходить в порядке записи, а «пропустить и продолжить» этот порядок
          // ломает. Строка остаётся неотправленной и будет взята следующим проходом.
          result.failed = rows.length - result.published;
          result.lastError = e instanceof Error ? e.message : String(e);
          await c.query(
            `UPDATE outbox SET attempts = attempts + 1, last_error = $2, last_attempt_at = now()
              WHERE id = $1`,
            [row.id, result.lastError],
          );
          break;
        }
        await c.query(
          `UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_attempt_at = now()
            WHERE id = $1`,
          [row.id],
        );
        result.published += 1;
      }
      return result;
    });
  }
}

