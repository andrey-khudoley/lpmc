-- Инструкции Лины: типы задач и что уточнять по каждому.
--
-- Квалификация обязательных полей (владелец, критерии) — детерминированная и
-- общая, но ЧТО именно уточнять и какими критериями измерять результат зависит
-- от рода задачи. Раньше это жило только в голове оператора; здесь заводится
-- редактируемый в админке справочник: по ключевым словам обращения Лина
-- подбирает тип и подсказывает, что уточнить и в какой форме записать критерии
-- приёмки (dod_template) — те самые закрытые формы, которые реально проверяет
-- исполнитель.

CREATE TABLE IF NOT EXISTS web_task_types (
  id           bigserial PRIMARY KEY,
  name         text        NOT NULL,
  keywords     text        NOT NULL DEFAULT '',   -- триггеры через запятую
  executor     text        NOT NULL DEFAULT '',   -- mita | cita | '' (любой)
  clarify      text        NOT NULL DEFAULT '',   -- что уточнить у пользователя
  dod_template text        NOT NULL DEFAULT '',   -- шаблон критериев приёмки
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Пример-затравка, чтобы раздел был не пустой и показывал смысл формы.
INSERT INTO web_task_types (name, keywords, executor, clarify, dod_template)
  SELECT 'Прочитать страницу и проверить строку',
         'прочитать, страница, строка, проверить, открыть, сайт, содержимое, тело',
         'mita',
         'целевой адрес (хост должен быть в allowlist); какую строку/текст искать на странице',
         'page-contains https://ХОСТ/ "ИСКОМАЯ СТРОКА"'
  WHERE NOT EXISTS (SELECT 1 FROM web_task_types);

INSERT INTO web_task_types (name, keywords, executor, clarify, dod_template)
  SELECT 'Проверить доступность страницы',
         'доступн, статус, код, открывается, живой, ping, http',
         'mita',
         'адрес страницы (хост из allowlist); ожидаемый код ответа',
         'http-status https://ХОСТ/ = 200'
  WHERE NOT EXISTS (SELECT 1 FROM web_task_types WHERE name = 'Проверить доступность страницы');
