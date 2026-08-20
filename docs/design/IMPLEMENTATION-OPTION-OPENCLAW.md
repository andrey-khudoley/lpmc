# Вариант реализации Second System на базе OpenClaw

Статус: вариант для обсуждения  
Версия: Draft 0.1  
Дата: 2026-08-06  
Связанный документ: [базовая спецификация Second System](./SPECIFICATION.md)

## 1. Статус решения

Этот документ описывает альтернативный способ реализации Second System с использованием двух изолированных экземпляров OpenClaw.

Вариант не заменяет базовую спецификацию и не считается принятым решением. Он предназначен для сравнения со следующими альтернативами:

1. полностью самостоятельная реализация всех канальных адаптеров и Workers;
2. один экземпляр OpenClaw без внешнего брокера;
3. гибридная реализация с OpenClaw на границах системы и собственным событийным ядром.

Рассматриваемый в этом документе вариант — третий.

## 2. Краткое описание

OpenClaw используется в двух местах, где самостоятельная реализация наиболее дорога:

- как шлюз Telegram, Max и Web;
- как runtime для Codex и Claude Code.

Бизнесовая часть Second System остаётся самостоятельной:

- внешний брокер событий;
- квалификатор;
- адресная маршрутизация;
- `Task Ingress`;
- бизнесовый `Policy Gate`;
- реестр задач;
- схемы и версии событий;
- аудит, replay, outbox и DLQ.

Два экземпляра OpenClaw находятся в разных доверительных контурах:

- `OpenClaw Intake Gateway` работает с внешними отправителями и не имеет мощных инструментов;
- `OpenClaw Execution Gateway` работает с персональными credentials, workspaces и coding agents, но не принимает внешние сообщения напрямую.

## 3. Полная цепочка компонентов

Сокращённая схема из двух Gateway и брокера недостаточна: OpenClaw не имеет штатной подписки на NATS и требует интеграционных consumers.

Полная цепочка:

```text
Telegram / Max / Web
          ↕
OpenClaw Intake Gateway
          ↕
Intake Broker Bridge
          ↓
Event Broker
          ↓
Qualifier
          ↓
Domain Event Router
          ↓
Task Ingress
          ↓
Business Policy Gate
          ↓
Task Orchestrator
          ↓
Event Broker: run request
          ↓
Execution Task Runner
          ↕
OpenClaw Execution Gateway
          ↓
Execution Task Runner
          ↓
Event Broker: run and outbound events
          ↓
Intake Broker Bridge
          ↓
OpenClaw Intake Gateway
          ↓
Telegram / Max / Web
```

Оба блока `Event Broker` на схеме обозначают один физический брокер. Повторение показывает разные фазы потока и разные группы subjects.

## 4. Физические единицы развёртывания

Рекомендуемый состав:

| Deployment unit | Назначение | Происхождение |
|---|---|---|
| `openclaw-intake-gateway` | Каналы, нормализация и внешняя доставка | OpenClaw + конфигурация |
| `max-channel-plugin` | Интеграция с Max | Custom OpenClaw plugin |
| `intake-bridge-plugin` | Inbound hooks и блокировка локального agent run | Custom OpenClaw plugin |
| `intake-bridge-worker` | Outbox, NATS publisher/consumer и Gateway RPC | Custom service |
| `nats-jetstream` | Надёжная событийная шина | Готовая инфраструктура |
| `qualifier-service` | Квалификация обращений | Second System |
| `domain-event-router` | Проверка адресации и публикация в inbox | Second System |
| `task-control-plane` | Task Ingress, Policy Gate, Approval, Orchestrator | Second System |
| `execution-task-runner` | NATS consumer и клиент Execution Gateway | Custom service |
| `openclaw-execution-gateway` | Codex/Claude runtime, sessions, sandbox и approvals | OpenClaw + конфигурация |
| `postgresql` | Диалоги, tasks, outbox, idempotency и audit metadata | Готовая инфраструктура |
| `object-storage` | Вложения и крупные результаты | Готовая инфраструктура |

## 5. OpenClaw Intake Gateway

### 5.1. Назначение

Intake Gateway является двунаправленным шлюзом внешних коммуникаций. Он:

- принимает сообщения из Telegram, Max и Web;
- выполняет платформенную проверку и нормализацию;
- сохраняет channel, account, peer, thread и message identifiers;
- предоставляет media и reply metadata;
- отправляет исходящие сообщения в тот же канал;
- возвращает delivery receipt;
- не квалифицирует обращения;
- не выполняет персональные задачи.

