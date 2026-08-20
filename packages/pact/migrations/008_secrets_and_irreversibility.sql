-- Два механизма первой волны, которые существуют пустыми.
--
-- Пустыми — не в смысле «заглушка», а в смысле «наполнения ещё нет». Строятся
-- они сейчас, потому что на второй волне их пришлось бы встраивать в уже
-- работающие пути, и каждый непройденный путь обнаруживался бы тем, что секрет
-- уже утёк или необратимое действие уже выполнено.

-- 1. Реестр ИМЁН секретов. Имя — это то, что просит исполнитель; значение
-- он не выбирает и не видит, пока не выдано. Пустой реестр означает, что любой
-- запрос значения завершается отказом: просить нечего.
CREATE TABLE IF NOT EXISTS secret_names (
  name         text PRIMARY KEY,
  owner_slug   text NOT NULL REFERENCES owners(slug),
  purpose      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 2. Хранилище значений: конвертное шифрование (D-024). Значение зашифровано
-- ключом данных, ключ данных — главным ключом, который лежит файлом вне базы
-- и вне её резервных копий. Дамп базы не раскрывает ни одного значения.
CREATE TABLE IF NOT EXISTS secret_values (
  name             text PRIMARY KEY REFERENCES secret_names(name) ON DELETE CASCADE,
  wrapped_key      bytea NOT NULL,
  wrapped_key_iv   bytea NOT NULL,
  wrapped_key_tag  bytea NOT NULL,
  ciphertext       bytea NOT NULL,
  iv               bytea NOT NULL,
  tag              bytea NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 3. Журнал обращений. Ведётся с первой волны и пишется ДО выдачи: запись
-- об отказе так же обязательна, как запись о выдаче. Иначе по журналу нельзя
-- отличить «никто не просил» от «журнал не вёлся».
CREATE TABLE IF NOT EXISTS secret_access_log (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  run_id       uuid,
  lease_id     uuid,
  requested_by text NOT NULL,
  outcome      text NOT NULL,
  reason       text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS secret_access_log_name ON secret_access_log (name, requested_at);

-- 4. Таблица обратимости операций. Ключ — «хост × тип операции», где тип
-- вычисляется из наблюдаемых признаков запроса, а не из намерения. Строки
-- в таблице НЕТ означает «неизвестно», а неизвестное считается необратимым.
--
-- Пустая таблица запрещает все необратимые операции — так объём первой волны
-- сужается механизмом, а не соглашением о том, что «мы пока так не делаем».
CREATE TABLE IF NOT EXISTS irreversibility (
  id               bigserial PRIMARY KEY,
  ruleset_version  integer NOT NULL,
  host             text NOT NULL,
  operation_type   text NOT NULL,
  classification   text NOT NULL CHECK (classification IN ('reversible', 'irreversible')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS irreversibility_key
  ON irreversibility (ruleset_version, host, operation_type);
