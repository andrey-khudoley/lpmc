-- Разрешённые внешние адресаты и журнал выдачи учётных данных запуска.

-- Allowlist «хост × метод» принадлежит PACT: политика и её принуждение не должны
-- расходиться. Прокси на узле проверяет своё, но набор из токена запуска —
-- отсюда, и разрешено только пересечение. Пустая таблица запрещает всё.
CREATE TABLE IF NOT EXISTS egress_allow (
  id               bigserial PRIMARY KEY,
  ruleset_version  integer NOT NULL,
  owner_slug       text NOT NULL,
  host             text NOT NULL,
  methods          text[] NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS egress_allow_lookup ON egress_allow (ruleset_version, owner_slug);

-- Журнал выдачи учётных данных прокси. Секрет здесь не хранится: он выдаётся
-- один раз предъявителю и живёт только в памяти прокси — хешем. Хранить его
-- означало бы завести копию, которой можно воспользоваться позже.
CREATE TABLE IF NOT EXISTS proxy_issuances (
  id           bigserial PRIMARY KEY,
  run_id       uuid NOT NULL,
  task_id      uuid NOT NULL,
  lease_id     uuid NOT NULL,
  generation   integer NOT NULL,
  executor     text NOT NULL,
  allow        jsonb NOT NULL,
  expires_at   timestamptz NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  issued_to    text NOT NULL
);
CREATE INDEX IF NOT EXISTS proxy_issuances_run ON proxy_issuances (run_id, issued_at);
