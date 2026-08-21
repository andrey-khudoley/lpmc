-- Ассистент админки становится раздельным: у каждого раздела (клиенты, правила,
-- эндпоинты, типы задач) — своя лента и свой жёстко заданный тип сущности, чтобы
-- не приходилось называть тип в запросе. Признак раздела — scope.

ALTER TABLE web_admin_inbox ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS web_admin_inbox_scope ON web_admin_inbox (scope, id);
