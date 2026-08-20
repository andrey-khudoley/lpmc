# Модель данных: сущности, связи, конвенции имён

Дата среза: 2026-08-09 (снимок репозитория `cloud-tech-tasks`), дата чтения — 2026-08-10.

Это docs-as-state: ниже — как устроены данные в `/home/agent/workspaces/cloud-tech-tasks`
сегодня, по фактическому содержимому файлов, `templates/*.md` и git-истории. Про целевое
устройство (перенос реестра задач и custody секретов к PACT, расщепление карточки
сервиса между PACT/MITA/CITA и т. п.) — `docs/spec/spec.md`; здесь только указатели на
него, без пересказа.

Источники: прямое чтение репозитория `cloud-tech-tasks` — `templates/*.md` (8 файлов),
`.agents/policy/common/03-language.md`, `git log` по `templates/task.md` на 2026-08-10,
примеры реальных карточек (`clients/neso/tasks/archive/2026/...`,
`services/kinescope/overview.md`, `notes/2026-08/...`). Вспомогательные конспекты вне
репозиториев (не первоисточник, могут исчезнуть): `research/knowledge-data.md`
§§2, 5, 8, 9, 11, 12; `research/tasks-agent-rules.md` §§4, 9; `research/allocation.md`
(раздел «Известные ловушки», п. 1 — утверждение о `templates/task.md` как битой ссылке
проверено и не подтвердилось, см. §0).

---

## 0. Расхождение, зафиксированное отдельно: `templates/task.md`

`research/allocation.md` (со ссылкой на «известные ловушки исходных материалов») и
производный от него `docs/operating-model.md` этого же воркспейса утверждают, что
`templates/task.md` **не существует** и является битой ссылкой канона (на него ссылаются
`CLAUDE.md`, `.agents/policy/common/01-repository-layout.md`,
`.agents/skills/intake/SKILL.md`), а состав `templates/` — 7 файлов.

Проверка по факту диска на 2026-08-10 это опровергает:

- `templates/task.md` **присутствует**, размер **1802 байта**.
- `git log --follow --diff-filter=A -- templates/task.md` показывает, что файл создан
  первым же коммитом системы — `403a46c`, 2026-07-30 16:24:50 («system: базовая структура
  системы задач и знаний») — и последний раз тронут `a9b2e6b`, 2026-08-08 13:25:30
  (переразметка `clients/` → `clients/projects/internal`). Файл не появился позже снимка
  research — он существовал с момента основания репозитория.
- Фактический состав `templates/` — **8 файлов**, не 7: `client-instructions.md`,
  `client-overview.md`, `inbox-item.md`, `llm-log.md`, `note.md`, `playbook.md`,
  `service.md`, `task.md`.

Вывод: утверждение о битой ссылке в `research/allocation.md` и `docs/operating-model.md`
**фактически неверно** для состояния репозитория на 2026-08-09/2026-08-10 — это ошибка
источника, а не более позднее исправление. Ниже карточка задачи описывается по
существующему `templates/task.md`, а не восстанавливается по фактическим карточкам
«за неимением шаблона».

---

## 1. Владелец (`owner`)

Файловое представление: каталог `<root>/<owner-slug>/`, где `<root>` — один из
`clients/`, `projects/`, `internal/`. Слаг владельца уникален глобально среди всех трёх
корней.

Owner как таковой не имеет единого файла-карточки — это каталог с фиксированным
набором вложений:

| Файл/каталог | Назначение | Шаблон |
|---|---|---|
| `overview.md` | кто это, контакты, контекст сотрудничества, инфраструктура одним взглядом | `templates/client-overview.md` |
| `instructions.md` | локальные правила, приоритетнее общих политик; опционален | `templates/client-instructions.md` |
| `tasks/{inbox,active,archive}/` | задачи владельца | — |
| `services/INDEX.md` + `<service-slug>/overview.md` | сервисы владельца | `templates/service.md` |
| `playbooks/<slug>.md` | локальные процедуры | `templates/playbook.md` |
| `notes/INDEX.md` + `YYYY-MM/*.md` + `archive/` | оперативные заметки | `templates/note.md` |
| `llm/YYYY-MM/*.md` | сырые журналы сессий | `templates/llm-log.md` |

