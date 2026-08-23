-- Карта браузерных инстансов владельцев.
--
-- До сих пор соответствие «владелец → адрес CDP» жило умолчанием в коде MITA
-- ({"internal": "http://127.0.0.1:9322"}), поэтому браузерные задачи мог получать
-- только один владелец, а завести второго было нельзя ничем, кроме правки кода.
-- Профиль браузера принадлежит владельцу (W2-MITA-02): страница одного клиента
-- не должна видеть сессии другого, поэтому инстанс на владельца — не удобство,
-- а граница.
--
-- Здесь соответствие становится данными: панель ведёт карту, MITA её читает.
-- Что при этом НЕ меняется: сам процесс браузера заводит развёртывание. Панель
-- не управляет системными службами — иначе компонент, смотрящий в интернет,
-- получил бы право запускать процессы на узле. Поэтому карта отражает то, что
-- поднято ролью, и проверка сценария честно показывает расхождение.

CREATE TABLE IF NOT EXISTS browser_instances (
  owner_slug  text PRIMARY KEY,
  cdp_url     text        NOT NULL,
  note        text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

-- Первая волна: единственный инстанс, поднятый ролью. Строка заводится здесь,
-- чтобы поведение до и после миграции совпадало.
INSERT INTO browser_instances (owner_slug, cdp_url, note)
  VALUES ('internal', 'http://127.0.0.1:9322', 'инстанс первой волны')
  ON CONFLICT (owner_slug) DO NOTHING;

CREATE OR REPLACE FUNCTION web_browser_list()
RETURNS TABLE(owner_slug text, cdp_url text, note text, disabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
  SELECT owner_slug, cdp_url, note, (disabled_at IS NOT NULL) FROM browser_instances ORDER BY owner_slug
$$;

/**
 * Привязать владельца к адресу CDP. Адрес проверяется здесь: только loopback —
 * браузер обязан оставаться на узле, а не оказаться удалённым сервисом, к
 * которому уедут cookie владельца.
 */
CREATE OR REPLACE FUNCTION web_browser_assign(p_owner text, p_cdp text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM owners WHERE slug = p_owner AND archived_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'нет такого действующего владельца');
  END IF;
  IF p_cdp !~ '^http://127\.0\.0\.1:[0-9]{2,5}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'адрес обязан быть loopback: http://127.0.0.1:ПОРТ');
  END IF;
  IF EXISTS (SELECT 1 FROM browser_instances WHERE cdp_url = p_cdp AND owner_slug <> p_owner AND disabled_at IS NULL) THEN
    -- Один инстанс на двух владельцев — это общий профиль, то есть отмена
    -- изоляции. Отказ здесь дешевле, чем разбирательство потом.
    RETURN jsonb_build_object('ok', false, 'reason', 'этот адрес уже закреплён за другим владельцем');
  END IF;
  INSERT INTO browser_instances (owner_slug, cdp_url, note) VALUES (p_owner, p_cdp, coalesce(p_note, ''))
  ON CONFLICT (owner_slug) DO UPDATE SET cdp_url = EXCLUDED.cdp_url, note = EXCLUDED.note, disabled_at = NULL;
  RETURN jsonb_build_object('ok', true, 'owner', p_owner, 'cdp', p_cdp);
END $$;

CREATE OR REPLACE FUNCTION web_browser_remove(p_owner text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pact, pg_temp AS $$
BEGIN
  DELETE FROM browser_instances WHERE owner_slug = p_owner;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'такой записи нет'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION web_browser_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION web_browser_assign(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION web_browser_remove(text) FROM PUBLIC;
