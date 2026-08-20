import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSuspending, RUN_REASONS, validateRunResult, type RunResult } from "../src/index.js";

const base: RunResult = {
  status: "completed", reason: null, suspension: null, summary: "готово",
  artifact_refs: [], changes: [],
  dod: [{ item: "http-status https://x/ = 200", outcome: "verified", method: "повторный запрос", artifact_ref: "a" }],
  external_calls: [], capabilities_used: ["page.read"], provenance_flags: {},
};

test("completed без причины допустим, остальные исходы — нет", () => {
  assert.equal(validateRunResult(base).ok, true);
  const v = validateRunResult({ ...base, status: "failed", reason: null });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /reason_required/);
});

test("пара «статус + причина» проверяется по таблице", () => {
  assert.equal(validateRunResult({ ...base, status: "failed", reason: "execution.service_unavailable" }).ok, true);
  const wrong = validateRunResult({ ...base, status: "failed", reason: "human.captcha" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok === false ? wrong.reason : "", /reason_not_for_status/);
});

test("неизвестная причина — ошибка контракта, а не свободный текст", () => {
  const v = validateRunResult({ ...base, status: "failed", reason: "что-то пошло не так" });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /unknown_reason/);
});

test("приостанавливающий исход обязан нести блок приостановки", () => {
  const v = validateRunResult({ ...base, status: "blocked_awaiting_human",
    reason: "human.captcha", suspension: null, dod: [] });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /suspension_required/);
});

test("терминальный исход с блоком приостановки противоречив", () => {
  const v = validateRunResult({ ...base, status: "failed", reason: "execution.service_unavailable",
    suspension: { condition: "x", awaited_decision_id: null, external_state: "no_change" } });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /suspension_on_terminal/);
});

test("состояние внешней системы — из закрытого перечня", () => {
  const v = validateRunResult({ ...base, status: "blocked_awaiting_human", reason: "human.captcha",
    suspension: { condition: "human.captcha", awaited_decision_id: null,
      external_state: "неизвестно" as never } });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /unknown_external_state/);
});

test("completed невозможен при непроверенном пункте", () => {
  const v = validateRunResult({ ...base,
    dod: [{ item: "сделать красиво", outcome: "not_checked", method: "нечем", artifact_ref: null }] });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /completed_with_unverified_dod/);
});

test("completed без единого пункта приёмки невозможен", () => {
  const v = validateRunResult({ ...base, dod: [] });
  assert.equal(v.ok, false);
});

test("приостанавливающие исходы перечислены и отличимы от терминальных", () => {
  assert.equal(isSuspending("blocked_awaiting_human"), true);
  assert.equal(isSuspending("lease_expired"), true);
  assert.equal(isSuspending("failed"), false);
  assert.equal(isSuspending("completed"), false);
});

test("каждая причина перечня допускает хотя бы один статус", () => {
  for (const [reason, statuses] of Object.entries(RUN_REASONS)) {
    assert.ok(statuses.length > 0, reason);
  }
});