### Frontmatter `overview.md` (по `templates/client-overview.md`)

```yaml
name: <client-slug>
title: ""             # человекочитаемое название
since: YYYY-MM-DD     # начало сотрудничества
updated: YYYY-MM-DD
```

Тело: «Кто это» → «Контакты и роли» (таблица Кто | Роль | Канал) → «Контекст
сотрудничества» → «Инфраструктура одним взглядом».

### Frontmatter `instructions.md` (по `templates/client-instructions.md`)

```yaml
client: <client-slug>
updated: YYYY-MM-DD
```

Тело: «Правила и ограничения» → «Коммуникация» → «Особенности».

`instructions.md` заводится не у всех: среди 18 проектов он есть только у `ipsen` и
`mama-znayka`.

---

## 2. Сервис (`service`)

Внешняя система (веб-платформа/API/сервер), через которую выполняются задачи.

Два уровня файлового представления:

1. **Клиентский** — `<root>/<owner>/services/<service-slug>/overview.md`. Описывает
   конкретный проект/аккаунт данного владельца внутри сервиса.
2. **Общий (shared)** — корневой `services/<service-slug>/overview.md`. Для сервисов,
   доступ к которым даётся по аккаунту исполнителя, а не по клиенту, один на несколько
   владельцев: сегодня это `services/bizon365`, `services/chatium`,
   `services/gc-chatium-gateway`, `services/kinescope` (+ `services/INDEX.md`).

### Frontmatter (по `templates/service.md`)

```yaml
name: <service-slug>
client: <client-slug>   # или shared для общих сервисов
type: web                # web | api | db | server | other
url: ""
owner: ""                # ответственный на стороне клиента, если известен
updated: YYYY-MM-DD
```

Тело: «Что это и зачем» → «Доступ» (URL входа; имена секретов
`<client>/<service>/username|password|totp`; отметка о Playwright storage-state
`.secrets/storage-state/<client>/<service>.json`) → «Возможности и типовые операции»
(ссылки на плейбуки) → «Грабли и особенности».

Клиентская и общая карточки одного сервиса ссылаются друг на друга относительными
путями («клиентская → общая» за деталями доступа, «общая → клиентские» за деталями
операций владельцев). Пример: `services/kinescope/overview.md` — общий аккаунт
исполнителя (`client: shared`, `owner: "Андрей Худолей (AKH Tech)..."`), внутри него
клиенты живут как отдельные проекты.

---

## 3. Задача (`task`)

Файловое представление зависит от стадии жизненного цикла — полный автомат состояний и
правило «место следует за состоянию» описаны в `docs/operating-model.md` §3, здесь —
только представление данных.

### Inbox-запись (по `templates/inbox-item.md`)

Путь: `<root>/<owner>/tasks/inbox/YYYY-MM-DD-HHMM-<source>.md`.

```yaml
received: YYYY-MM-DDTHH:MM
source: manual        # manual | telegram | api
chat: ""               # идентификатор чата, если известен
manager: ""
```

Тело — дословный текст постановки без обработки. После обработки скиллом `intake`
файл удаляется, содержимое переносится в раздел «Исходное сообщение» карточки задачи.

### Карточка задачи (по `templates/task.md`, файл присутствует — см. §0)

Путь: `<root>/<owner>/tasks/{active,archive/YYYY}/YYYY-MM-DD-<slug>/task.md`
(+ `artifacts/` рядом).

```yaml
id: YYYY-MM-DD-<slug>
title: ""
client: <owner-slug>    # дублирует каталог <root>/<owner>/, карточка самодостаточна;
                         # поле называется client по историческим причинам и хранит
                         # слаг владельца независимо от корня (clients|projects|internal)
status: active         # inbox | active | blocked | review | done | cancelled
priority: p2           # p1 срочно | p2 обычное | p3 фоновое
source: manual         # manual | telegram | api
manager: ""            # кто поставил задачу
created: YYYY-MM-DD
updated: YYYY-MM-DD
services: []           # слаги затронутых сервисов
```

