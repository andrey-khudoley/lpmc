-- Схема диспетчера приёма.
--
-- Диспетчер — та часть арбитра, которая читает недоверенный текст: постановку
-- задачи, формулировки человека, а в дальнейшем и ответы модели. Enforcement —
-- та, которая выдаёт полномочия. Разделение проходит не только по типам входа,
-- но и по ПРАВАМ: у диспетчера собственный системный пользователь, собственная
-- роль в базе и собственная схема.
--
-- Что из этого следует буквально: диспетчер не может прочитать таблицу правил,
-- не может создать задачу, не может записать вердикт и не может опубликовать
-- ни одного события (право публикации не выдано его учётной записи в брокере).
-- Всё, что он умеет, — положить сюда разбор кандидата.

-- Разбор кандидата в задачу.
--
-- Поля разделены на две группы, и это главное в таблице.
--   • decision_* — значения ЗАКРЫТЫХ типов: они и только они попадают на вход
--     гейта. Свободного текста среди них нет.
--   • payload — то, что подлежит хранению в карточке задачи дословно (цель,
--     критерии приёмки). Enforcement сохраняет это, но НЕ передаёт в решение.
--
-- Разделение выражено структурой, а не соглашением: чтобы передать текст в гейт,
-- пришлось бы переписать сигнатуру гейта, а не «забыть» проверку.
CREATE TABLE IF NOT EXISTS qualifications (
  id                      bigserial PRIMARY KEY,
  request_id              uuid NOT NULL UNIQUE,
  event_id                uuid NOT NULL,
  decision_sender         text NOT NULL,
  decision_reply_route_id uuid NOT NULL,
  decision_channel        text NOT NULL,
  decision_adapter_id     text NOT NULL,
  decision_capabilities   text[] NOT NULL,
  owner_hint              text,
  payload                 jsonb NOT NULL,
  qualifier_version       text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  taken_at                timestamptz
);
CREATE INDEX IF NOT EXISTS qualifications_untaken ON qualifications (id) WHERE taken_at IS NULL;

-- Отвергнутые на разборе кандидаты. Задача не создаётся, но след обязан
-- остаться: иначе на вопрос «почему обращение осталось без ответа» отвечать
-- будет нечем, а сам диспетчер опубликовать отказ не может — у него нет права
-- публиковать события вовсе.
CREATE TABLE IF NOT EXISTS rejections (
  id          bigserial PRIMARY KEY,
  event_id    uuid NOT NULL UNIQUE,
  request_id  text,
  reason      text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  taken_at    timestamptz
);
CREATE INDEX IF NOT EXISTS rejections_untaken ON rejections (id) WHERE taken_at IS NULL;

CREATE TABLE IF NOT EXISTS consumed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  consumed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- Арбитр читает разбор и отмечает взятое. Права выданы точечно: чтение и отметка,
-- но не изменение содержимого и не удаление — иначе enforcement мог бы
-- подправить разбор перед тем, как принять по нему решение.
GRANT USAGE ON SCHEMA dispatch TO "lpmc-pact";
GRANT SELECT (id, request_id, event_id, decision_sender, decision_reply_route_id,
              decision_channel, decision_adapter_id, decision_capabilities,
              owner_hint, payload, qualifier_version, created_at, taken_at)
  ON dispatch.qualifications TO "lpmc-pact";
GRANT UPDATE (taken_at) ON dispatch.qualifications TO "lpmc-pact";
GRANT SELECT ON dispatch.rejections TO "lpmc-pact";
GRANT UPDATE (taken_at) ON dispatch.rejections TO "lpmc-pact";
