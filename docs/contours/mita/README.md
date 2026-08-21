# Индекс документации участка MITA

Дата среза: 2026-08-09 (по состоянию журналов и research/allocation.md; дата чтения — 2026-08-10).

Статус контура: **работающая система сегодня одна — репозиторий `cloud-tech-tasks`, реконструируемый как
контур MITA.** Контур MITA в том виде, как он описан в `docs/spec/spec.md`, не реализован: исполнитель
имеет прямой egress, сам читает секреты, сам решает о легитимности задачи и сам ведёт диалог с человеком
(перечень подмен — [`gaps-and-substitutions.md`](gaps-and-substitutions.md)). Работающая система живёт вне
этого воркспейса, в репозитории `/home/agent/workspaces/cloud-tech-tasks` (внутри исходников она называется
`cloud-tech-tasks`, действующее лицо — «main agent»; имя MITA закреплено 2026-08-09 как переименование
агентской учётной записи ESTA→MITA во внешних сервисах, а не переименование системы). LINA, PACT и CITA
не существуют вовсе.

## Правило разделения документов

- `docs/spec/spec.md` — **желаемое** состояние (spec-as-source). Спецификация имеет право описывать то,
  чего сегодня нет, и опережает воркспейс.
- `docs/adr/*.md` — архитектурные решения (одно решение = один файл), статус в каждом файле — реальный
  (Принято / Предложено / Отложено), а не желаемый.
- Всё остальное в `docs/**/*.md` (кроме `spec/` и `adr/`) — **текущее** состояние (docs-as-state) и не
  имеет права ссылаться на спецификацию за данными, кроме принципиально неизменных вещей (расшифровка
  имени контура, его место в общей схеме).

## docs-as-state

- [`overview.md`](overview.md) — что такое MITA сегодня: имя, назначение репозитория `cloud-tech-tasks`,
  состав верхнего уровня, чего сегодня нет.
- [`operating-model.md`](operating-model.md) — операционная модель: владельцы, жизненный цикл задачи, DoD,
  приоритет локального над общим, как сегодня отдаются команды.
- [`data-model.md`](data-model.md) — модель данных: сущности (владелец, сервис, задача, заметка, журнал,
  плейбук, шаблон), их файловое представление и frontmatter, связи между собой, сводная таблица конвенций
  именования; фиксирует расхождение с `research/allocation.md` — `templates/task.md` фактически существует.
- [`playbooks.md`](playbooks.md) — что такое плейбук, шаблон `templates/playbook.md`, приоритет клиентских
  плейбуков над общими, разбор единственного общего плейбука `captcha-escalation.md` по самому файлу.
- [`agent-toolkit.md`](agent-toolkit.md) — канон `.agents/` и сборка: принцип «один источник — N вендорных
  проекций», три типа сущностей и их frontmatter, матрица доставки для Claude Code и Codex CLI, сборщик
  `scripts/agents.mjs` (build/check/lint), `generated.lock.json`, требование `core.symlinks`, фактические
  ограничения (`tools` не работает под Codex CLI, `.codex/config.toml` проектным клиентом не читается).
- [`agent-roles.md`](agent-roles.md) — содержимое канона: четыре роли (`task-executor`, `service-scout`,
  `qualifier`, `librarian`) с `tools`/`profile`, шесть скиллов, две команды (`/new-task`, `/task`),
  соответствие роль↔скилл; явно фиксирует, что `librarian`/`add-owner`/`migrate-legacy`/`status` —
  служебная гигиена MITA вне четырёхконтурной модели.
- [`policy.md`](policy.md) — разбор всех 14 файлов `.agents/policy/common/` по назначению каждого;
  механизм инжекции общей политики целиком (без выборочных списков) и его обоснование из
  `.agents/ARCHITECTURE.md`; запрет делегированной роли обращаться к пользователю напрямую; модель
  угроз промпт-инъекций `notes/2026-08/2026-08-05-prompt-injection-threat-model.md` как действующий
  внутренний документ, а не архив.
- [`secrets.md`](secrets.md) — обращение с секретами как есть: каталог `.secrets/` вне git (env на
  10 ключей, TOTP-seed base32, снимки storage-state), три категории секретов, схема имён
  `<client>/<service>/<field>` и слаг `shared`, запрет `source .secrets/env`, прямое чтение
  значений исполнителем без посредника, что защищает от утечки в git, ротация на практике,
  задокументированные грабли (инцидент с правами `644`, storage-state шире собственного имени).
- [`llm-journals.md`](llm-journals.md) — каталог `llm/`: отличие от `notes/`, структура и именование,
  общесистемные vs владельческие журналы, маскирование секретов, append-only и практика реконструкции
  пропущенного журнала (раздел «Утрачено»), фактические объёмы — 44 журнала сессий на срез 2026-08-09.
