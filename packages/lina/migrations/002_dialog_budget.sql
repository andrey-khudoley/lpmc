-- Учёт работы между сообщениями человека (D-021, W1-LINA-04).
--
-- Счётчики ведутся на диалог, а не на задачу: диалог может не породить ни одной
-- задачи, но обращения к модели в нём уже были, и их надо считать.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS turn_calls integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS turn_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chain_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summarised_upto bigint;

-- Журнал обращений к модели. Ведётся с первой волны, когда обращений ещё нет:
-- запись об отказе так же обязательна, как запись об успехе, иначе по журналу
-- нельзя отличить «модель не вызывали» от «журнал не вёлся».
--
-- Ни запрос, ни ответ модели здесь не хранятся: это содержимое разговора,
-- у него своё место и свой срок хранения. Здесь — только факт, стоимость и исход.
CREATE TABLE IF NOT EXISTS model_calls (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  purpose          text NOT NULL,
  outcome          text NOT NULL,
  reason           text NOT NULL,
  tokens           integer NOT NULL DEFAULT 0,
  called_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_calls_conversation ON model_calls (conversation_id, called_at);

-- История реплик диалога: то, что сворачивается в конспект. Хранится отдельно
-- от входящих сообщений канала, потому что реплика агента сообщением канала
-- не является — она может вовсе не дойти до человека, если её остановит
-- проверка исходящего.
CREATE TABLE IF NOT EXISTS dialog_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  role             text NOT NULL CHECK (role IN ('human', 'agent')),
  text             text NOT NULL,
  tokens           integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dialog_messages_conversation
  ON dialog_messages (conversation_id, id);