Тело (разделы фиксированы шаблоном): Постановка → Исходное сообщение → Definition of
Done (чек-лист) → Открытые вопросы → План → Журнал (краткая версия для читателя
карточки, не сырой лог — сырой лог целиком в `llm/`) → Отчёт (готовый текст ответа
менеджеру).

Пример реальной архивной карточки (`clients/neso/tasks/archive/2026/2026-06-06-lesson-26-mailing-access/task.md`)
подтверждает состав полей и показывает дополнительные поля происхождения при импорте
(`source_path`, `imported`, `completeness` — см. §10).

Глобальный идентификатор задачи — `<owner-slug>/<YYYY-MM-DD-slug>`. На практике
встречаются архивные карточки с идентификатором без дня (`YYYY-MM-<slug>`) —
исторический артефакт переноса, не действующая конвенция.

---

## 4. Заметка (`note`)

Дистиллированное наблюдение (в отличие от сырого журнала `llm/`, см. §5).

Путь: `<root>/<owner>/notes/YYYY-MM/YYYY-MM-DD-<topic>.md` — если заметка про
владельца или его сервисы; корневой `notes/YYYY-MM/YYYY-MM-DD-<topic>.md` — если про
систему или общее для нескольких владельцев. Устаревшие заметки уходят в `notes/archive/`
(в каждой из двух локаций — своя `archive/`), актуальный список — `notes/INDEX.md`.

### Frontmatter (по `templates/note.md`)

```yaml
date: YYYY-MM-DD
author: <agent|user>
client: ""              # дублирует путь, если заметка лежит в <root>/<owner>/notes/;
                          # пусто для системных
topics: []
task: ""                 # id задачи, если заметка возникла в её контексте
```

Тело — свободный текст наблюдения/находки/временной договорённости. Заметка — сырьё:
устойчивое знание из неё переносится в `overview.md`/`instructions.md`/`services/`/
`playbooks/` скиллом `compact-notes`; сама заметка после компакции не обязана исчезать
(источники не фиксируют автоматическое удаление).

---

## 5. Журнал (`llm-log`)

Сырой append-only архив того, что агент реально делал за сессию — полный технический
сырец (запросы, шаги, ошибки, решения, итог), включая тупики. Не подлежит компакции.
Три уровня детализации одного процесса: «Журнал» в `task.md` (для читателя карточки) →
`notes/` (дистиллированное знание) → `llm/` (полный сырец).

Путь: `<root>/<owner>/llm/YYYY-MM/YYYY-MM-DD-HHMM-<agent>-<topic>.md` — работа по
владельцу; корневой `llm/YYYY-MM/YYYY-MM-DD-HHMM-<agent>-<topic>.md` — системная работа.

### Frontmatter (по `templates/llm-log.md`)

```yaml
date: YYYY-MM-DDTHH:MM
agent: main              # main | qualifier | task-executor | librarian | service-scout
client: ""                # пусто для системной работы
task: ""                   # глобальная ссылка <owner-slug>/<task-id>, если работа шла по задаче
skill: ""                  # применявшийся скилл/процедура, если был
trigger: ""                # что запустило сессию: просьба пользователя / cron / разбор inbox / вызов субагента
```

Тело: «Запрос» → «Ход работы» (без приглаживания: команды и результаты, открытые
страницы, принятые решения и их причины, ошибки и как обойдены, тупики; значения
секретов — маскировать) → «Итог».

`agent` enum (`main`, `qualifier`, `task-executor`, `librarian`, `service-scout`)
соответствует головной сессии (`main`, не файл роли) и четырём делегируемым ролям в
`.agents/agents/`.

---

## 6. Плейбук (`playbook`)

Локальная или общая процедура выполнения типового класса задач.

Путь: корневой `playbooks/<slug>.md` (общие для всех владельцев — сегодня один,
`captcha-escalation`) или `<root>/<owner>/playbooks/<slug>.md` (локальные,
приоритетнее одноимённых общих — правило приоритета из
`.agents/policy/common/05-client-precedence.md`).

### Frontmatter (по `templates/playbook.md`)

