-- Подтверждение необратимого действия человеком (W2-PACT-03, W2-PACT-04).
--
-- Решение принимается ДОВЕРЕННЫМ ПУТЁМ: человек открывает одноразовую ссылку,
-- видит, что именно будет сделано, и подтверждает. Путь не проходит через LINA
-- (W2-LINA-01): недоверенный контур в лучшем случае доставляет непрозрачное
-- значение, но не участвует в решении.
--
-- Привязка решения — по одноразовому значению, задаче и ВЕРСИИ набора
-- полномочий, а не по «последнему запросу»: иначе подтверждение, выданное
-- на одно действие, годилось бы для другого.
CREATE TABLE IF NOT EXISTS approvals (
  approval_id          uuid PRIMARY KEY,
  task_id              uuid NOT NULL,
  run_id               uuid NOT NULL,
  owner_slug           text NOT NULL,
  reply_route_id       text NOT NULL,
  channel              text NOT NULL,
  adapter_id           text NOT NULL,
  -- Что именно подтверждается: хост, тип операции и человекочитаемое описание,
  -- составленное исполнителем. Описание показывается человеку, но решение
  -- привязано к первым двум — текст не может расширить разрешаемое.
  host                 text NOT NULL,
  operation_type       text NOT NULL,
  description          text NOT NULL,
  capabilities         text[] NOT NULL,
  ruleset_version      integer,
  -- Одноразовое значение ссылки. Хранится как есть: оно живёт минуты, действует
  -- один раз и не является секретом длительного пользования.
  token                text NOT NULL UNIQUE,
  claimed_by           text,
  state                text NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  decided_at           timestamptz,
  decided_by           text,
  resumed_run_id       uuid
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals (task_id) WHERE state = 'pending';

-- Выдачи секретов со сроком (W2-PACT-01). Прежде выдача не оставляла следа
-- со сроком действия, и «действующая выдача» было понятием без данных —
-- а именно на него опирается набор сверки проверки исходящего (W2-PACT-02).
CREATE TABLE IF NOT EXISTS secret_issuances (
  issuance_id   uuid PRIMARY KEY,
  name          text NOT NULL,
  run_id        uuid,
  lease_id      uuid,
  issued_to     text NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS secret_issuances_active
  ON secret_issuances (expires_at) WHERE revoked_at IS NULL;

-- Набор сверки проверки исходящего связывается с выдачей: отозванная выдача
-- продолжает проверяться ещё некоторое время — значение, утёкшее до отзыва,
-- не перестаёт быть опасным в момент отзыва.
ALTER TABLE egress_secret_digests ADD COLUMN IF NOT EXISTS issuance_id uuid;
ALTER TABLE egress_secret_digests ADD COLUMN IF NOT EXISTS check_until timestamptz;
CREATE INDEX IF NOT EXISTS egress_secret_digests_window
  ON egress_secret_digests (check_until) WHERE revoked_at IS NULL;
