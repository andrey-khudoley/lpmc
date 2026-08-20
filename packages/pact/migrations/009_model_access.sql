-- Доступ служб системы к API модели.
--
-- Обращение к модели — такое же внешнее обращение, как поход браузера на сайт
-- (D-026), и идёт тем же путём: через прокси, по привязке, выданной арбитром.
-- Разница одна — у службы нет ни задачи, ни лизинга, поэтому основанием служит
-- строка этой таблицы, а не реестр задач.
--
-- Пустая таблица запрещает обращения к модели всем. Это рабочее состояние узла,
-- которому ещё не назначили ни одного разрешённого адресата модели.
CREATE TABLE IF NOT EXISTS model_endpoints (
  id               bigserial PRIMARY KEY,
  ruleset_version  integer NOT NULL,
  service          text NOT NULL,
  host             text NOT NULL,
  methods          text[] NOT NULL,
  -- Имя ключа в реестре секретов. Значение хранится в custody и выдаётся
  -- вместе с привязкой; здесь лежит только имя.
  secret_name      text NOT NULL,
  ttl_seconds      integer NOT NULL DEFAULT 900,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS model_endpoints_key
  ON model_endpoints (ruleset_version, service, host);

-- Журнал выдачи доступа к модели: кто, когда, к какому адресату и чем кончилось.
CREATE TABLE IF NOT EXISTS model_access_log (
  id           bigserial PRIMARY KEY,
  service      text NOT NULL,
  host         text,
  outcome      text NOT NULL,
  reason       text NOT NULL,
  expires_at   timestamptz,
  issued_at    timestamptz NOT NULL DEFAULT now()
);