```yaml
name: <playbook-slug>
client: shared            # или <client-slug>, если процедура клиентская
task-class: ""             # класс задач, к которому применим
updated: YYYY-MM-DD
```

Тело: «Когда применять» → «Предусловия» → «Шаги» → «Верификация» → «Известные
проблемы».

---

## 7. Шаблон (`templates/*.md`)

Файловое представление: плоский каталог `templates/` в корне репозитория, без
подкаталогов и без `INDEX.md`. Формат — markdown с YAML-frontmatter и заготовками
разделов в виде плейсхолдеров в угловых скобках (`<...>`) и HTML-комментариев с
инструкциями по использованию (например, в `inbox-item.md` — куда класть файл и что
происходит после обработки).

Полный фактический состав на 2026-08-10 — **8 файлов** (расхождение с
`research/allocation.md`, где их 7 без `task.md`, — см. §0):

| Файл | Для чего | Ключевые поля frontmatter |
|---|---|---|
| `client-overview.md` | `overview.md` владельца | `name`, `title`, `since`, `updated` |
| `client-instructions.md` | `instructions.md` владельца | `client`, `updated` |
| `inbox-item.md` | сырая постановка в `tasks/inbox/` | `received`, `source`, `chat`, `manager` |
| `task.md` | карточка задачи | `id`, `title`, `client`, `status`, `priority`, `source`, `manager`, `created`, `updated`, `services` |
| `service.md` | карточка сервиса | `name`, `client` (или `shared`), `type`, `url`, `owner`, `updated` |
| `playbook.md` | процедура | `name`, `client` (`shared` или слаг), `task-class`, `updated` |
| `note.md` | заметка | `date`, `author`, `client`, `topics`, `task` |
| `llm-log.md` | журнал сессии | `date`, `agent`, `client`, `task`, `skill`, `trigger` |

Шаблонов для `INDEX.md` и для owner-каталога целиком не существует — состав каталога
владельца воспроизводится вручную/скиллом `add-owner`, а не копированием одного файла.

---

## 8. Связи между сущностями

```
owner (clients|projects|internal)
 │
 ├─ overview.md ───────── описывает owner целиком, таблицей ссылается на все его services/
 ├─ instructions.md ────── правила уровня owner, приоритет над общими .agents/policy
 │
 ├─ services/<slug>/overview.md ── карточка сервиса owner'а;
 │      если аккаунт общий на нескольких owner'ов → ссылается на корневой
 │      services/<slug>/ (client: shared), и наоборот — корневая карточка таблицей
 │      перечисляет owner'ов-держателей проектов внутри неё
 │
 ├─ tasks/{inbox,active,archive}/... ── задачи owner'а;
 │      task.md.services[] ── слаги сервисов, затронутых задачей (owner-локальных либо shared)
 │      обратная ссылка из note/llm-log ── <owner-slug>/<task-id>
 │
 ├─ playbooks/*.md ── процедуры owner'а (приоритетнее одноимённых в корневом playbooks/)
 │
 ├─ notes/YYYY-MM/*.md ── дистиллированные наблюдения; note.task ссылается на задачу,
 │      если заметка родилась в её ходе; устойчивое знание отсюда компактится в
 │      overview/instructions/services/playbooks скиллом compact-notes
 │
 └─ llm/YYYY-MM/*.md ── полный сырой журнал каждой рабочей сессии; llm-log.task/skill/agent
        связывают сессию с задачей/скиллом/ролью-исполнителем; секреты маскированы, append-only
```

Кросс-owner'ные связи возникают там, где физический аккаунт/сервис общий (слаг
`shared`): Bizon365 и Kinescope — один агентский аккаунт исполнителя обслуживает
`neso`, `larina` и (для Kinescope) `akh-tech` как отдельные проекты внутри себя;
Chatium и `gc-chatium-gateway` — общий инструмент/продукт исполнителя, используемый в
задачах разных владельцев одновременно.

Связи всегда выражены **текстом внутри frontmatter или тела файла** (слаг, id задачи,
относительный путь) — отдельного индекса связей или базы данных нет; git plain-text
файлы — единственный источник истины.

---

## 9. Сводная таблица конвенций именования

