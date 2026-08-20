import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isComplete, missingFields, questionFor, REQUIRED_FIELDS } from "../src/completeness.js";

const empty = { objective: null, ownerHint: null, dod: null, replyRouteId: "r-1" };

test("пустое обращение неполно по всем обязательным полям", () => {
  assert.deepEqual(missingFields(empty), ["objective", "owner", "dod"]);
  assert.equal(isComplete(empty), false);
});

test("порядок вопросов предсказуем и совпадает с перечнем обязательных полей", () => {
  assert.deepEqual(missingFields(empty), [...REQUIRED_FIELDS]);
});

test("задача без владельца неполна: владельца не угадывают", () => {
  const d = { ...empty, objective: "собрать данные", dod: ["есть отчёт"] };
  assert.deepEqual(missingFields(d), ["owner"]);
});

test("пробелы не считаются заполненным полем", () => {
  const d = { ...empty, objective: "   ", ownerHint: "internal", dod: ["готово"] };
  assert.deepEqual(missingFields(d), ["objective"]);
});

test("пустой перечень критериев приёмки не считается заполненным", () => {
  const d = { ...empty, objective: "цель", ownerHint: "internal", dod: [] };
  assert.deepEqual(missingFields(d), ["dod"]);
});

test("без маршрута ответа обращение не полно даже при всех полях", () => {
  const d = { objective: "цель", ownerHint: "internal", dod: ["готово"], replyRouteId: null };
  assert.deepEqual(missingFields(d), []);
  assert.equal(isComplete(d), false);
});

test("вопрос по полю фиксирован: одинаковое состояние даёт одинаковый вопрос", () => {
  for (const f of REQUIRED_FIELDS) assert.equal(questionFor(f), questionFor(f));
  assert.notEqual(questionFor("objective"), questionFor("owner"));
});
