-- Область уникальности входящего сообщения включает диалог.
--
-- Было: «канал + адаптер + идентификатор сообщения». Это верно лишь для каналов,
-- где идентификатор сообщения уникален глобально. В Telegram он уникален
-- ВНУТРИ ЧАТА: сообщение №5 существует в каждом чате. При прежнем ключе первое
-- же совпадение номеров привело бы к тому, что сообщение одного человека молча
-- считается повтором сообщения другого — и остаётся без ответа.
ALTER TABLE inbound_messages
  ADD COLUMN IF NOT EXISTS external_conversation_id text;

UPDATE inbound_messages m
   SET external_conversation_id = c.external_conversation_id
  FROM conversations c
 WHERE c.id = m.conversation_id AND m.external_conversation_id IS NULL;

ALTER TABLE inbound_messages ALTER COLUMN external_conversation_id SET NOT NULL;

-- Сначала ограничение, потом индекс: индекс уникальности принадлежит ограничению,
-- и отдельно его не удалить.
ALTER TABLE inbound_messages
  DROP CONSTRAINT IF EXISTS inbound_messages_channel_adapter_id_external_message_id_key;
DROP INDEX IF EXISTS inbound_messages_channel_adapter_id_external_message_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_dedup
  ON inbound_messages (channel, adapter_id, external_conversation_id, external_message_id);