| Сущность | Путь | Имя файла |
|---|---|---|
| Overview владельца | `<root>/<owner>/overview.md` | фиксированное |
| Instructions владельца | `<root>/<owner>/instructions.md` | фиксированное, опционально |
| Inbox-постановка | `<root>/<owner>/tasks/inbox/` | `YYYY-MM-DD-HHMM-<source>.md` |
| Карточка задачи | `<root>/<owner>/tasks/{active,archive/YYYY}/YYYY-MM-DD-<slug>/` | `task.md` (+ `artifacts/`) |
| Карточка сервиса | `<root>/<owner>/services/<service-slug>/` или `services/<service-slug>/` | `overview.md` |
| Плейбук | `<root>/<owner>/playbooks/` или корневой `playbooks/` | `<playbook-slug>.md` |
| Заметка | `<root>/<owner>/notes/YYYY-MM/` или корневой `notes/YYYY-MM/` | `YYYY-MM-DD-<topic>.md` |
| Журнал сессии | `<root>/<owner>/llm/YYYY-MM/` или корневой `llm/YYYY-MM/` | `YYYY-MM-DD-HHMM-<agent>-<topic>.md` |
| Индекс каталога | любой каталог со списком сущностей | `INDEX.md` (не сущность — исключается из обходов вместе с `.gitkeep`/`README.md`) |
| Шаблон | `templates/` (плоско) | `<entity>.md` (см. §7) |

Даты — всегда `YYYY-MM-DD`, время — `HHMM` (24-часовое, без разделителя). Дату/время
берут из системы (`date`) на момент операции, не из памяти модели.

---

## 10. Служебные поля происхождения импортированных файлов

Файлы, перенесённые 2026-07-30 скиллом `migrate-legacy` из прежней системы
(Obsidian-vault `second_brain`), несут дополнительные поля frontmatter:

- `source` — путь в источнике. Исключение: в карточках задач имя `source` уже занято
  под канал постановки (`manual|telegram|api`), поэтому там для той же цели
  используется `source_path`.
- `imported` — дата переноса.
- `completeness` — `complete | partial | stub`. У всех просмотренных примеров —
  `partial` (перенос признан неполным).

Поля намеренно не удаляются — по ним видно происхождение факта и степень доверия к
нему. Пример: карточка `clients/neso/tasks/archive/2026/2026-06-06-lesson-26-mailing-access/task.md`
содержит `source_path: "02_Tasks/tasks/2026-06-06--neso-hss-predictions-lesson-26-mailing-access.md"`,
`imported: 2026-07-30`, `completeness: partial`.

Для файлов, изначально созданных внутри новой системы (не мигрированных), эти поля не
обязательны — пример: `services/bizon365/overview.md`, `services/kinescope/overview.md`,
`internal/akh-tech/overview.md`, заведённые 2026-08-08/09, таких полей не имеют.

---

## 11. Язык и слаги

Содержимое файлов — русский язык. Имена файлов, каталогов и слаги — английский,
kebab-case, без пробелов: `neso`, `larina`, `akh-tech`, `gc-chatium-gateway`,
`dmitry-bernadskiy`. Правило зафиксировано в `.agents/policy/common/03-language.md`
(в составе канона, собирается в `CLAUDE.md`/`AGENTS.md`; прочитан целиком):
«Содержимое файлов — русский. Имена файлов, каталогов и слаги — английские,
kebab-case. Даты — `YYYY-MM-DD`, время — `HHMM`. Текущую дату и время брать из
системы (`date`), а не из памяти».

---

## Связанные документы

- `docs/README.md` — индекс документации участка и правило разделения spec/adr/state.
- `docs/overview.md` — что такое MITA сегодня, состав репозитория целиком.
- `docs/operating-model.md` — жизненный цикл задачи, DoD, приоритет локального над
  общим, как сегодня отдаются команды (тот же снимок 2026-08-09; утверждение об
  отсутствии `templates/task.md` из более ранней версии исправлено там же — см. §0
  этого документа).
- `docs/spec/spec.md` — желаемое состояние: перенос реестра задач и custody секретов
  к PACT, расщепление карточки сервиса между PACT/MITA/CITA. Только как указатель.
