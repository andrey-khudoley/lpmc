-- Демо-задачи, чтобы список не был пустым на свежем узле. Идемпотентно.
-- Владельцы соответствуют реально засеянным в схеме pact (internal, notion-demo).
INSERT INTO web_tasks (id, title, owner, status, prio, start_date, due_date, descr, dod, lina_text)
VALUES
  ('t1', 'Собрать заголовок публичной страницы example.com', 'internal', 'todo', 'высокий',
   '2026-08-21', '2026-08-22',
   'Сходить на публичную страницу и собрать данные — первый сценарий MITA.',
   'снимок экрана сделан; заголовок собран',
   E'цель: Собрать заголовок публичной страницы example.com\nвладелец: internal\nкритерии приёмки: снимок экрана сделан; заголовок собран'),
  ('t2', 'Запросить строки датасета Notion', 'notion-demo', 'todo', 'обычный',
   '2026-08-21', '2026-08-25',
   'Забрать строки из базы Notion через контрактную интеграцию CITA.',
   'строки получены; отчёт собран',
   E'цель: Запросить строки датасета Notion\nвладелец: notion-demo\nкритерии приёмки: строки получены; отчёт собран'),
  ('t3', 'Новая задача клиента', 'internal', 'todo', 'низкий',
   '2026-08-21', NULL, '', '',
   E'цель: Новая задача клиента\nвладелец: internal\nкритерии приёмки: —')
ON CONFLICT (id) DO NOTHING;

INSERT INTO web_dialogs (id, task_id, status, f_objective, f_owner, f_dod)
VALUES
  ('d1', 't1', 'draft', true, true, true),
  ('d2', 't2', 'draft', true, true, true),
  ('d3', 't3', 'draft', true, true, false)
ON CONFLICT (id) DO NOTHING;