### 5.2. Готовые возможности OpenClaw

OpenClaw предоставляет:

- Telegram channel;
- встроенный WebChat и Gateway API;
- channel sessions и routing;
- pairing и allowlists;
- DM/group policies;
- threading и reply-to;
- обработку медиа;
- chunking и форматирование ответов;
- outbound delivery и receipts;
- hooks и Plugin SDK.

Max отсутствует в актуальном официальном перечне каналов, поэтому для него потребуется отдельный channel plugin.

### 5.3. Развёртывание

Рекомендуемая изоляция:

```text
OS user: openclaw-intake
State:   /var/lib/openclaw-intake
Config:  /etc/openclaw-intake/openclaw.json
Network: loopback Gateway за доверенным reverse proxy
Secrets: только credentials Telegram, Max и Web
```

Credentials Codex, Claude Code, репозиториев и внутренних рабочих систем в этом контуре отсутствуют.

### 5.4. Политика инструментов

Минимальный профиль:

```text
exec: deny
filesystem write: deny
browser: deny
external MCP: deny
sandbox: all
DM scope: per-channel-peer
```

Если интеграционный hook даст сбой, intake-agent всё равно не должен получить опасные capabilities.

### 5.5. Почему OpenClaw

Использование OpenClaw исключает самостоятельную реализацию большей части платформенной периферии:

- webhook lifecycle;
- reconnect и rate limiting;
- media upload/download;
- reply и thread semantics;
- форматирование и chunking;
- pairing и allowlists;
- delivery receipts;
- WebSocket-протокол веб-чата;
- channel sessions;
- изменения API мессенджеров.

### 5.6. Оценка сложности

Ориентировочно для одного опытного backend-разработчика:

| Реализация | MVP | Production hardening |
|---|---:|---:|
| OpenClaw с Telegram и WebChat | 2–5 дней | 1–2 недели |
| Max plugin | 1–3 недели | 3–6 недель |
| Все три адаптера самостоятельно | 4–8 недель | 3–6 месяцев |

Оценка Max зависит от полноты, стабильности и ограничений его Bot API.

## 6. Intake Broker Bridge

### 6.1. Назначение

Broker Bridge соединяет внутреннюю модель сообщений OpenClaw с контрактами событий Second System.

Он выполняет четыре функции:

1. экспортирует входящие сообщения в брокер;
2. останавливает обычный OpenClaw agent run для внешнего сообщения;
3. читает исходящие события из брокера;
4. передаёт их в OpenClaw для доставки и публикует результат.

### 6.2. Рекомендуемое разделение

Bridge состоит из двух частей.

#### In-process plugin

Работает внутри Intake Gateway:

- наблюдает `message_received`;
- получает нормализованные channel facts и media metadata;
- записывает canonical event в локальный outbox;
- блокирует стандартный запуск модели через `before_agent_run`;
- не содержит бизнес-правил квалификации.

#### External bridge worker

Работает отдельным процессом:

- выгружает local outbox в JetStream;
- получает publish acknowledgement;
- читает `outbound.<channel>.<adapter-id>`;
- вызывает OpenClaw Gateway RPC для отправки сообщения;
- ведёт delivery ledger;
- публикует `delivery.succeeded`, `delivery.failed` или `delivery.ambiguous`.

Разделение защищает Gateway от зависания NATS consumer и позволяет независимо перезапускать интеграционный worker.

### 6.3. Входящий алгоритм

```text
message_received
→ построить canonical event
→ записать event и outbox row одной транзакцией
→ before_agent_run: block
→ outbox worker публикует в JetStream
→ получить JetStream acknowledgement
→ пометить outbox row опубликованной
```

Fire-and-forget публикация непосредственно из hook не является достаточной гарантией доставки.

### 6.4. Исходящий алгоритм

```text
получить outbound event
→ проверить JSON Schema
→ проверить channel, adapter_id и visibility=external
→ проверить delivery ledger по event_id
→ вызвать Gateway send RPC
→ получить MessageReceipt
→ записать receipt
→ опубликовать delivery result
→ подтвердить JetStream message
```

При неоднозначной ошибке после начала платформенной отправки событие переводится в `delivery.ambiguous`. Слепой retry может создать дублирующее сообщение пользователю.

### 6.5. Почему интеграция через OpenClaw plugin

Plugin получает готовые данные, которые иначе пришлось бы извлекать отдельно для каждого канала:

- session key;
- channel account;
- sender и chat identifiers;
- thread и reply-to;
- staged media;
- message identifier;
- результаты channel security checks;
- correlation context.

### 6.6. Оценка сложности

| Реализация | MVP | Production hardening |
|---|---:|---:|
| In-process bridge без outbox | 3–5 дней | Не рекомендуется |
| Plugin + outbox + external worker | 2–4 недели | 4–7 недель |
| Полностью самостоятельные channel bridges | 6–10 недель | 3–5 месяцев |

## 7. Event Broker

### 7.1. Предлагаемая технология

В рамках этого варианта предлагается NATS JetStream.

Причины выбора:

- иерархические subjects;
- server-side filtering;
- subject-level ACL;
- durable consumers;
- replay;
- explicit acknowledgements;
- горизонтально масштабируемые pull consumers;
- встроенное хранение;
- более простая эксплуатация по сравнению с Kafka для предполагаемого объёма.

Выбор NATS относится только к этому варианту реализации. В базовой спецификации технология брокера остаётся открытым решением.

### 7.2. Развёртывание

Для разработки:

```text
1 × nats-server с JetStream file storage
```

Для production:

```text
3 × nats-server
JetStream cluster
replication factor: 3
TLS
отдельная service identity для каждого consumer/producer
```

### 7.3. Streams

| Stream | Subjects | Назначение |
|---|---|---|
| `SS_INBOUND` | `ss.v1.inbound.>` | Сырые и нормализованные сообщения |
| `SS_DOMAIN` | `ss.v1.request.>`, `ss.v1.task.>`, `ss.v1.policy.>` | Квалификация и жизненный цикл задач |
| `SS_EXECUTION` | `ss.v1.run.>` | Запросы, прогресс и результаты запусков |
| `SS_OUTBOUND` | `ss.v1.outbound.>`, `ss.v1.delivery.>` | Внешние ответы и delivery receipts |
| `SS_AUDIT` | безопасная проекция остальных streams | Длительное хранение metadata |

### 7.4. Subjects

```text
ss.v1.inbound.telegram.telegram-main
ss.v1.inbound.max.max-main
ss.v1.inbound.web.web-main

ss.v1.request.task-candidate
ss.v1.request.clarification-needed

ss.v1.task.inbox.personal-agent-system

ss.v1.run.requested.codex
ss.v1.run.requested.claude
ss.v1.run.started
ss.v1.run.progress
ss.v1.run.completed
ss.v1.run.failed

ss.v1.outbound.telegram.telegram-main
ss.v1.outbound.max.max-main
ss.v1.outbound.web.web-main

ss.v1.delivery.telegram.succeeded
ss.v1.delivery.telegram.failed
ss.v1.delivery.telegram.ambiguous
```

### 7.5. Consumers

```text
qualifier-v1
domain-router-v1
task-ingress-personal-agent-system
execution-runner-codex
execution-runner-claude
outbound-telegram-main
outbound-max-main
outbound-web-main
```

Базовая конфигурация consumer:

```text
AckPolicy: explicit
MaxDeliver: 5
Backoff: 5s, 30s, 5m, 30m, 2h
```

После достижения `MaxDeliver` отдельный DLQ handler обрабатывает advisory и публикует событие в `ss.v1.dlq.<stage>`.

### 7.6. Идемпотентность

Используются:

- `event_id` в конверте Second System;
- `idempotency_key` предметной операции;
- `Nats-Msg-Id` при публикации;
- прикладной idempotency ledger в сервисе-получателе.

Дедупликация JetStream не заменяет прикладную идемпотентность.

### 7.7. Почему не Kafka

Kafka следует предпочесть, если возникнут:

- очень высокий поток событий;
- многолетнее хранение полного журнала;
- тяжёлая потоковая аналитика;
- большое количество независимых downstream consumers;
- существующая Kafka-команда и инфраструктура.

Для текущего персонального контура эти преимущества не компенсируют эксплуатационную сложность.

### 7.8. Оценка сложности

| Реализация | Оценка |
|---|---:|
| Один JetStream для разработки | несколько часов |
| Production cluster, ACL и monitoring | 1–3 недели |
| Собственный брокер | нецелесообразно |

## 8. OpenClaw Execution Gateway

### 8.1. Назначение

Execution Gateway отвечает только за разрешённое исполнение задач:

