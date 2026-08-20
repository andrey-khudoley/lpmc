import { strict as assert } from "node:assert";
import { test } from "node:test";
import { operationType, permit, permittedMethods, type IrreversibilityRule } from "../src/irreversibility.js";

test("тип операции вычисляется из метода, а не из намерения", () => {
  assert.equal(operationType("GET"), "read");
  assert.equal(operationType("post"), "write");
  assert.equal(operationType("DELETE"), "delete");
  assert.equal(operationType("PROPFIND"), "unknown");
});

test("пустая таблица запрещает все изменения", () => {
  assert.equal(permit("example.com", "POST", []).allowed, false);
  assert.equal(permit("example.com", "DELETE", []).allowed, false);
  assert.equal(permit("example.com", "PROPFIND", []).allowed, false);
});

test("чтение не бывает необратимым и не требует строки в таблице", () => {
  assert.equal(permit("example.com", "GET", []).allowed, true);
  assert.equal(permit("example.com", "HEAD", []).allowed, true);
});

test("отсутствие строки — «неизвестно», а неизвестное необратимо", () => {
  const rules: IrreversibilityRule[] = [
    { rulesetVersion: 1, host: "a.example", operationType: "write", classification: "reversible" },
  ];
  assert.equal(permit("b.example", "POST", rules).allowed, false);
  assert.match(permit("b.example", "POST", rules).reason, /unknown/);
});

test("строка «reversible» разрешает изменение на своём хосте", () => {
  const rules: IrreversibilityRule[] = [
    { rulesetVersion: 1, host: "a.example", operationType: "write", classification: "reversible" },
  ];
  assert.equal(permit("a.example", "POST", rules).allowed, true);
  assert.equal(permit("a.example", "DELETE", rules).allowed, false);
});

test("действует только старшая версия таблицы", () => {
  const rules: IrreversibilityRule[] = [
    { rulesetVersion: 1, host: "a.example", operationType: "write", classification: "reversible" },
    { rulesetVersion: 2, host: "a.example", operationType: "write", classification: "irreversible" },
  ];
  assert.equal(permit("a.example", "POST", rules).allowed, false);
});

test("из набора методов в токен попадают только разрешённые", () => {
  const r = permittedMethods("example.com", ["GET", "POST", "DELETE"], []);
  assert.deepEqual(r.allowed, ["GET"]);
  assert.equal(r.refused.length, 2);
});
