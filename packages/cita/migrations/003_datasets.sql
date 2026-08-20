-- Внешние наборы данных, доступные контрактному исполнителю.
--
-- Адресат берётся ОТСЮДА, а не из постановки задачи. Причина та же, по которой
-- маршрут ответа не читается из текста: идентификатор внешней базы — это
-- адресация, и позволить содержимому её выбирать значило бы дать человеку
-- (или тексту, попавшему в обращение) указывать, куда системе ходить.
--
-- Имя секрета названо здесь, но значение хранится в custody арбитра, и выдаётся
-- оно только если секрет принадлежит владельцу запуска.
CREATE TABLE IF NOT EXISTS datasets (
  id            bigserial PRIMARY KEY,
  owner_slug    text NOT NULL,
  alias         text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('notion')),
  external_id   text NOT NULL,
  secret_name   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_slug, alias)
);
