-- Политика узла, управляемая во время работы.
--
-- Внешняя граница узла (перечень allow у прокси) до сих пор задавалась только
-- развёртыванием: чтобы разрешить новый хост, требовалось изменить роль и
-- прогнать её. Для узла с одним-двумя сценариями это правильно, но оператор,
-- который заводит сценарии один за другим, оказывается заперт: панель заводит
-- строку в egress_allow, а прокси всё равно отказывает, потому что вторая
-- граница осталась прежней. Отказ при этом выглядит как поломка, хотя механизм
-- работает как задумано (D-017).
--
-- Здесь граница узла становится ДАННЫМИ АРБИТРА: строки этой таблицы публикуются
-- прокси и складываются с базовым перечнем из роли. Три свойства сохраняются.
--
-- 1. Границ по-прежнему две, и обе проверяются на каждом запросе: набор из
--    токена запуска И перечень узла. Здесь меняется только способ изменения
--    второго перечня, а не то, что он существует.
-- 2. Веб границу не пишет. У веб-роли нет прав на эту таблицу — только право
--    вызвать функции web_policy_* (SECURITY DEFINER), которые проверяют состав
--    и ведут журнал. Компонент, смотрящий в интернет, не становится владельцем
--    политики.
-- 3. Прокси не спрашивает арбитра на каждом запросе: политика ему доставляется
--    (push) и хранится снимком, поэтому недоступность PACT не открывает и не
--    закрывает сеть внезапно.

CREATE TABLE IF NOT EXISTS node_policy (
  id          bigserial PRIMARY KEY,
  host        text        NOT NULL,
  methods     text[]      NOT NULL DEFAULT '{GET}',
  path_prefixes text[]    NOT NULL DEFAULT '{}',
  note        text        NOT NULL DEFAULT '',
  added_by    text        NOT NULL DEFAULT 'web',
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS node_policy_host_active
  ON node_policy (host) WHERE revoked_at IS NULL;

-- Журнал публикаций: что и когда ушло прокси. Нужен, чтобы расхождение между
-- намерением и принуждением было видно, а не выяснялось по симптомам.
CREATE TABLE IF NOT EXISTS node_policy_publications (
  id           bigserial PRIMARY KEY,
  hosts        text[]      NOT NULL,
  outcome      text        NOT NULL,
  reason       text        NOT NULL DEFAULT '',
  published_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Функции для веба. Веб получает EXECUTE и ничего сверх того.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION web_policy_list()
RETURNS TABLE(id bigint, host text, methods text[], path_prefixes text[], note text, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
  SELECT id, host, methods, path_prefixes, note, created_at
    FROM node_policy WHERE revoked_at IS NULL ORDER BY host
$$;

/**
 * Разрешить хост на границе узла. Состав проверяется здесь, а не у вызывающего:
 * имя хоста — только буквы, цифры, точка и дефис (иначе в перечень попал бы
 * шаблон, который прокси сравнивает буквально), методы — из закрытого набора.
 */
CREATE OR REPLACE FUNCTION web_policy_add(p_host text, p_methods text[], p_paths text[], p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
DECLARE v_methods text[]; m text;
BEGIN
  IF p_host !~ '^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'недопустимое имя хоста');
  END IF;
  v_methods := '{}';
  FOREACH m IN ARRAY coalesce(p_methods, '{}') LOOP
    IF upper(m) NOT IN ('GET','POST','PUT','PATCH','DELETE') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'недопустимый метод: ' || m);
    END IF;
    v_methods := array_append(v_methods, upper(m));
  END LOOP;
  IF array_length(v_methods, 1) IS NULL THEN v_methods := '{GET}'; END IF;

  INSERT INTO node_policy (host, methods, path_prefixes, note)
  VALUES (p_host, v_methods, coalesce(p_paths, '{}'), coalesce(p_note, ''))
  ON CONFLICT (host) WHERE revoked_at IS NULL
  DO UPDATE SET methods = EXCLUDED.methods, path_prefixes = EXCLUDED.path_prefixes, note = EXCLUDED.note;

  RETURN jsonb_build_object('ok', true, 'host', p_host, 'methods', v_methods);
END $$;

/** Отзыв разрешения. Строка остаётся в журнале — снимается только действие. */
CREATE OR REPLACE FUNCTION web_policy_revoke(p_host text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
BEGIN
  UPDATE node_policy SET revoked_at = now() WHERE host = p_host AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'такого разрешения нет'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION web_policy_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION web_policy_add(text, text[], text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION web_policy_revoke(text) FROM PUBLIC;
