-- Схема арбитра. Всё, что здесь лежит, принадлежит PACT и не читается соседями:
-- права выданы так, что чужая схема недоступна даже на чтение.
--
-- Записи этой схемы — источник ответа на вопрос «на каком основании было выдано
-- право», задаваемый постфактум. Поэтому журнал вердиктов пишется в той же
-- транзакции, что и переход состояния: состояние без записи о причине бессмысленно.

CREATE TABLE IF NOT EXISTS owners (
  slug        text PRIMARY KEY,
  category    text NOT NULL CHECK (category IN ('client', 'project', 'internal')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Таблица правил. Меняется без выкатки кода, но версионируется: версия попадает
-- в вердикт, и по ней постфактум восстанавливается основание (D-027).
CREATE TABLE IF NOT EXISTS rules (
  id                  bigserial PRIMARY KEY,
  ruleset_version     integer NOT NULL,
  sender              text NOT NULL,
  owner_slug          text NOT NULL REFERENCES owners(slug),
  capabilities        text[] NOT NULL,
  executor            text NOT NULL,
  lease_ttl_seconds   integer NOT NULL,
  requires_approval   boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rules_lookup ON rules (ruleset_version, sender, owner_slug);

CREATE TABLE IF NOT EXISTS tasks (
  task_id          uuid PRIMARY KEY,
  owner_slug       text NOT NULL REFERENCES owners(slug),
  state            text NOT NULL,
  reply_route_id   text NOT NULL,
  objective        text NOT NULL,
  dod              jsonb NOT NULL,
  -- Ключ дедупликации уровня задачи: повтор одного и того же обращения
  -- не создаёт вторую задачу (D-023, уровень «задача»).
  idempotency_key  text NOT NULL UNIQUE,
  correlation_id   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Журнал вердиктов: одна строка на каждый переход состояния. Причина, версия
-- таблиц правил и событие-причина обязательны — без них переход не объясним.
CREATE TABLE IF NOT EXISTS verdicts (
  id                    bigserial PRIMARY KEY,
  task_id               uuid NOT NULL REFERENCES tasks(task_id),
  from_state            text,
  to_state              text NOT NULL,
  kind                  text CHECK (kind IN ('REJECTED', 'DENIED')),
  reason                text NOT NULL,
  ruleset_version       integer,
  granted_capabilities  text[],
  cause_event_id        text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verdicts_by_task ON verdicts (task_id, id);

CREATE TABLE IF NOT EXISTS leases (
  lease_id              uuid PRIMARY KEY,
  task_id               uuid NOT NULL REFERENCES tasks(task_id),
  run_id                uuid NOT NULL,
  executor              text NOT NULL,
  generation            integer NOT NULL,
  granted_capabilities  text[] NOT NULL,
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Одновременно действующий лизинг на задачу — один (PACT 5.4 п. 6).
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active
  ON leases (task_id) WHERE revoked_at IS NULL;

-- Transactional outbox: запись состояния и запись события уходят ОДНОЙ транзакцией.
-- Без этого возможна задача в LEASED без опубликованного события и наоборот
-- (SPEC §15.4). Публикацию в брокер выполняет отдельный ретранслятор.
CREATE TABLE IF NOT EXISTS outbox (
  id              bigserial PRIMARY KEY,
  subject         text NOT NULL,
  event_type      text NOT NULL,
  schema_version  text NOT NULL,
  payload         jsonb NOT NULL,
  correlation_id  text NOT NULL,
  causation_id    text,
  dedup_key       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
