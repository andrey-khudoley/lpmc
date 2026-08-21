-- Ассистент админки: диалог, из которого оператор заводит сущности словами.
--
-- Та же идея, что общий диалог Лины по задачам (004_lina_inbox), но для раздела
-- администрирования: оператор описывает, что завести (клиента, эндпоинт, правило,
-- тип задачи), детерминированный разбор извлекает параметры и вызывает те же
-- функции, что и мастера. Одна лента на инсталляцию — это рабочий стол оператора.

CREATE TABLE IF NOT EXISTS web_admin_inbox (
  id         bigserial PRIMARY KEY,
  kind       text        NOT NULL,                 -- you | reply | note
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