- [`services.md`](services.md) — реестр `services/`: 4 сервиса (bizon365, chatium, gc-chatium-gateway,
  kinescope) + `INDEX.md`, состав карточки сервиса, что в неё сегодня свалено за отсутствием PACT/CITA.
- [`runtime/browser.md`](runtime/browser.md) — браузерный стек: четыре инстанса (default/larina/neso/
  internal) под общим системным пользователем `kiosk-browser`, CDP-порты 9222–9225, headed-режим,
  конфигурация вне репозитория в `/var/lib/infra/src` (роль `kiosk_browser`), `infra/playwright/` и
  `infra/web-browser/` в самом репозитории.
- [`runtime/human-view.md`](runtime/human-view.md) — аварийный просмотр сессии человеком: `infra/web-
  browser/view.sh`, nginx на порту 22325, одноразовый путь и TTL 30 минут, кто сегодня решает о выдаче
  ссылки (сама MITA, PACT не существует).
- [`runtime/knowledge-search.md`](runtime/knowledge-search.md) — гибридный локальный поиск obsidian-
  hybrid-search: MCP `knowledge-search`, индекс `var/knowledge-search/index.db`, переиндексация внутри
  `.githooks/pre-commit`.
- [`runtime/local-state.md`](runtime/local-state.md) — каталог `var/` и вспомогательные скрипты:
  `var/login-checks/*.mjs`, 27 скриптов `var/kinescope/*.mjs`, что из этого не попадает в git
  (`.gitignore`).
- [`gaps-and-substitutions.md`](gaps-and-substitutions.md) — честный перечень подмен: MITA ведёт диалог
  с человеком (за LINA), сама решает о легитимности и владельце задачи и сама читает секреты (за PACT),
  сама решает, что отдать человеку в отчёте (за egress PACT); egress-контроля нет вообще (`chain output`
  в nftables существует, но пуста и имеет `policy accept`, как и `chain forward`); PACT/LINA/CITA не
  существуют, OpenClaw не установлен, webapp и брокер событий не реализованы; плюс расхождения источников
  и открытые вопросы участка.

## docs/spec/

- [`spec/spec.md`](spec/spec.md) — черновик спецификации контура MITA (желаемое состояние); описывает
  границы контура, capability, custody секретов и то, чего сегодня не существует, со ссылками на
  `CONTOURS.md`, `SPECIFICATION.md`, `DECISIONS.md` (D-001…D-012), `REVIEW-FINDINGS.md`, `STAGE-0.md`.
  Редакция 2 (2026-08-10) добавила жизненный цикл запуска с приостановкой, возобновлением и отменой (§5.6),
  закрытый перечень типизированных причин (§5.7), контракт хранилища артефактов (§12.6) и критерии приёмки
  контура, включая негативные (§24); открытые вопросы уровня системы перенумерованы в §25.
- [`spec/layout.md`](spec/layout.md) — целевая раскладка каталогов и файлов контура, выведенная из
  спецификации: верхний уровень, каталог владельца, рабочая тетрадь запуска (`runs/`), хранилище артефактов
  (`artifacts/`), конфигурация; узлы, которых намеренно нет; таблица «что сегодня где и куда уходит»
  с привязкой к свойствам §22 (идентификаторы `Ц-n` — не порядковые). Раскладка — внутреннее устройство
  MITA, а не контракт с соседями. Три корня
  владельцев (`clients/`, `projects/`, `internal/`) по ADR-0010 сохраняются и становятся проекцией реестра
  PACT только для чтения; разбор совместимости — §11 этого документа.

## docs/adr/

- [`adr/0001-chetyre-kontura-i-mesto-mita.md`](adr/0001-chetyre-kontura-i-mesto-mita.md) — Принято.
  Декомпозиция системы на четыре контура и место MITA в этом разрезе.
- [`adr/0002-imya-i-granicy-kontura-mita.md`](adr/0002-imya-i-granicy-kontura-mita.md) — Принято.
  Имя контура MITA и критерий отнесения задачи к этому контуру.
- [`adr/0003-ispolnitel-bez-pryamogo-egress.md`](adr/0003-ispolnitel-bez-pryamogo-egress.md) — Принято.
  Исполнитель не имеет прямого исходящего доступа; egress-proxy как механизм принуждения границы.
- [`adr/0004-approval-na-neobratimye-deystviya.md`](adr/0004-approval-na-neobratimye-deystviya.md) — Принято.
  Необратимые действия в MITA требуют явного approval.
- [`adr/0005-capability-bez-modalnosti.md`](adr/0005-capability-bez-modalnosti.md) — Принято.
  Capability не содержит указания на модальность исполнения.