- Codex app-server runtime;
- Claude Code через ACP или CLI backend;
- agent sessions;
- workspaces;
- sandbox;
- technical tool policy;
- exec approvals;
- background task tracking.

Он не принимает внешние Telegram/Max webhooks и не хранит channel credentials.

### 8.2. Развёртывание

```text
OS user: openclaw-execution
State:   /var/lib/openclaw-execution
Config:  /etc/openclaw-execution/openclaw.json
Gateway: loopback only
Secrets: Codex/Claude и разрешённые рабочие credentials
```

State, sockets, workspaces и credentials не доступны Intake Gateway.

### 8.3. Execution Task Runner

OpenClaw не читает JetStream самостоятельно. Отдельный runner:

- подписывается на `ss.v1.run.requested.codex` и `ss.v1.run.requested.claude`;
- проверяет адресата и принятое policy decision;
- создаёт durable run record;
- подтверждает run request после создания run record;
- вызывает OpenClaw `agent` RPC;
- ожидает результат через `agent.wait` или события Gateway;
- публикует `run.started`, `run.progress`, `run.completed` или `run.failed`;
- отдельно публикует безопасное `outbound.message.requested`.

Run request нельзя держать неподтверждённым всё время работы агента. Иначе долгий запуск будет ошибочно восприниматься брокером как незавершённая обработка и доставляться повторно.

### 8.4. Codex

Предпочтительный путь — нативный Codex app-server harness OpenClaw. Он сохраняет Codex thread semantics, resume, compaction и runtime policy, а OpenClaw добавляет session binding, approvals, workspace policy и transcript mirror.

### 8.5. Claude Code

Предлагается:

- ACP runtime `claude` для продолжительных coding sessions;
- Claude CLI backend для коротких или fallback-вызовов.

### 8.6. Workspace и sandbox

Для executor-agents задаются:

- отдельные workspaces;
- `sandbox.mode: all`;
- `sandbox.scope: session` или `agent`;
- Docker/SSH/OpenShell backend;
- `workspaceAccess: none`, `ro` или `rw`;
- network policy;
- tool allow/deny;
- resource limits.

Workspace без sandbox является только cwd, а не security boundary.

### 8.7. Два уровня policy

Business Policy Gate Second System решает:

- можно ли выполнять задачу;
- кому она адресована;
- к какому проекту относится;
- какие бизнесовые capabilities разрешены;
- можно ли автоматически отправлять результат наружу.

OpenClaw technical policy решает:

- можно ли запускать конкретную команду;
- sandbox или host;
- какие tools видит агент;
- read-only или write доступ;
- требуется ли интерактивный approval.

Один уровень не заменяет другой.

### 8.8. Почему OpenClaw

OpenClaw исключает самостоятельную реализацию:

- различий Codex и Claude runtimes;
- streaming JSONL;
- resume sessions;
- compaction;
- cancellation и зависших процессов;
- model switching;
- MCP integration;
- permission modes;
- технических approvals;
- sandbox backends;
- task/session UI;
- изменений CLI protocol.

### 8.9. Оценка сложности

| Реализация | MVP | Production hardening |
|---|---:|---:|
| OpenClaw Execution Gateway + Task Runner | 2–4 недели | 5–8 недель |
| Простая shell-обёртка над двумя CLI | 1–2 недели | Недостаточно устойчива |
| Полноценные Workers самостоятельно | 2–3 месяца | 4–8 месяцев |

## 9. Обратный путь через Event Broker

Event Broker после Execution Gateway — тот же JetStream cluster.

### 9.1. Внутренний результат

```text
ss.v1.run.completed
```

Содержит:

- task ID и run ID;
- технический статус;
- summary;
- ссылки на артефакты;
- список изменений;
- metrics;
- безопасную диагностику.

Это событие не доставляется пользователю напрямую.

### 9.2. Внешний ответ

```text
ss.v1.outbound.<channel>.<adapter-id>
```

Содержит:

- `visibility: external`;
- `reply_route_id` или проверенный destination;
- безопасный текст;
- разрешённые вложения;
- `causation_id` запуска;
- idempotency key.

### 9.3. Цикл доставки

```text
Execution Task Runner
→ outbound.telegram.telegram-main
→ Intake Bridge
→ OpenClaw Intake Gateway
→ Telegram
→ MessageReceipt
→ delivery.telegram.succeeded
→ Event Broker
```

Состояние доставки ведётся отдельно от состояния задачи. Задача может быть завершена, пока внешний ответ находится в `RETRYING` или `AMBIGUOUS`.

