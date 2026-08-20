import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decideEgress, type EgressProposal, type EgressRule } from "../src/egress.js";

const proposal: EgressProposal = {
  proposalId: "p-1",
  replyRouteId: "r-1",
  channel: "cli",
  adapterId: "lina-cli",
  contentClass: "clarification",
  chars: 40,
  ownerSlug: null,
  taskId: null,
};

const allowClarification: EgressRule = {
  rulesetVersion: 1, ownerSlug: "*", channel: "cli",
  contentClass: "clarification", maxChars: 500, decision: "allow",
};

const noRoutes = (): boolean => false;
const routeOfTask = (routeId: string, taskId: string): boolean => taskId === "t-1" && routeId === "r-1";

test("пустая таблица правил запрещает всё", () => {
  const v = decideEgress(proposal, [], noRoutes);
  assert.equal(v.decision, "DENIED");
  assert.equal(v.reason, "egress.no_rule");
});

test("разрешение выдаётся классу содержимого в канале", () => {
  assert.equal(decideEgress(proposal, [allowClarification], noRoutes).decision, "ALLOWED");
});

test("правило другого канала не разрешает наш", () => {
  const r = { ...allowClarification, channel: "telegram" };
  assert.equal(decideEgress(proposal, [r], noRoutes).decision, "DENIED");
});

test("правило другого класса не разрешает наш", () => {
  const r = { ...allowClarification, contentClass: "result" as const };
  assert.equal(decideEgress(proposal, [r], noRoutes).decision, "DENIED");
});

test("неизвестный класс — REJECTED, а не приведение к ближайшему", () => {
  const v = decideEgress({ ...proposal, contentClass: "clarifications" }, [allowClarification], noRoutes);
  assert.equal(v.decision, "REJECTED");
  assert.match(v.reason, /unknown_class/);
});

test("правило прошлой версии таблицы не применяется", () => {
  const old = { ...allowClarification, rulesetVersion: 1 };
  const now = { ...allowClarification, rulesetVersion: 2, decision: "deny" as const };
  assert.equal(decideEgress(proposal, [old, now], noRoutes).decision, "DENIED");
});

test("точное совпадение владельца сильнее «*»: частный запрет выразим", () => {
  const wildcard = { ...allowClarification };
  const deny = { ...allowClarification, ownerSlug: "acme", decision: "deny" as const };
  const p = { ...proposal, ownerSlug: "acme" };
  assert.equal(decideEgress(p, [wildcard, deny], noRoutes).decision, "DENIED");
  assert.equal(decideEgress({ ...p, ownerSlug: "other" }, [wildcard, deny], noRoutes).decision, "ALLOWED");
});

test("превышение длины — отказ по правилу, а не обрезка текста", () => {
  const v = decideEgress({ ...proposal, chars: 501 }, [allowClarification], noRoutes);
  assert.equal(v.decision, "DENIED");
  assert.match(v.reason, /too_long/);
});

test("ответ по задаче уходит только по маршруту этой задачи", () => {
  const own = { ...proposal, taskId: "t-1", contentClass: "result", ownerSlug: "acme" };
  const rule = { ...allowClarification, contentClass: "result" as const };
  assert.equal(decideEgress(own, [rule], routeOfTask).decision, "ALLOWED");
  const foreign = { ...own, replyRouteId: "r-2" };
  const v = decideEgress(foreign, [rule], routeOfTask);
  assert.equal(v.decision, "DENIED");
  assert.equal(v.reason, "egress.route_not_of_task");
});

test("маршрут чужой задачи не спасает разрешающее правило", () => {
  const v = decideEgress({ ...proposal, taskId: "t-9" }, [allowClarification], routeOfTask);
  assert.equal(v.decision, "DENIED");
});

test("пустое содержимое не выпускается", () => {
  assert.equal(decideEgress({ ...proposal, chars: 0 }, [allowClarification], noRoutes).decision, "REJECTED");
});

test("решение не зависит от текста: на входе только его длина", () => {
  const a = decideEgress({ ...proposal, chars: 10 }, [allowClarification], noRoutes);
  const b = decideEgress({ ...proposal, chars: 10 }, [allowClarification], noRoutes);
  assert.deepEqual(a, b);
});
