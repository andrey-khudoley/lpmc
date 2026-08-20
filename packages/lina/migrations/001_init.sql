-- Схема канального контура. Здесь и только здесь живут внешние идентификаторы:
-- chat_id, идентификатор сообщения в мессенджере, идентификатор отправителя.
-- Наружу, в события, уходит непрозрачный reply_route_id (LINA §10.2). Соседние
-- контуры внешних адресов не видят вовсе — это и есть граница контура.

-- Диалог. Единица работы LINA — не задача, а разговор: у разговора может не
-- возникнуть ни одной задачи, и это нормальный исход, а не ошибка.
CREATE TABLE IF NOT EXISTS conversations (
  id                        uuid PRIMARY KEY,
  channel                   text NOT NULL,
  adapter_id                text NOT NULL,
  external_conversation_id  text NOT NULL,
  external_actor_id         text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  last_activity_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, adapter_id, external_conversation_id)
);

-- Маршрут ответа. Создаётся адаптером и НЕИЗМЕНЯЕМ: смена конечной точки — это
-- новый маршрут, а не правка существующего (LINA §10.4 п. 2). Поэтому здесь нет
-- ни одного изменяемого поля, кроме отзыва.
--
-- Идентификатор непрозрачный (uuid): вывести из значения внешний адрес нельзя,
-- иначе утечка события раскрывала бы чат.
CREATE TABLE IF NOT EXISTS reply_routes (
  id               uuid PRIMARY KEY,
  channel          text NOT NULL,
  adapter_id       text NOT NULL,
  endpoint_id      text NOT NULL,
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  UNIQUE (channel, adapter_id, endpoint_id, conversation_id)
);

-- Входящие сообщения. Ключ дедупликации — внешний идентификатор сообщения
-- в пределах канала и адаптера: повторная доставка одного сообщения каналом
-- не должна порождать второго кандидата в задачу (LINA §5.3 п. 5).
CREATE TABLE IF NOT EXISTS inbound_messages (
  id                    uuid PRIMARY KEY,
  conversation_id       uuid NOT NULL REFERENCES conversations(id),
  channel               text NOT NULL,
  adapter_id            text NOT NULL,
  external_message_id   text NOT NULL,
  external_actor_id     text NOT NULL,
  text                  text NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, adapter_id, external_message_id)
);

-- Собранное обращение: то, что LINA знает о запросе на текущий момент диалога.
-- Поля заполняются по мере уточнения; кандидат публикуется, когда набран
-- обязательный минимум (LINA §6.2).
--
-- owner_hint назван подсказкой намеренно (D-020): владельца выводит PACT из своей
-- таблицы привязок, а не из того, что сказал человек. Расхождение подсказки
-- с выведенным значением — признак неполноты привязок, а не повод довериться.
CREATE TABLE IF NOT EXISTS drafts (
  conversation_id   uuid PRIMARY KEY REFERENCES conversations(id),
  objective         text,
  owner_hint        text,
  dod               text[],
  reply_route_id    uuid NOT NULL REFERENCES reply_routes(id),
  published_at      timestamptz,
  request_id        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Открытый вопрос человеку. Хранится, потому что ответ на него нужно связать
-- с тем, что именно спрашивали: без этого ответ «ООО Ромашка» невозможно
-- отличить от новой формулировки цели.
CREATE TABLE IF NOT EXISTS open_questions (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  field            text NOT NULL,
  asked_at         timestamptz NOT NULL DEFAULT now(),
  answered_at      timestamptz
);
CREATE INDEX IF NOT EXISTS open_questions_pending
  ON open_questions (conversation_id) WHERE answered_at IS NULL;

-- Доставка одобренного наружу сообщения. Ключ идемпотентности приходит от
-- Egress Guard: повторная доставка одного события не создаёт второго сообщения
-- в чате (LINA §5.3 п. 4).
--
-- Состояние доставки ведётся отдельно от состояния задачи и никогда не
-- истолковывается как состояние задачи (L-12): «не доставлено» не значит
-- «не выполнено».
CREATE TABLE IF NOT EXISTS deliveries (
  idempotency_key      text PRIMARY KEY,
  message_id           uuid NOT NULL,
  conversation_id      uuid NOT NULL REFERENCES conversations(id),
  reply_route_id       uuid NOT NULL REFERENCES reply_routes(id),
  text                 text NOT NULL,
  external_message_id  text,
  status               text NOT NULL CHECK (status IN ('delivered', 'failed')),
  error_category       text,
  attempts             integer NOT NULL DEFAULT 0,
  delivered_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_conversation
  ON deliveries (conversation_id, created_at);

-- Transactional outbox — тот же механизм, что у арбитра: запись состояния и
-- запись события уходят одной транзакцией, публикует отдельный ретранслятор.
CREATE TABLE IF NOT EXISTS outbox (
  id              bigserial PRIMARY KEY,
  subject         text NOT NULL,
  event_type      text NOT NULL,
  schema_version  text NOT NULL,
  payload         jsonb NOT NULL,
  correlation_id  text NOT NULL,
  causation_id    text,
  dedup_key       text,
  event_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_event_id ON outbox (event_id);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
