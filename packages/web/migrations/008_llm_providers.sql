-- Провайдеры модели для веб-ассистента с приоритетом (цепочка фейловера).
--
-- Ассистент админки интерпретирует запрос оператора моделью. Провайдеров может
-- быть несколько; запрос идёт по возрастанию priority, и при отказе (протухший
-- токен подписки, нет ключа, недостаточный баланс, ошибка вендора) переходит к
-- следующему, пока не выполнится. Ключи — секреты веб-консоли; наружу (в API)
-- их значения не отдаются, виден только признак «задан».
--
-- kind: subscription (OAuth-токен подписки, Bearer+beta), anthropic (x-api-key),
-- openai (Bearer). api_key для subscription хранит OAuth-токен (сессионный,
-- протухает — тогда и срабатывает фейловер, ради которого всё и заведено).

CREATE TABLE IF NOT EXISTS web_llm_providers (
  id         bigserial PRIMARY KEY,
  kind       text        NOT NULL UNIQUE,          -- subscription | anthropic | openai
  enabled    boolean     NOT NULL DEFAULT false,
  model      text        NOT NULL DEFAULT '',
  api_key    text        NOT NULL DEFAULT '',
  priority   integer     NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO web_llm_providers (kind, enabled, model, priority) VALUES
  ('subscription', false, 'claude-sonnet-4-5', 1),
  ('anthropic',    false, 'claude-sonnet-4-5', 2),
  ('openai',       false, 'gpt-4o-mini',       3)
ON CONFLICT (kind) DO NOTHING;