## 10. ACL брокера

### 10.1. Intake Bridge

```text
subscribe:
  ss.v1.outbound.telegram.telegram-main
  ss.v1.outbound.max.max-main
  ss.v1.outbound.web.web-main

publish:
  ss.v1.inbound.telegram.telegram-main
  ss.v1.inbound.max.max-main
  ss.v1.inbound.web.web-main
  ss.v1.delivery.telegram.*
  ss.v1.delivery.max.*
  ss.v1.delivery.web.*
```

### 10.2. Execution Task Runner

```text
subscribe:
  ss.v1.run.requested.codex
  ss.v1.run.requested.claude

publish:
  ss.v1.run.*
  ss.v1.outbound.telegram.telegram-main
  ss.v1.outbound.max.max-main
  ss.v1.outbound.web.web-main
```

### 10.3. Task Ingress

```text
subscribe:
  ss.v1.task.inbox.personal-agent-system

publish:
  ss.v1.task.accepted
  ss.v1.task.rejected
```

Ни один Gateway не получает wildcard-доступ ко всему broker namespace.

## 11. Что заменяет OpenClaw

В этом варианте OpenClaw заменяет или существенно упрощает:

- Telegram Adapter;
- Web Adapter;
- общий channel framework для Max;
- channel session и reply routing;
- channel delivery и receipts;
- Codex Worker;
- Claude Worker;
- CLI parsing и session resume;
- часть Workspace Manager;
- технические sandbox и exec approvals;
- часть веб-интерфейса для sessions и background tasks.

## 12. Что остаётся Second System

Самостоятельно реализуются:

- Max channel plugin;
- Intake Broker Bridge;
- Event Broker и его конфигурация;
- Qualifier;
- Identity/Domain Event Router;
- Task Ingress;
- Business Policy Gate;
- Approval orchestration на уровне задачи;
- Task Registry;
- Execution Task Runner;
- схемы и версии событий;
- transactional outbox;
- прикладная идемпотентность;
- DLQ processing;
- end-to-end audit.

## 13. Риски варианта

| Риск | Последствие | Мера снижения |
|---|---|---|
| Быстрое развитие OpenClaw API | Несовместимость plugin/RPC после обновления | Pin точной версии, contract tests, контролируемые обновления |
| Max не поддерживается штатно | Собственная разработка и сопровождение | Изолированный channel plugin и тестовый стенд Max |
| Hook не опубликовал событие | Потеря обращения | Transactional outbox и fail-closed run gate |
| Intake Gateway случайно получил tools | Внешний prompt может вызвать действие | Отдельный Gateway, deny-by-default и sandbox all |
| Execution Gateway доступен извне | Обход квалификации и Task Ingress | Loopback-only, отдельная сеть и service credentials |
| Повтор outbound event | Дублирующее сообщение | Delivery ledger и idempotency key |
| Неоднозначная ошибка API канала | Возможный дубль при retry | `delivery.ambiguous`, platform reconciliation или review |
| Двойная система task state | Расхождение OpenClaw task ledger и Task Registry | Task Registry является бизнесовым source of truth |
| Чрезмерная зависимость от внутренних API | Хрупкая интеграция | Использовать только документированные Plugin SDK и Gateway RPC |

## 14. Сравнительная оценка

Оценка предполагает одного опытного TypeScript/backend-разработчика и не включает разработку бизнес-правил квалификатора или полный пользовательский UI.

| Объём | Гибрид с OpenClaw | Полностью самостоятельно |
|---|---:|---:|
| Технический MVP | 6–10 недель | 4–7 месяцев |
| Production hardening | ещё 4–8 недель | ещё 3–6 месяцев |
| Поддержка channel/API изменений | в основном OpenClaw + Max plugin | полностью собственная |
| Поддержка Codex/Claude runtime | в основном OpenClaw | полностью собственная |
| Контроль событийной модели | полный | полный |
| Vendor/framework dependency | высокая на границах | низкая |

Оценки являются порядком величины и уточняются после proof of concept.

## 15. Когда выбирать этот вариант

Вариант целесообразен, если:

- брокер и отдельные trust boundaries обязательны;
- нужно быстро запустить Telegram и Web;
- нет желания сопровождать Codex/Claude wrappers;
- допустима зависимость от OpenClaw Plugin SDK и Gateway RPC;
- команда готова закрепить и контролируемо обновлять версию OpenClaw;
- Max plugin реализуем поверх доступного API.

