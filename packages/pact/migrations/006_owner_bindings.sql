-- Привязки «отправитель + маршрут ответа → владелец» (D-020).
--
-- Владельца определяет доверенный компонент по этой таблице, а НЕ по полю
-- сообщения. Поле `recipient_candidate` из кандидата остаётся подсказкой: оно
-- сохраняется в аудите, и его расхождение с выведенным значением служит
-- признаком неполноты привязок — но правами не распоряжается.
--
-- Отсутствие привязки даёт отказ на валидации, а не догадку. Таблица заполняется
-- человеком: связь отправителя с владельцем — это утверждение о людях
-- и договорах, вывести его из содержимого сообщения нельзя.
CREATE TABLE IF NOT EXISTS owner_bindings (
  id              bigserial PRIMARY KEY,
  sender          text NOT NULL,
  reply_route_id  text,
  owner_slug      text NOT NULL REFERENCES owners(slug),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Привязка без маршрута действует для любого маршрута этого отправителя;
-- привязка с маршрутом — только для него, и она сильнее общей.
CREATE UNIQUE INDEX IF NOT EXISTS owner_bindings_sender_route
  ON owner_bindings (sender, coalesce(reply_route_id, ''));

-- Кандидат в задачу, как его увидел приём. Хранится отдельно от задачи, потому
-- что задача создаётся не всегда: отклонённый кандидат задачи не порождает,
-- но след обязан остаться — иначе на вопрос «почему обращение осталось без
-- ответа» отвечать будет нечем.
CREATE TABLE IF NOT EXISTS candidates (
  request_id       uuid PRIMARY KEY,
  sender           text NOT NULL,
  reply_route_id   text NOT NULL,
  channel          text NOT NULL,
  adapter_id       text NOT NULL,
  owner_hint       text,
  owner_resolved   text,
  task_id          uuid,
  outcome          text NOT NULL,
  reason           text NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now()
);
