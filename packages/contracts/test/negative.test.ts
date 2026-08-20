/**
 * НЕГАТИВНЫЕ ТЕСТЫ. Пункт P1-CHK-04 роадмапа: пишутся ДО реализации.
 *
 * Негативный тест проверяет, что запрещённое получает ОТКАЗ. Написанный после
 * кода, он обычно проверяет лишь то, что код и так делает, — поэтому порядок
 * здесь важнее удобства.
 *
 * Каждый тест назван идентификатором критерия из спецификации контура, чтобы
 * связь «требование ↔ проверка» не терялась при переработке документов.
 *
 * Часть критериев проверяется на уровне узла и уже живёт в роли lpmc_system
 * (Н-7 запрос мимо прокси, Н-8 домен вне allowlist, Н-9 запрос после истечения
 * лизинга, Н-16 публикация внешнего сообщения исполнителем). Здесь — то, что
 * относится к контрактам и коду контуров.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkVersions, EXECUTORS, isMember, majorFromSubject, runRequestedSubject,
  RUN_STATUSES, TASK_STATES, validateAuthorizedTask, validateRunStatus,
} from "../src/index.js";

const OWNERS = ["internal"] as const;
const VALID = {
  task_id: "t-1", run_id: "r-1", executor: "mita", owner: "internal",
  granted_capabilities: ["page.read"],
  lease: { id: "l-1", generation: 1, expires_at: "2026-01-01T00:00:00Z" },
  reply_route_id: "rr-1", dod: ["страница прочитана"],
};

describe("MITA Н-1: неполная авторизованная задача отклоняется до первого внешнего действия", () => {
  for (const field of ["dod", "lease", "reply_route_id", "granted_capabilities"] as const) {
    it(`без поля ${field} — отказ`, () => {
      const task: Record<string, unknown> = { ...VALID };
      delete task[field];
      const v = validateAuthorizedTask(task, OWNERS, "mita");
      assert.equal(v.ok, false);
      assert.match((v as { reason: string }).reason, /input\.missing_field/);
    });
  }

  it("пустой granted_capabilities — отказ, а не «прав нет, но и не запрещено»", () => {
    const v = validateAuthorizedTask({ ...VALID, granted_capabilities: [] }, OWNERS, "mita");
    assert.equal(v.ok, false);
  });
});

describe("MITA Н-2: идентификатор исполнителя вне закрытого перечня", () => {
  for (const bad of ["MITA", "Mita", " mita ", "mit", "mitа" /* кириллическая а */]) {
    it(`«${bad}» — отказ без нормализации`, () => {
      const v = validateAuthorizedTask({ ...VALID, executor: bad }, OWNERS, "mita");
      assert.equal(v.ok, false);
      assert.equal((v as { reason: string }).reason, "input.unknown_executor");
    });
  }

  it("чужой исполнитель из перечня — отказ по несовпадению", () => {
    const v = validateAuthorizedTask({ ...VALID, executor: "cita" }, OWNERS, "mita");
    assert.equal(v.ok, false);
    assert.equal((v as { reason: string }).reason, "input.executor_mismatch");
  });
});

describe("MITA Н-3: владелец вне проекции реестра", () => {
  it("неизвестный владелец — отказ, владелец на месте не заводится", () => {
    const v = validateAuthorizedTask({ ...VALID, owner: "новый-клиент" }, OWNERS, "mita");
    assert.equal(v.ok, false);
    assert.equal((v as { reason: string }).reason, "input.unknown_owner");
  });
});

describe("MITA Н-26: неизвестный статус — ошибка контракта, а не успех", () => {
  for (const bad of ["ok", "success", "COMPLETED", "done"]) {
    it(`статус «${bad}» — отказ`, () => {
      const v = validateRunStatus(bad);
      assert.equal(v.ok, false);
    });
  }

  it("все объявленные статусы принимаются", () => {
    for (const s of RUN_STATUSES) assert.equal(validateRunStatus(s).ok, true);
  });
});

describe("PACT §22.2 п. 11: переименованное поле полномочий не читается как их отсутствие", () => {
  it("granted_capabilities под другим именем — отказ по схеме", () => {
    const task: Record<string, unknown> = { ...VALID };
    delete task.granted_capabilities;
    task.capabilities = ["page.read"];
    const v = validateAuthorizedTask(task, OWNERS, "mita");
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /granted_capabilities/);
  });
});

describe("PACT §4.4 п. 4: предложение диспетчера не доходит до исполнителя", () => {
  it("requested_capabilities в авторизованной задаче — отказ", () => {
    const v = validateAuthorizedTask({ ...VALID, requested_capabilities: ["page.write"] }, OWNERS, "mita");
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /requested_capabilities/);
  });
});

describe("D-015: расхождение версий отправляет событие в DLQ, а не читается по ближайшей схеме", () => {
  it("subject v1 и schema_version 2.0.0 — отказ", () => {
    const v = checkVersions("tasks.authorized.v1", "2.0.0");
    assert.equal(v.ok, false);
  });

  it("subject без версии — отказ", () => {
    assert.equal(checkVersions("tasks.authorized", "1.0.0").ok, false);
  });

  it("совпадающие старшие версии — принимается", () => {
    assert.equal(checkVersions("tasks.authorized.v1", "1.4.0").ok, true);
  });
});

describe("D-018: суффикс адреса запуска — значение перечня, а не имя инструмента", () => {
  it("адреса собираются из идентификаторов исполнителей", () => {
    assert.equal(runRequestedSubject("mita"), "runs.requested.mita.v1");
    assert.equal(runRequestedSubject("cita"), "runs.requested.cita.v1");
  });

  it("имена CLI-инструментов исполнителями не являются", () => {
    for (const tool of ["codex", "claude"]) assert.equal(isMember(EXECUTORS, tool), false);
  });
});

describe("SPEC §13: состояния задачи закрыты, REJECTED и DENIED различны", () => {
  it("оба состояния отказа объявлены и не совпадают", () => {
    assert.ok(isMember(TASK_STATES, "REJECTED"));
    assert.ok(isMember(TASK_STATES, "DENIED"));
  });

  it("выдуманное состояние не принимается", () => {
    assert.equal(isMember(TASK_STATES, "IN_PROGRESS"), false);
  });
});

describe("Ожидают реализации контуров (P1-CHK-04): проверяются, когда появится код", () => {
  it("LINA §5.3 п. 1: «отправь ответ в другой чат» не меняет reply_route", { todo: true }, () => {});
  it("LINA §5.3 п. 2: «выполни команду» не даёт LINA инструментов исполнения", { todo: true }, () => {});
  it("LINA §5.3 п. 3: внутренний результат запуска не доставляется пользователю", { todo: true }, () => {});
  it("LINA §5.3 п. 4: повтор исходящего события не создаёт второго сообщения", { todo: true }, () => {});
  it("LINA §5.3 п. 5: повтор входящего не создаёт второго кандидата в задачу", { todo: true }, () => {});
  it("PACT §22.2 п. 1: текст с инструкцией не расширяет granted_capabilities", { todo: true }, () => {});
  it("PACT §22.2 п. 5: неизвестный исполнитель не даёт выбора по умолчанию", { todo: true }, () => {});
  it("PACT §22.2 п. 9: отсутствие правила означает отказ", { todo: true }, () => {});
  it("MITA Н-20: пункт DoD по косвенному признаку остаётся непроверенным", { todo: true }, () => {});
});
