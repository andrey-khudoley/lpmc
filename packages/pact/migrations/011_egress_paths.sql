-- Allowlist уточняется путями и явным типом операции.
--
-- Зачем пути. Договорные интерфейсы сплошь и рядом используют POST для чтения:
-- запрос строк базы Notion — это `POST /v1/data_sources/{id}/query`. Разрешить
-- «POST на api.notion.com» значило бы открыть заодно создание и изменение
-- страниц. Разрешение обязано быть не грубее, чем действие, которое нужно.
--
-- Зачем явный тип операции. Тип вычисляется из наблюдаемых признаков, и метод —
-- лишь один из них; путь наблюдаем ровно так же. Строка ниже говорит: «POST
-- по этому пути на этом хосте — чтение», и это утверждение человека, записанное
-- в таблицу, а не догадка кода. Значение 'auto' оставляет вывод по методу.
ALTER TABLE egress_allow ADD COLUMN IF NOT EXISTS path_prefixes text[] NOT NULL DEFAULT '{}';
ALTER TABLE egress_allow ADD COLUMN IF NOT EXISTS operation_type text NOT NULL DEFAULT 'auto';
ALTER TABLE egress_allow ADD CONSTRAINT egress_allow_operation_type
  CHECK (operation_type IN ('auto', 'read', 'write', 'delete'));