Вариант нецелесообразен, если:

- требуется полный контроль над каждым байтом channel pipeline;
- запрещено загружать сторонний agent gateway;
- API OpenClaw нельзя закрепить или покрыть contract tests;
- требования сертификации не позволяют использовать его security model;
- система должна стать высоконагруженной multi-tenant платформой в одном runtime.

## 16. Предлагаемый proof of concept

PoC должен проверить только архитектурные неизвестные.

### Этап 1. Intake

1. Развернуть отдельный OpenClaw Gateway.
2. Подключить Telegram и WebChat.
3. Реализовать `message_received` export.
4. Заблокировать стандартный agent run.
5. Доказать доставку canonical event в JetStream.

### Этап 2. Обратная доставка

1. Опубликовать тестовый `outbound.telegram` event.
2. Получить его durable consumer.
3. Отправить через Gateway RPC.
4. Получить MessageReceipt.
5. Опубликовать delivery result.
6. Проверить дедупликацию повторного события.

### Этап 3. Execution

1. Развернуть второй Gateway без channel credentials.
2. Запустить тестовую задачу через Codex harness.
3. Запустить тестовую задачу через Claude ACP.
4. Проверить sandbox, cancellation и timeout.
5. Опубликовать run result и внешний ответ в JetStream.

### Этап 4. Max

1. Проверить доступный Max Bot API.
2. Реализовать минимальный channel plugin: text inbound/outbound.
3. Проверить identity, threading, attachments и receipts.
4. Уточнить итоговую стоимость production-реализации.

### Критерии успеха PoC

- raw message не запускает execution-agent;
- сообщение не теряется при перезапуске Bridge;
- одна задача не исполняется повторно;
- один outbound event не создаёт два пользовательских сообщения;
- результат Codex/Claude возвращается через брокер;
- Intake Gateway не имеет доступа к execution credentials;
- Execution Gateway не доступен из внешнего канала;
- весь путь связан одним `correlation_id`.

## 17. Открытые вопросы

Перед принятием варианта необходимо решить:

- использовать in-process NATS service или thin plugin + external bridge worker;
- где хранить локальный outbox Intake Gateway;
- нужен ли отдельный Result Composer перед публикацией outbound event;
- как выполнять проверку внешнего ответа на секреты;
- какие OpenClaw API считать разрешённым интеграционным контрактом;
- какую точную версию OpenClaw закрепить;
- подходит ли Max Bot API для полноценного channel plugin;
- использовать Claude ACP или CLI backend для разных классов задач;
- как синхронизировать OpenClaw task ledger с внешним Task Registry;
- где проходит approval внешней отправки результата;
- какой retention задать каждому JetStream stream.

## 18. Критерий принятия решения

Вариант можно принять после PoC, если одновременно подтверждены:

1. Broker Bridge реализуется только через документированные extension points.
2. Intake Gateway гарантированно не исполняет внешние сообщения.
3. Execution Gateway запускает Codex и Claude с требуемой изоляцией.
4. Max plugin имеет приемлемую стоимость поддержки.
5. End-to-end доставка остаётся идемпотентной.
6. Обновление закреплённой версии OpenClaw можно проверять автоматическими contract tests.
7. Оценка гибрида остаётся существенно ниже полной самостоятельной реализации.

Если хотя бы один из первых пяти пунктов не подтверждается, следует вернуться к самостоятельным адаптерам или использовать OpenClaw только как execution runtime.

## 19. Ссылки на официальную документацию

- [OpenClaw Gateway architecture](https://docs.openclaw.ai/concepts/architecture)
- [OpenClaw channels](https://docs.openclaw.ai/channels)
- [Building OpenClaw channel plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- [OpenClaw Plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw Gateway integrations for external apps](https://docs.openclaw.ai/gateway/external-apps)
- [OpenClaw Channel Outbound API](https://docs.openclaw.ai/plugins/sdk-channel-outbound)
- [OpenClaw Codex harness runtime](https://docs.openclaw.ai/plugins/codex-harness-runtime)
- [OpenClaw CLI backends](https://docs.openclaw.ai/gateway/cli-backends)
- [OpenClaw ACP Agents](https://docs.openclaw.ai/tools/acp-agents)
- [OpenClaw Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- [OpenClaw Security](https://docs.openclaw.ai/gateway/security)
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream)
- [NATS JetStream Consumers](https://docs.nats.io/nats-concepts/jetstream/consumers)
- [NATS subject authorization](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/authorization)
