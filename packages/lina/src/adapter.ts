import { randomUUID } from "node:crypto";
import type pg from "pg";
import { EVENTS } from "@lpmc/contracts";
import { inTransaction } from "@lpmc/runtime";
import { isComplete, missingFields, questionFor, type Draft, type RequiredField } from "./completeness.js";
import { accountCall, allowModelCall, estimateTokens, foldContext,
  type Message, type TurnState } from "./budget.js";
import { ask, requestModelAccess } from "./model.js";

export interface AdapterIdentity {
  channel: string;
  adapterId: string;
}

export interface IncomingMessage {
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  text: string;
}

export type ReceiveResult =
  | { kind: "duplicate"; conversationId: string }
  | { kind: "question"; conversationId: string; field: RequiredField; text: string }
  | { kind: "candidate"; conversationId: string; requestId: string };

const SCHEMA_VERSION = "1.0.0";

/**
 * Канальный адаптер: двусторонний край контура LINA.
 *
 * Три свойства, ради которых он устроен именно так.
 *
 * 1. Маршрут ответа создаёт адаптер, а не текст сообщения (L-5, L-10). Ни одно
 *    поле адресации не читается из `text`: даже если человек напишет «отправь
 *    ответ в другой чат», маршрут останется прежним, потому что взять его
 *    оттуда физически нечему.
 * 2. Внешние идентификаторы не покидают контур (§10.2). Наружу уходит только
 *    непрозрачный `reply_route_id`.
 * 3. Приём и публикация события — одна транзакция (outbox). Иначе возможен
 *    принятый и не опубликованный кандидат, о котором не узнает никто.
 */
