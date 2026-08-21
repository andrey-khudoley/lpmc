-- Схема веб-интерфейса LPMC. Здесь живёт богатая модель задач, которую показывает
-- сайт: задача с полями (статус, владелец, приоритет, сроки, текст задачи для
-- Лины), её диалог квалификации и сообщения. Это фронтендная модель поверх
-- контуров: до передачи исполнителю задачей владеет веб, после — арбитр PACT.
--
-- Схема принадлежит роли lpmc-web и отделена от схем контуров: веб не пишет в
-- чужие хранилища. Данные политики (владельцы, правила, секреты) веб только
-- читает из схемы pact по отдельно выданным правам.

-- Задача — единица работы, которую ставит человек и доводит Лина.
CREATE TABLE IF NOT EXISTS web_tasks (
  id           text PRIMARY KEY,
  title        text NOT NULL,
  owner        text NOT NULL,
  status       text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done')),
  prio         text NOT NULL DEFAULT 'обычный' CHECK (prio IN ('высокий','обычный','низкий')),
  start_date   date,
  due_date     date,
  descr        text NOT NULL DEFAULT '',
  -- Критерии приёмки (DoD) — отдельным полем, чтобы промпт собирался из полей.
  dod          text NOT NULL DEFAULT '',
  -- «текст задачи для Lina» — промпт, который Лина обновляет при каждом уточнении.
  lina_text    text NOT NULL DEFAULT '',
  -- Передана ли исполнителю. После передачи поля задачи фиксируются.
  handed       boolean NOT NULL DEFAULT false,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Комментарии к задаче (человеческие заметки, не сообщения диалога).
CREATE TABLE IF NOT EXISTS web_comments (
  id         bigserial PRIMARY KEY,
  task_id    text NOT NULL REFERENCES web_tasks(id) ON DELETE CASCADE,
  author     text NOT NULL,
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Диалог квалификации: один на задачу. Флаги полноты — objective/owner/dod.
CREATE TABLE IF NOT EXISTS web_dialogs (
  id           text PRIMARY KEY,
  task_id      text NOT NULL REFERENCES web_tasks(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','awaiting','working','result','done','rejected')),
  f_objective  boolean NOT NULL DEFAULT false,
  f_owner      boolean NOT NULL DEFAULT false,
  f_dod        boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS web_dialogs_task ON web_dialogs (task_id);

-- Сообщения диалога. kind задаёт тип (you/reply/note/question/result/…),
-- payload — поля, зависящие от типа (текст, поле вопроса, ответ, артефакты…).
CREATE TABLE IF NOT EXISTS web_messages (
  id         bigserial PRIMARY KEY,
  dialog_id  text NOT NULL REFERENCES web_dialogs(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_messages_dialog ON web_messages (dialog_id, id);
