import { AckPolicy, DeliverPolicy, type JsMsg, type NatsConnection } from "nats";
import { checkEnvelopeFor, type Envelope } from "@lpmc/contracts";

/**
 * Долговременный потребитель с явным подтверждением.
 *
 * Подтверждение ставится только после того, как результат обработки зафиксирован
 * в базе. Обратный порядок означал бы «подтвердили и потеряли»: брокер считает
 * событие обработанным, а следов работы нет.
 *
 * Общий код вынесен сюда, потому что ошибиться в нём легко и одинаково: забытый
 * ack останавливает поток, лишний ack теряет событие.
 */
export interface ConsumerOptions {
  stream: string;
  durable: string;
  filterSubject: string;
}

export type Handler = (envelope: Envelope, msg: JsMsg) => Promise<void>;

export async function runConsumer(
  nc: NatsConnection,
  opts: ConsumerOptions,
  handle: Handler,
  stopSignal: { running: boolean },
): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(opts.stream, {
    durable_name: opts.durable,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: opts.filterSubject,
  }).catch(() => undefined);

  const js = nc.jetstream();
  const consumer = await js.consumers.get(opts.stream, opts.durable);

  while (stopSignal.running) {
    const batch = await consumer.fetch({ max_messages: 16, expires: 5000 });
    for await (const m of batch) {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(new TextDecoder().decode(m.data)) as Envelope;
      } catch {
        // Нечитаемое событие не подтверждается как обработанное и не крутится
        // бесконечно: term снимает его с доставки, событие остаётся в потоке.
        console.error("событие не разобрано как JSON");
        m.term();
        continue;
      }
      // Разбор JSON успехом не является: строка «{}» разбирается прекрасно
      // и не содержит ничего. Конверт проверяется до payload, потому что
      // событие без тождества нельзя дедуплицировать, а при расхождении
      // старших версий его нельзя читать вовсе (D-015, D-016).
      const envelopeOk = checkEnvelopeFor(opts.filterSubject, envelope);
      if (!envelopeOk.ok) {
        console.error(`конверт не соответствует контракту: ${envelopeOk.reason}`);
        m.term();
        continue;
      }
      try {
        await handle(envelope, m);
        m.ack();
      } catch (e) {
        console.error(`обработка не удалась: ${e instanceof Error ? e.message : String(e)}`);
        m.nak(5000);
      }
      if (!stopSignal.running) break;
    }
  }
}

/** Обработчик сигналов остановки, общий для служб-потребителей. */
export function stopOnSignals(): { running: boolean } {
  const state = { running: true };
  const stop = (sig: string): void => {
    console.log(`получен ${sig}: останавливаемся`);
    state.running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  return state;
}