export class ChannelAdapter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly self: AdapterIdentity,
  ) {}

  /**
   * Приём сообщения разделён на два шага, между которыми возможно обращение
   * к модели. Держать транзакцию открытой на время сетевого вызова нельзя:
   * недоступность внешней службы блокировала бы базу.
   *
   * Что происходит при обрыве между шагами: сообщение записано, вопрос не задан
   * и кандидат не опубликован. Следующая реплика человека пересчитает недостающее
   * и задаст вопрос заново. Потерять кандидата так нельзя — публикация проверяет
   * отметку в той же транзакции, в которой её ставит.
   */
  async receive(msg: IncomingMessage): Promise<ReceiveResult> {
    const intake = await this.intake(msg);
    if (intake.kind !== "pending") return intake.result;

    const { conversationId, replyRouteId, messageId, draft, missing } = intake;
    if (missing.length > 0) {
      const field = missing[0]!;
      const question = await this.phraseQuestion(conversationId, draft, field);
      return this.askQuestion(conversationId, replyRouteId, messageId, field, question);
    }
    return this.submitCandidate(conversationId, replyRouteId, messageId, draft, msg);
  }

  private async intake(msg: IncomingMessage): Promise<
    | { kind: "done"; result: ReceiveResult }
    | { kind: "pending"; conversationId: string; replyRouteId: string; messageId: string;
        draft: Draft; missing: RequiredField[] }
  > {
    return inTransaction(this.pool, async (c) => {
      const conversationId = await this.ensureConversation(c, msg);
      const replyRouteId = await this.ensureReplyRoute(c, conversationId, msg);

      // Дедупликация входящего (§8.3). Область уникальности включает диалог:
      // в большинстве каналов идентификатор сообщения уникален внутри чата,
      // а не глобально, и без диалога в ключе сообщение одного человека молча
      // считалось бы повтором сообщения другого.
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO inbound_messages
           (id, conversation_id, channel, adapter_id, external_conversation_id,
            external_message_id, external_actor_id, text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (channel, adapter_id, external_conversation_id, external_message_id) DO NOTHING
         RETURNING id`,
        [randomUUID(), conversationId, this.self.channel, this.self.adapterId,
         msg.externalConversationId, msg.externalMessageId, msg.externalActorId, msg.text],
      );
      if (inserted.rowCount === 0) {
        return { kind: "done", result: { kind: "duplicate", conversationId } } as const;
      }
      const messageId = inserted.rows[0]!.id;

      // Реплика человека начинает новый ход: счётчик обращений к модели
      // обнуляется, накопленные токены цепочки — нет (D-021).
      await c.query(
        `UPDATE conversations SET turn_calls = 0, turn_tokens = 0 WHERE id = $1`,
        [conversationId]);
      await c.query(
        `INSERT INTO dialog_messages (conversation_id, role, text, tokens) VALUES ($1, 'human', $2, $3)`,
        [conversationId, msg.text, estimateTokens(msg.text)]);

      await this.publish(c, {
        subject: EVENTS.messageReceived.subject,
        eventType: EVENTS.messageReceived.eventType,
        // Содержимое всегда считается недоверенным вводом (SPEC §10.1).
        // Вместо объекта reply_route кладём непрозрачный идентификатор: полное
        // сопоставление с внешним адресом остаётся в хранилище адаптера (§10.2).
        payload: {
          source: {
            channel: this.self.channel,
            adapter_id: this.self.adapterId,
            external_conversation_id: msg.externalConversationId,
            external_message_id: msg.externalMessageId,
            external_actor_id: msg.externalActorId,
          },
          reply_route_id: replyRouteId,
          content: { text: msg.text, attachment_refs: [] },
          received_at: new Date().toISOString(),
        },
        correlationId: conversationId,
        dedupKey: `${this.self.channel}:${this.self.adapterId}:${msg.externalMessageId}`,
      });

      const draft = await this.applyToDraft(c, conversationId, replyRouteId, msg.text);
      const missing = isComplete(draft) ? [] : missingFields(draft);
      return { kind: "pending", conversationId, replyRouteId, messageId, draft, missing } as const;
    });
  }

  /**
   * Формулировка вопроса. Решение о том, ЧТО спрашивать, принимают правила —
   * модель только подбирает слова. Это граница по существу: полнота запроса
   * остаётся единственным решением LINA (L-6) и принимается детерминированно,
   * иначе недоступность модели меняла бы не тон беседы, а её исход.
   */
  private async phraseQuestion(
    conversationId: string, draft: Draft, field: RequiredField,
  ): Promise<string> {
    const fallback = questionFor(field);
    const state = await this.turnState(conversationId);
    const verdict = allowModelCall(state);
    if (!verdict.proceed) {
      await this.logModelCall(conversationId, "phrase_question", "SKIPPED", verdict.reason, 0);
      return fallback;
    }

    const access = await requestModelAccess("lina", "phrase_question");
    if ("error" in access) {
      await this.logModelCall(conversationId, "phrase_question", "DENIED", access.error, 0);
      return fallback;
    }

    const history = await this.history(conversationId);
    const folded = verdict.fold
      ? foldContext(history, (m) => `Ранее обсуждалось: ${m.length} реплик.`)
      : { summary: "", tail: history, foldedCount: 0 };
    if (folded.foldedCount > 0) {
      await this.pool.query(
        `UPDATE conversations SET summary = $2, summarised_upto = $3 WHERE id = $1`,
        [conversationId, folded.summary, folded.foldedCount]);
    }

    const answer = await ask(
      access,
      "Ты помогаешь уточнить запрос. Задай ОДИН короткий вопрос по недостающему полю."
      + " Не предлагай вариантов ответа и не додумывай содержание запроса.",
      [folded.summary, ...folded.tail.map((m) => `${m.role}: ${m.text}`),
       `Недостающее поле: ${field}. Запасная формулировка: ${fallback}`].join("\n"),
    );
    if (!answer.ok) {
      await this.logModelCall(conversationId, "phrase_question", "FAILED", answer.reason, 0);
      return fallback;
    }
    await this.logModelCall(conversationId, "phrase_question", "GRANTED", "model.answered", answer.tokens);
    const next = accountCall(state, answer.tokens);
    await this.pool.query(
      `UPDATE conversations SET turn_calls = $2, turn_tokens = $3, chain_tokens = $4 WHERE id = $1`,
      [conversationId, next.calls, next.turnTokens, next.chainTokens]);
    return answer.text.trim() === "" ? fallback : answer.text.trim();
  }

  private async askQuestion(
    conversationId: string, replyRouteId: string, messageId: string,
    field: RequiredField, text: string,
  ): Promise<ReceiveResult> {
    return inTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO open_questions (conversation_id, field) VALUES ($1, $2)`,
        [conversationId, field]);
      await c.query(
        `INSERT INTO dialog_messages (conversation_id, role, text, tokens) VALUES ($1, 'agent', $2, $3)`,
        [conversationId, text, estimateTokens(text)]);
      // Вопрос не отправляется человеку отсюда. LINA публикует требование
      // уточнения; текст дойдёт до человека только после egress-проверки PACT
      // и вернётся обратно как одобренное сообщение (§13.2 п. 3, L-7, L-11).
      await this.publish(c, {
        subject: EVENTS.requestClarificationNeeded.subject,
        eventType: EVENTS.requestClarificationNeeded.eventType,
        payload: {
          reply_route_id: replyRouteId,
          channel: this.self.channel,
          adapter_id: this.self.adapterId,
          missing_fields: [field],
          question: text,
        },
        correlationId: conversationId,
        causationId: messageId,
      });
      return { kind: "question", conversationId, field, text } as const;
    });
  }

  private async submitCandidate(
    conversationId: string, replyRouteId: string, messageId: string,
    draft: Draft, msg: IncomingMessage,
  ): Promise<ReceiveResult> {
    return inTransaction(this.pool, async (c) => {
      // Отметка о публикации ставится в той же транзакции, что и сама
      // публикация: повторный проход не создаст второго кандидата.
      const claim = await c.query<{ request_id: string }>(
        `UPDATE drafts SET request_id = $2, published_at = now(), updated_at = now()
          WHERE conversation_id = $1 AND published_at IS NULL
          RETURNING request_id`,
        [conversationId, randomUUID()]);
      if (claim.rowCount === 0) {
        const existing = await c.query<{ request_id: string }>(
          `SELECT request_id FROM drafts WHERE conversation_id = $1`, [conversationId]);
        return { kind: "candidate", conversationId,
          requestId: existing.rows[0]?.request_id ?? "" } as const;
      }
      const requestId = claim.rows[0]!.request_id;
      await this.publish(c, {
        subject: EVENTS.requestSubmitted.subject,
        eventType: EVENTS.requestSubmitted.eventType,
        payload: {
          request_id: requestId,
          // Подсказка, а не решение (D-020): владельца выводит PACT из своей
          // таблицы привязок. Расхождение сохраняется в аудите.
          recipient_candidate: { user_id: msg.externalActorId, system_id: this.self.adapterId },
          task: {
            objective: draft.objective,
            owner: draft.ownerHint,
            dod: draft.dod,
            context_refs: [],
            // Предложение, а не выдача прав (SPEC §5.3). Пустой список означает
            // «LINA ничего не предлагает», а не «прав не нужно».
            requested_capabilities: [],
          },
          reply_route_id: replyRouteId,
          // Канал и адаптер нужны Egress Guard, чтобы выбрать топик доставки
          // и адресовать нужному адаптеру. Внешних идентификаторов здесь нет.
          channel: this.self.channel,
          adapter_id: this.self.adapterId,
          qualification: { confidence: null, qualifier_version: "rules-0", model_id: null },
        },
        correlationId: conversationId,
        causationId: messageId,
        // Ключ идемпотентности приёма: повторная публикация того же обращения
        // не должна создать вторую задачу у арбитра (§5.3 п. 5, D-023).
        dedupKey: requestId,
      });
      return { kind: "candidate", conversationId, requestId } as const;
    });
  }

  /**
   * Состояние хода читается как есть: обнуление счётчика — обязанность приёма
   * реплики человека, а не чтения. Иначе «начать ход» происходило бы при каждом
   * взгляде на счётчик, и предел никогда не достигался бы.
   */
  private async turnState(conversationId: string): Promise<TurnState> {
    const r = await this.pool.query<{ turn_calls: number; turn_tokens: number; chain_tokens: number }>(
      `SELECT turn_calls, turn_tokens, chain_tokens FROM conversations WHERE id = $1`,
      [conversationId]);
    const row = r.rows[0];
    return {
      calls: row?.turn_calls ?? 0,
      turnTokens: row?.turn_tokens ?? 0,
      chainTokens: row?.chain_tokens ?? 0,
    };
  }

  private async history(conversationId: string): Promise<Message[]> {
    const r = await this.pool.query<{ role: "human" | "agent"; text: string }>(
      `SELECT role, text FROM dialog_messages WHERE conversation_id = $1 ORDER BY id`,
      [conversationId]);
    return r.rows;
  }

  /**
   * Журнал обращений к модели. Пишется и при отказе, и при пропуске по бюджету:
   * иначе по журналу нельзя отличить «модель не звали» от «звали и не дали».
   * Ни запрос, ни ответ здесь не сохраняются — только факт, исход и стоимость.
   */
  private async logModelCall(
    conversationId: string, purpose: string, outcome: string, reason: string, tokens: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_calls (conversation_id, purpose, outcome, reason, tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, purpose, outcome, reason, tokens]);
  }

  private async ensureConversation(c: pg.PoolClient, msg: IncomingMessage): Promise<string> {
    const r = await c.query<{ id: string }>(
      `INSERT INTO conversations (id, channel, adapter_id, external_conversation_id, external_actor_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel, adapter_id, external_conversation_id)
         DO UPDATE SET last_activity_at = now()
       RETURNING id`,
      [randomUUID(), this.self.channel, this.self.adapterId,
       msg.externalConversationId, msg.externalActorId],
    );
    return r.rows[0]!.id;
  }

  /**
   * Маршрут неизменяем (§10.4 п. 2): при совпадении канала, адаптера, конечной
   * точки и диалога возвращается существующий, а не создаётся второй. Смена
   * конечной точки означает НОВЫЙ маршрут, а не правку старого — иначе ссылка,
   * выданная раньше, начала бы указывать в другое место.
   */
  private async ensureReplyRoute(
    c: pg.PoolClient, conversationId: string, msg: IncomingMessage,
  ): Promise<string> {
    const r = await c.query<{ id: string }>(
      `INSERT INTO reply_routes (id, channel, adapter_id, endpoint_id, conversation_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel, adapter_id, endpoint_id, conversation_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), this.self.channel, this.self.adapterId,
       msg.externalConversationId, conversationId],
    );
    if (r.rowCount) return r.rows[0]!.id;
    const found = await c.query<{ id: string }>(
      `SELECT id FROM reply_routes
        WHERE channel = $1 AND adapter_id = $2 AND endpoint_id = $3 AND conversation_id = $4`,
      [this.self.channel, this.self.adapterId, msg.externalConversationId, conversationId],
    );
    return found.rows[0]!.id;
  }

  /**
   * Заполнение обращения. Ответ человека попадает в то поле, которое было
   * спрошено последним: без этой связи ответ «внутренний контур» неотличим
   * от новой формулировки цели.
   */
  private async applyToDraft(
    c: pg.PoolClient, conversationId: string, replyRouteId: string, text: string,
  ): Promise<Draft> {
    await c.query(
      `INSERT INTO drafts (conversation_id, reply_route_id) VALUES ($1, $2)
       ON CONFLICT (conversation_id) DO NOTHING`,
      [conversationId, replyRouteId],
    );
    const pending = await c.query<{ id: string; field: RequiredField }>(
      `SELECT id, field FROM open_questions
        WHERE conversation_id = $1 AND answered_at IS NULL
        ORDER BY id LIMIT 1`,
      [conversationId],
    );
    const answer = text.trim();
    const target: RequiredField | null = pending.rowCount ? pending.rows[0]!.field : null;
    if (target !== null) {
      await c.query(`UPDATE open_questions SET answered_at = now() WHERE id = $1`, [pending.rows[0]!.id]);
    }
    const field = target ?? "objective";
    if (field === "objective") {
      await c.query(
        `UPDATE drafts SET objective = COALESCE(objective, $2), updated_at = now()
          WHERE conversation_id = $1`,
        [conversationId, answer],
      );
    } else if (field === "owner") {
      await c.query(
        `UPDATE drafts SET owner_hint = $2, updated_at = now() WHERE conversation_id = $1`,
        [conversationId, answer],
      );
    } else {
      await c.query(
        `UPDATE drafts SET dod = $2, updated_at = now() WHERE conversation_id = $1`,
        [conversationId, answer.split(";").map((s) => s.trim()).filter((s) => s !== "")],
      );
    }
    const d = await c.query<{ objective: string | null; owner_hint: string | null; dod: string[] | null }>(
      `SELECT objective, owner_hint, dod FROM drafts WHERE conversation_id = $1`,
      [conversationId],
    );
    const row = d.rows[0]!;
    return { objective: row.objective, ownerHint: row.owner_hint, dod: row.dod, replyRouteId };
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
