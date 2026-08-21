-- Архив задач веб-интерфейса.
--
-- Задачи живут в двух местах: здесь — фронтендная модель (web_tasks), в схеме
-- pact — задача арбитра с журналом вердиктов. Архивирование владельца скрывает
-- и те, и другие, поэтому признак нужен по обе стороны: pact.tasks.archived_at
-- заводится миграцией 015_owner_lifecycle, web_tasks.archived_at — здесь.
--
-- Скрытие, а не удаление: архивная задача остаётся в базе со своим диалогом и
-- комментариями и возвращается вместе с владельцем.

ALTER TABLE web_tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS web_tasks_active ON web_tasks (owner) WHERE archived_at IS NULL;
