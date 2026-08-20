-- Схема исполнителя. Здесь нет ни правил, ни полномочий: MITA хранит то, что
-- сделала и что наблюдала, а не то, что ей разрешено. Разрешённое приходит
-- в авторизованной задаче на каждый запуск и не кэшируется — иначе отзыв
-- полномочий не был бы немедленным.

-- Проекция реестра владельцев ТОЛЬКО ДЛЯ ЧТЕНИЯ (PACT §9.2). Пополняется
-- событиями owners.updated.v1. Пустая проекция запрещает всё: задача с любым
-- владельцем будет отклонена до первого внешнего действия — это не сбой,
-- а состояние узла, которому ещё не сообщили ни одного владельца.
CREATE TABLE IF NOT EXISTS owners (
  slug        text PRIMARY KEY,
  category    text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Запуск. Ключ — run_id вместе с поколением лизинга: повторная доставка одного
-- запроса не повторяет внешнее действие, а публикует сохранённый результат
-- (MITA W1-07). Новое поколение — это НОВЫЙ запуск, а не повтор старого.
CREATE TABLE IF NOT EXISTS runs (
  run_id           uuid NOT NULL,
  generation       integer NOT NULL,
  task_id          uuid NOT NULL,
  owner_slug       text NOT NULL,
  lease_id         uuid NOT NULL,
  reply_route_id   text NOT NULL,
  granted          text[] NOT NULL,
  objective        text NOT NULL,
  dod              jsonb NOT NULL,
  status           text,
  reason           text,
  result           jsonb,
  workbook         text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  PRIMARY KEY (run_id, generation)
);

-- Артефакты адресуются непрозрачной ссылкой: знание пути в файловой системе
-- доступа не даёт, а знание ссылки не выдаёт ни владельца, ни задачу.
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_ref  uuid PRIMARY KEY,
  run_id        uuid NOT NULL,
  kind          text NOT NULL,
  media_type    text NOT NULL,
  bytes         integer NOT NULL,
  path          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts (run_id);

-- Проверка критериев приёмки. Каждый пункт — отдельная запись с отдельным
-- наблюдением: отметка по косвенному признаку оставляет пункт непроверенным,
-- и тогда итог не может быть completed (MITA W1-06).
CREATE TABLE IF NOT EXISTS dod_checks (
  id            bigserial PRIMARY KEY,
  run_id        uuid NOT NULL,
  item          text NOT NULL,
  verified      boolean NOT NULL,
  observation   text NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dod_checks_run ON dod_checks (run_id);

-- Значения, подлежащие маскированию в выходах. На первой волне таблица пуста,
-- потому что секретов исполнителю не выдают. Механизм существует с W1, чтобы
-- на W2 его не пришлось встраивать в уже написанные пути вывода.
CREATE TABLE IF NOT EXISTS mask_values (
  id          bigserial PRIMARY KEY,
  run_id      uuid,
  value       text NOT NULL,
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consumed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  consumed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id              bigserial PRIMARY KEY,
  subject         text NOT NULL,
  event_type      text NOT NULL,
  schema_version  text NOT NULL,
  payload         jsonb NOT NULL,
  correlation_id  text NOT NULL,
  causation_id    text,
  dedup_key       text,
  event_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_event_id ON outbox (event_id);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
