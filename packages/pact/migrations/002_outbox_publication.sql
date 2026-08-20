-- Публикация outbox: тождество события и следы попыток.
--
-- event_id присваивается ПРИ ЗАПИСИ, а не при публикации. Иначе повторная
-- публикация после падения ретранслятора между отправкой и отметкой создала бы
-- второе событие с новым тождеством — то есть дубль, неотличимый от нового
-- факта (D-023).
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS event_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_event_id ON outbox (event_id);

-- Порядок публикации — порядок записи; индекс обслуживает выборку неотправленных.
DROP INDEX IF EXISTS outbox_unpublished;
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
