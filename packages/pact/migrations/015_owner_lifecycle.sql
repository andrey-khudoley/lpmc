-- Жизненный цикл владельца: архив и полное удаление.
--
-- До этой миграции удаление владельца было невозможно: внешние ключи на
-- owners(slug) отбивали DELETE, а веб получал невнятное сообщение о нарушении
-- ограничения. Обе операции заводятся здесь, потому что различаются они не
-- глубиной, а тем, что происходит с аудитом.
--
-- АРХИВ — штатная операция. Владелец скрывается, его задачи скрываются, а всё,
-- чем он мог бы воспользоваться, отзывается немедленно: правила, привязки, имена
-- секретов (со значениями по каскаду) и снимки сессий удаляются. Архивный
-- владелец не резолвится приёмом (нет привязки — отказ на валидации, D-020) и не
-- получает прав (нет правил). Журнал вердиктов при этом цел: на вопрос «на каком
-- основании было выдано право» по архивному владельцу ответ по-прежнему есть.
--
-- УДАЛЕНИЕ — осознанно разрушающая операция раздела администрирования. Оно
-- стирает и аудит: задачи, вердикты, лизинги, подтверждения, решения о выдаче.
-- Это прямо противоречит свойству, ради которого заведена схема (см. шапку
-- 001_init.sql), и потому существует как отдельная именованная функция, а не как
-- ON DELETE CASCADE на внешних ключах: каскад сделал бы разрушение аудита
-- побочным эффектом любого DELETE, в том числе ошибочного.
--
-- Обе функции — SECURITY DEFINER. Веб-роль не имеет и не должна иметь DELETE на
-- журналах: она получает EXECUTE на эти две функции, и другого пути стереть
-- вердикт у неё нет. Тот же приём, что у моста lina.web_submit (005_web_bridge).

ALTER TABLE owners ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS owners_active ON owners (slug) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_by_owner ON tasks (owner_slug);

-- ---------------------------------------------------------------------------
-- Архив: скрыть владельца и его задачи, отозвать всё действующее.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION web_archive_owner(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
DECLARE
  v_secrets text[];
  n_sessions int; n_secrets int; n_rules int; n_bindings int; n_tasks int; n_custody int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM owners WHERE slug = p_slug) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'нет такого владельца');
  END IF;

  DELETE FROM session_snapshots WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;

  -- Журналы custody привязаны к ИМЕНИ секрета, а не к владельцу, и снимаются
  -- здесь же — вместе с именем. Иначе после архива связь «имя → владелец»
  -- потеряна, и последующее удаление владельца этих строк уже не найдёт: они
  -- останутся сиротами под именем, которое вправе занять другой владелец.
  -- Журнал вердиктов (основание выдачи права, §001_init) архив не трогает.
  SELECT coalesce(array_agg(name), '{}') INTO v_secrets FROM secret_names WHERE owner_slug = p_slug;
  DELETE FROM secret_access_log WHERE name = ANY(v_secrets);
  GET DIAGNOSTICS n_custody = ROW_COUNT;
  DELETE FROM secret_issuances WHERE name = ANY(v_secrets);
  GET DIAGNOSTICS n_secrets = ROW_COUNT; n_custody := n_custody + n_secrets;
  -- secret_values уходят каскадом от secret_names (008_secrets_and_irreversibility).
  DELETE FROM secret_names WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n_secrets = ROW_COUNT;
  DELETE FROM rules WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n_rules = ROW_COUNT;
  DELETE FROM owner_bindings WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n_bindings = ROW_COUNT;

  UPDATE tasks SET archived_at = now() WHERE owner_slug = p_slug AND archived_at IS NULL;
  GET DIAGNOSTICS n_tasks = ROW_COUNT;

  UPDATE owners SET archived_at = now() WHERE slug = p_slug AND archived_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'revoked', jsonb_build_object(
    'tasks_hidden', n_tasks, 'rules', n_rules, 'bindings', n_bindings,
    'secret_names', n_secrets, 'secret_journals', n_custody, 'session_snapshots', n_sessions));
END $$;

