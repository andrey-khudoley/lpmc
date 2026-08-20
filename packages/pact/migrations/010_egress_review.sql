-- Очередь ручного разбора отклонённого исходящего (W1-PACT-09).
--
-- Отклонённое не исчезает и не уходит человеку: оно ложится сюда вместе
-- с текстом и причиной. Без очереди отказ означал бы тишину — предложение
-- пропало, и никто не узнал бы ни о нём, ни о причине.
--
-- Текст здесь хранится намеренно: разбирать отказ, не видя, что именно
-- отклонили, невозможно. Доступ к таблице есть только у арбитра.
CREATE TABLE IF NOT EXISTS egress_review (
  proposal_id     uuid PRIMARY KEY,
  reply_route_id  text NOT NULL,
  channel         text NOT NULL,
  adapter_id      text NOT NULL,
  content_class   text NOT NULL,
  content         text NOT NULL,
  decision        text NOT NULL,
  reason          text NOT NULL,
  task_id         text,
  owner_slug      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  released_by     text,
  dismissed_at    timestamptz,
  dismissed_by    text
);
CREATE INDEX IF NOT EXISTS egress_review_pending
  ON egress_review (created_at) WHERE released_at IS NULL AND dismissed_at IS NULL;
