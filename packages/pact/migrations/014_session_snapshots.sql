-- Снимки сессий внешних систем (W2-PACT-01, W2-MITA-01).
--
-- Значения не попадают исполнителю НИКОГДА: прокси подставляет Cookie сам,
-- на пути запроса. Исполнитель видит результат работы сайта, но не то, чем
-- система в нём представилась. Поэтому снимок хранится здесь, у арбитра,
-- и шифруется тем же конвертным способом, что и остальные секреты.
--
-- О радиусе поражения. Отфильтровать снимок по домену удаётся не всегда:
-- часть сервисов раскладывает сессию по нескольким доменам, и сузить её
-- механически нельзя. По решению P2-DEC-02 такие снимки допускаются, но
-- расширенный радиус фиксируется здесь и попадает в вердикт — человек должен
-- видеть, что утечка такого снимка задевает больше, чем одну задачу.
CREATE TABLE IF NOT EXISTS session_snapshots (
  id               bigserial PRIMARY KEY,
  owner_slug       text NOT NULL REFERENCES owners(slug),
  host             text NOT NULL,
  -- Отфильтрован ли снимок до одного домена.
  domain_filtered  boolean NOT NULL,
  blast_radius     text NOT NULL,
  wrapped_key      bytea NOT NULL,
  wrapped_key_iv   bytea NOT NULL,
  wrapped_key_tag  bytea NOT NULL,
  ciphertext       bytea NOT NULL,
  iv               bytea NOT NULL,
  tag              bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  UNIQUE (owner_slug, host)
);

-- Радиус поражения выданного снимка записывается в журнал выдачи: вердикт
-- обязан отвечать на вопрос «что именно было доступно этому запуску».
ALTER TABLE proxy_issuances ADD COLUMN IF NOT EXISTS session_hosts text[] NOT NULL DEFAULT '{}';
ALTER TABLE proxy_issuances ADD COLUMN IF NOT EXISTS blast_radius text;
