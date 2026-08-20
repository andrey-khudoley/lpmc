-- Проверка исходящего: правила и журнал решений.
--
-- Egress Guard — единственный продюсер топиков внешней доставки. Его решение
-- отвечает на вопрос «почему это ушло наружу», задаваемый постфактум, поэтому
-- журнал пишется в той же транзакции, что и само решение.

-- Правила исходящего. Пустая таблица запрещает всё (D-014): механизм есть,
-- наполнения нет — значит, наружу не уходит ничего. Это не заглушка, а рабочее
-- состояние системы, у которой ещё не заведено ни одного разрешения.
--
-- Разрешение выдаётся КЛАССУ содержимого в канале, а не тексту: текст проверить
-- нечем. Владелец «*» означает «любой» и заводится осознанно.
CREATE TABLE IF NOT EXISTS egress_rules (
  id               bigserial PRIMARY KEY,
  ruleset_version  integer NOT NULL,
  owner_slug       text NOT NULL,
  channel          text NOT NULL,
  content_class    text NOT NULL,
  max_chars        integer NOT NULL DEFAULT 4000,
  decision         text NOT NULL CHECK (decision IN ('allow', 'deny')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS egress_rules_lookup
  ON egress_rules (ruleset_version, channel, content_class);

-- Журнал решений. Ключ — тождество предложения: повторная обработка того же
-- предложения обязана дать ту же запись, а не вторую.
CREATE TABLE IF NOT EXISTS egress_decisions (
  proposal_id      uuid PRIMARY KEY,
  reply_route_id   uuid NOT NULL,
  channel          text NOT NULL,
  content_class    text NOT NULL,
  owner_slug       text,
  task_id          uuid,
  decision         text NOT NULL CHECK (decision IN ('ALLOWED', 'REJECTED', 'DENIED')),
  reason           text NOT NULL,
  ruleset_version  integer,
  chars            integer NOT NULL,
  decided_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS egress_decisions_route
  ON egress_decisions (reply_route_id, decided_at);

-- Прикладная дедупликация потребителей (D-023). Окно брокера — оптимизация,
-- а гарантию даёт эта таблица: событие, уже обработанное данным потребителем,
-- повторно не обрабатывается, сколько бы раз брокер его ни выдал.
--
-- Ключ составной: одно и то же событие законно обрабатывают разные потребители,
-- и отметка одного не должна закрывать его для другого.
CREATE TABLE IF NOT EXISTS consumed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  consumed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

