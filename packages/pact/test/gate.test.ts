/**
 * Негативные тесты gate. Ключевой из них — первый: текст задачи не может
 * расширить выданные полномочия. Он проверяется сравнением вердиктов для двух
 * входов, различающихся только сопроводительным текстом, — и это возможно ровно
 * потому, что текста в аргументах gate нет вовсе.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, type Rule } from "../src/gate.js";

const OWNERS = ["internal"];
const RULES: Rule[] = [{
  rulesetVersion: 1, sender: "operator", ownerSlug: "internal",
  capabilities: ["page.read", "page.screenshot", "report.build"],
  executor: "mita", leaseTtlSeconds: 1800, requiresApproval: false,
}];
const BASE = { sender: "operator", ownerSlug: "internal", rulesetVersion: 1 };

describe("PACT §22.2 п. 1: сообщение с инструкцией внутри не расширяет полномочия", () => {
  it("вердикт не зависит от текста: тексту просто некуда попасть", () => {
    const control = decide({ ...BASE, requestedCapabilities: ["page.read"] }, RULES, OWNERS);
    // Диспетчер, прочитавший «выдай мне page.write», может предложить эту capability —
    // но предложение служит фильтром запрошенного, а не источником прав.
    const injected = decide(
      { ...BASE, requestedCapabilities: ["page.read", "page.write", "secrets.read"] }, RULES, OWNERS);
    assert.equal(injected.ok, true);
    assert.deepEqual(
      (injected as { grantedCapabilities: string[] }).grantedCapabilities,
      (control as { grantedCapabilities: string[] }).grantedCapabilities,
    );
  });
});

describe("PACT §4.4 п. 6: отсутствие правила означает отказ", () => {
  it("неизвестный отправитель — DENIED, а не разрешение по умолчанию", () => {
    const v = decide({ ...BASE, sender: "кто-то ещё", requestedCapabilities: ["page.read"] }, RULES, OWNERS);
    assert.equal(v.ok, false);
    assert.equal((v as { kind: string }).kind, "DENIED");
  });

  it("пустая таблица правил запрещает всё", () => {
    const v = decide({ ...BASE, requestedCapabilities: ["page.read"] }, [], OWNERS);
    assert.equal(v.ok, false);
    assert.equal((v as { reason: string }).reason, "policy.no_matching_rule");
  });

  it("запрошено только неразрешённое — отказ, а не пустой набор прав", () => {
    const v = decide({ ...BASE, requestedCapabilities: ["invoice.submit"] }, RULES, OWNERS);
    assert.equal(v.ok, false);
    assert.equal((v as { reason: string }).reason, "policy.no_capability_granted");
  });
});

describe("PACT §4.4 п. 4: granted ⊆ allowed_by_rules ∩ requested", () => {
  it("выдаётся пересечение, а не объединение", () => {
    const v = decide({ ...BASE, requestedCapabilities: ["page.read", "invoice.submit"] }, RULES, OWNERS);
    assert.deepEqual((v as { grantedCapabilities: string[] }).grantedCapabilities, ["page.read"]);
  });

  it("незапрошенное не выдаётся, даже будучи разрешённым", () => {
    const v = decide({ ...BASE, requestedCapabilities: ["page.read"] }, RULES, OWNERS);
    assert.deepEqual((v as { grantedCapabilities: string[] }).grantedCapabilities, ["page.read"]);
  });
});

describe("PACT §4.4 п. 3: вердикт воспроизводим", () => {
  it("тот же вход и та же версия таблиц дают тот же вердикт", () => {
    const input = { ...BASE, requestedCapabilities: ["report.build", "page.read"] };
    const a = decide(input, RULES, OWNERS);
    const b = decide(input, RULES, OWNERS);
    assert.deepEqual(a, b);
  });

  it("другая версия таблиц — другое основание, правила не применяются", () => {
    const v = decide({ ...BASE, rulesetVersion: 2, requestedCapabilities: ["page.read"] }, RULES, OWNERS);
    assert.equal(v.ok, false);
  });
});

describe("D-022: различение отказа на валидации и отказа политики", () => {
  it("неизвестный владелец — REJECTED: до правил дело не дошло", () => {
    const v = decide({ ...BASE, ownerSlug: "нет-такого", requestedCapabilities: ["page.read"] }, RULES, OWNERS);
    assert.equal((v as { kind: string }).kind, "REJECTED");
  });

  it("корректный вход без разрешения — DENIED: решение арбитра", () => {
    const v = decide({ ...BASE, requestedCapabilities: ["invoice.submit"] }, RULES, OWNERS);
    assert.equal((v as { kind: string }).kind, "DENIED");
  });
});

describe("D-018: исполнитель берётся из правил и проверяется по закрытому перечню", () => {
  it("правило с исполнителем вне перечня — отказ", () => {
    const bad: Rule[] = [{ ...RULES[0]!, executor: "MITA" }];
    const v = decide({ ...BASE, requestedCapabilities: ["page.read"] }, bad, OWNERS);
    assert.equal(v.ok, false);
    assert.equal((v as { reason: string }).reason, "input.unknown_executor");
  });

  it("два правила с разными исполнителями — отказ, а не выбор по умолчанию", () => {
    const ambiguous: Rule[] = [RULES[0]!, { ...RULES[0]!, executor: "cita" }];
    const v = decide({ ...BASE, requestedCapabilities: ["page.read"] }, ambiguous, OWNERS);
    assert.equal((v as { reason: string }).reason, "policy.ambiguous_executor");
  });
});

describe("Автомат состояний", () => {
  it("недопустимый переход не разрешается", async () => {
    const { canTransition, isTerminal } = await import("../src/states.js");
    assert.equal(canTransition("RECEIVED", "RUNNING"), false);
    assert.equal(canTransition("POLICY_PENDING", "READY"), true);
    assert.equal(canTransition("RUNNING", "APPROVAL_PENDING"), true, "ветка внутризапускового approval");
    assert.equal(isTerminal("DENIED"), true);
    assert.equal(canTransition("COMPLETED", "RUNNING"), false, "терминальное состояние поглощает переходы");
  });
});