- [`adr/0006-variant-realizacii-gibrid-i-openclaw.md`](adr/0006-variant-realizacii-gibrid-i-openclaw.md) — Предложено.
  Гибрид на готовом шлюзе как вариант реализации; OpenClaw на контуре исполнения отложен.
- [`adr/0007-headed-brauzer-vmesto-headless.md`](adr/0007-headed-brauzer-vmesto-headless.md) — Принято.
  Браузер работает в headed-режиме с реальным экраном, а не headless.
- [`adr/0008-brauzernyy-instans-na-vladelca.md`](adr/0008-brauzernyy-instans-na-vladelca.md) — Принято.
  Один браузерный инстанс на владельца; конфигурация только через Ansible-роль узла.
- [`adr/0009-obshchiy-sekret-ne-obshchaya-sessiya.md`](adr/0009-obshchiy-sekret-ne-obshchaya-sessiya.md) — Принято.
  Общий секрет не означает общую сессию; слаг `shared` для общих учётных записей.
- [`adr/0010-razdelenie-clients-projects-internal.md`](adr/0010-razdelenie-clients-projects-internal.md) — Принято.
  Владельцы физически разделены на `clients/` / `projects/` / `internal/`.
- [`adr/0011-model-hraneniya-sekretov-v-repozitorii.md`](adr/0011-model-hraneniya-sekretov-v-repozitorii.md) — Принято.
  Секреты хранятся плоскими файлами в `.secrets/` и никогда не проходят через shell.
- [`adr/0012-storage-state-sekret-vysshey-kategorii.md`](adr/0012-storage-state-sekret-vysshey-kategorii.md) — Предложено.
  Storage-state — секрет высшей категории; фильтрация по домену обязательна.
- [`adr/0013-kanon-agents-odin-istochnik-n-proekciy.md`](adr/0013-kanon-agents-odin-istochnik-n-proekciy.md) — Принято.
  Агентский тулинг: один канонический источник (`.agents/`) и N вендорных проекций.
- [`adr/0014-semantika-bezopasnosti-ne-zavisit-ot-ignoriruemyh-metadannyh.md`](adr/0014-semantika-bezopasnosti-ne-zavisit-ot-ignoriruemyh-metadannyh.md) — Принято.
  Семантика безопасности не может зависеть от метаданных, которые клиент игнорирует (Codex CLI не применяет `tools`).
- [`adr/0015-lokalnyy-pre-commit-vmesto-vneshnego-ci.md`](adr/0015-lokalnyy-pre-commit-vmesto-vneshnego-ci.md) — Принято.
  Механический контроль качества — локальный pre-commit, внешний CI снят.
- [`adr/0016-priyom-postanovok-iz-telegram-peresmatrivaetsya.md`](adr/0016-priyom-postanovok-iz-telegram-peresmatrivaetsya.md) — Отложено.
  Приём постановок из Telegram напрямую в MITA пересматривается в пользу LINA.
- [`adr/0017-broker-nats-jetstream-i-sostoyanie-v-postgresql.md`](adr/0017-broker-nats-jetstream-i-sostoyanie-v-postgresql.md) — Принято.
  Транспорт событий — NATS JetStream (локально на узле), состояние — PostgreSQL; D-012 принят 2026-08-11.
  Право публикации в `outbound.*` отсутствует у исполнителя на уровне ACL брокера, а не по соглашению (Н-16).
- [`adr/0019-mita-pervyy-ispolnitel-karkas-bez-sekretov.md`](adr/0019-mita-pervyy-ispolnitel-karkas-bez-sekretov.md) — Принято.
  MITA разворачивается первым из исполнителей (D-014). Объём первой волны сужается отсутствием
  аутентификации, а не упрощением механизмов: браузер через прокси с первого дня, MITM-подстановка —
  со второй волны, вместе с первым реальным сервисом.
- [`adr/0018-volny-narashchivayut-obyom-a-ne-ustroystvo.md`](adr/0018-volny-narashchivayut-obyom-a-ne-ustroystvo.md) — Принято.
  Волна ограничивает объём, а не устройство (D-013). `Ц-n` в §22 — стабильные идентификаторы целевых
  свойств, а не порядковые этапы: Ц-0…Ц-6 — условия запуска контура, откладывается только Ц-7. Контур разворачивается на второй волне
  отдельной единицей, контракты входа и выхода проектируются на первой как общие для обоих исполнителей.

## Что не реализовано на этом участке (не пересказ спецификации, только факт)

`webapp`, брокер событий, интеграция с Telegram, вынос секретов из `.secrets/` под custody PACT,
egress-проверка результата — в самой системе `cloud-tech-tasks` не реализованы; факт этого зафиксирован
в `docs/overview.md` §4. Как это должно быть устроено по желаемому состоянию — см. `docs/spec/spec.md`.
