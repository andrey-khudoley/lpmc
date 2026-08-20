-- Отпечатки действующих выдач секретов (W1-PACT-09).
-- Проверка исходящего не может «искать секреты в тексте»: она не знает, что
-- секрет, а хранить сами значения ради сверки означало бы завести вторую копию
-- секретов вне custody. Поэтому хранится солёный хеш и длина: привратник берёт
-- из текста все подстроки нужных длин и сверяет хеши.
--
-- На первой волне таблица пуста, потому что выдач нет. Пустой набор ничего
-- не находит — и это правильно: механизм существует и работает, находить ему
-- пока нечего. Заполнится он на второй волне вместе с custody.
CREATE TABLE IF NOT EXISTS egress_secret_digests (
  id          bigserial PRIMARY KEY,
  salt        text NOT NULL,
  digest      text NOT NULL,
  length      integer NOT NULL CHECK (length > 0),
  issued_for  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS egress_secret_digests_active
  ON egress_secret_digests (length) WHERE revoked_at IS NULL;