-- ---------------------------------------------------------------------------
-- Возврат из архива. Снимает скрытие; отозванное не восстанавливается —
-- правила, привязки и секреты заводятся заново. Разрешения на внешние адресаты
-- (egress_allow) архив не трогает, поэтому каталог эндпоинтов переживает возврат.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION web_unarchive_owner(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
DECLARE n_tasks int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM owners WHERE slug = p_slug) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'нет такого владельца');
  END IF;

  UPDATE tasks SET archived_at = NULL WHERE owner_slug = p_slug AND archived_at IS NOT NULL;
  GET DIAGNOSTICS n_tasks = ROW_COUNT;
  UPDATE owners SET archived_at = NULL WHERE slug = p_slug;

  RETURN jsonb_build_object('ok', true, 'tasks_restored', n_tasks);
END $$;

-- ---------------------------------------------------------------------------
-- Полное удаление владельца вместе с аудитом.
--
-- Порядок — от детей к родителям, одной транзакцией (тело функции и есть
-- транзакция): при ошибке на любом шаге не остаётся полуудалённого владельца.
--
-- Отдельно про таблицы БЕЗ внешнего ключа на owners: egress_allow, egress_rules,
-- egress_decisions, egress_review, approvals, proxy_issuances, candidates,
-- secret_access_log, secret_issuances. Каскад до них не дошёл бы никогда, а
-- слаг переиспользуем (addOwner — upsert): осиротевшая строка egress_allow
-- означала бы, что новый владелец с тем же слагом молча получил старый список
-- разрешённых внешних хостов. Поэтому они вычищаются явно.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION web_purge_owner(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
DECLARE
  v_tasks       uuid[];
  v_tasks_text  text[];
  v_secrets     text[];
  c             jsonb := '{}'::jsonb;
  n             int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM owners WHERE slug = p_slug) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'нет такого владельца');
  END IF;

  SELECT coalesce(array_agg(task_id), '{}') INTO v_tasks FROM tasks WHERE owner_slug = p_slug;
  SELECT coalesce(array_agg(name), '{}')    INTO v_secrets FROM secret_names WHERE owner_slug = p_slug;
  -- Тип task_id по таблицам неоднороден: uuid в verdicts, leases, proxy_issuances
  -- и candidates, но text в egress_decisions (переведён 005_egress_decisions_text_ids,
  -- чтобы записывался и отказ по непригодному значению) и в egress_review
  -- (010_egress_review). Для них сравниваем текстом, иначе «operator does not exist».
  v_tasks_text := ARRAY(SELECT unnest(v_tasks)::text);

  -- 1. Журналы, привязанные к задачам владельца.
  DELETE FROM verdicts WHERE task_id = ANY(v_tasks);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('verdicts', n);
  DELETE FROM leases WHERE task_id = ANY(v_tasks);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('leases', n);
  DELETE FROM proxy_issuances WHERE task_id = ANY(v_tasks);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('proxy_issuances', n);
  DELETE FROM candidates
    WHERE task_id = ANY(v_tasks) OR owner_resolved = p_slug OR owner_hint = p_slug;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('candidates', n);
  DELETE FROM approvals WHERE owner_slug = p_slug OR task_id = ANY(v_tasks);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('approvals', n);
  DELETE FROM egress_decisions WHERE owner_slug = p_slug OR task_id = ANY(v_tasks_text);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('egress_decisions', n);
  DELETE FROM egress_review WHERE owner_slug = p_slug OR task_id = ANY(v_tasks_text);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('egress_review', n);

  -- 2. Журналы custody, привязанные к именам секретов владельца.
  DELETE FROM secret_access_log WHERE name = ANY(v_secrets);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('secret_access_log', n);
  DELETE FROM secret_issuances WHERE name = ANY(v_secrets);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('secret_issuances', n);

  -- 3. Сами задачи (после того, как ссылающиеся на них строки сняты).
  DELETE FROM tasks WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('tasks', n);

  -- 4. Действующая конфигурация и custody.
  DELETE FROM session_snapshots WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('session_snapshots', n);
  DELETE FROM secret_names WHERE owner_slug = p_slug;  -- secret_values каскадом
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('secret_names', n);
  DELETE FROM rules WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('rules', n);
  DELETE FROM owner_bindings WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('owner_bindings', n);
  DELETE FROM egress_allow WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('egress_allow', n);
  DELETE FROM egress_rules WHERE owner_slug = p_slug;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('egress_rules', n);

  -- 5. Владелец.
  DELETE FROM owners WHERE slug = p_slug;

  RETURN jsonb_build_object('ok', true, 'deleted', c);
END $$;

-- Право вызова выдаётся адресно веб-роли (playbook), а не всем подряд.
REVOKE ALL ON FUNCTION web_archive_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION web_unarchive_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION web_purge_owner(text) FROM PUBLIC;
