import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FIRST_SCENARIO_CAPABILITIES, parseCandidate, proposeCapabilities } from "../src/qualify.js";
import { decide, type Rule } from "@lpmc/pact";

const good = {
  request_id: "11111111-1111-4111-8111-111111111111",
  reply_route_id: "22222222-2222-4222-8222-222222222222",
  channel: "cli",
  adapter_id: "lina-cli",
  recipient_candidate: { user_id: "operator", system_id: "lina-cli" },
  task: { objective: "собрать цены", dod: ["есть список"], owner: "internal" },
};

test("полный кандидат разбирается", () => {
  const r = parseCandidate(good);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.candidate.sender, "cli:operator");
    assert.equal(r.candidate.ownerHint, "internal");
  }
});

test("отправитель складывается из канала и участника, а не из полей сообщения", () => {
  const forged = { ...good, sender: "cli:root", task: { ...good.task, sender: "cli:root" } };
  const r = parseCandidate(forged);
  assert.equal(r.ok && r.candidate.sender, "cli:operator");
});

test("кандидат без участника канала отклоняется: отправителя не из чего сложить", () => {
  const { recipient_candidate: _drop, ...rest } = good;
  const r = parseCandidate(rest);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /user_id/);
});

test("кандидат без цели отклоняется на разборе", () => {
  const r = parseCandidate({ ...good, task: { dod: ["есть список"] } });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /task.objective/);
});

test("кандидат без критериев приёмки отклоняется", () => {
  for (const dod of [undefined, [], ["ок", 5]]) {
    const r = parseCandidate({ ...good, task: { objective: "цель", dod } });
    assert.equal(r.ok, false, JSON.stringify(dod));
  }
});

test("попытка передать выданные права в кандидате отклоняется", () => {
  const r = parseCandidate(
    { ...good, task: { ...good.task, granted_capabilities: ["page.read"] } });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /granted_capabilities/);
});

test("предложение диспетчера не расширяет права: пересечение с правилами", () => {
  const rule: Rule = {
    rulesetVersion: 1, sender: "cli:operator", ownerSlug: "internal",
    capabilities: ["page.read"], executor: "mita", leaseTtlSeconds: 1800, requiresApproval: false,
  };
  const parsed = parseCandidate(good);
  assert.ok(parsed.ok);
  const v = decide(
    { sender: "cli:operator", ownerSlug: "internal",
      requestedCapabilities: proposeCapabilities(parsed.candidate), rulesetVersion: 1 },
    [rule], ["internal"],
  );
  assert.equal(v.ok, true);
  // Предложено три, разрешено одно — выдано одно.
  assert.deepEqual(v.ok && v.grantedCapabilities, ["page.read"]);
  assert.equal(FIRST_SCENARIO_CAPABILITIES.length, 3);
});

test("квалификатор без модели предлагает наборы обеих модальностей", () => {
  const parsed = parseCandidate(good);
  assert.ok(parsed.ok);
  const proposed = proposeCapabilities(parsed.candidate);
  assert.ok(proposed.includes("page.read"));
  assert.ok(proposed.includes("dataset.query"));
});

test("подсказка владельца в кандидате не участвует в решении", () => {
  const rule: Rule = {
    rulesetVersion: 1, sender: "cli:operator", ownerSlug: "internal",
    capabilities: ["page.read"], executor: "mita", leaseTtlSeconds: 1800, requiresApproval: false,
  };
  const forged = { ...good, task: { ...good.task, owner: "acme" } };
  const parsed = parseCandidate(forged);
  assert.ok(parsed.ok);
  // Владельца подставляет вызывающий из таблицы привязок; подсказка «acme»
  // на вердикт не влияет.
  const v = decide(
    { sender: "cli:operator", ownerSlug: "internal",
      requestedCapabilities: proposeCapabilities(parsed.candidate), rulesetVersion: 1 },
    [rule], ["internal"],
  );
  assert.equal(v.ok, true);
});
