import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RUN_STATUSES } from "@lpmc/contracts";
import { stateForRunStatus } from "../src/runs.js";
import { canTransition } from "../src/states.js";

test("каждый статус закрытого перечня отображается в состояние", () => {
  for (const s of RUN_STATUSES) assert.equal(stateForRunStatus(s).ok, true, s);
});

test("неизвестный статус — ошибка контракта, а не «наверное, завершился»", () => {
  for (const s of ["COMPLETED", "done", "", null, 42]) {
    assert.equal(stateForRunStatus(s).ok, false, String(s));
  }
});

test("успешный запуск не завершает задачу сам по себе", () => {
  const r = stateForRunStatus("completed");
  assert.equal(r.ok && r.to, "REVIEW_PENDING");
});

test("каждое отображение допустимо автоматом состояний из RUNNING", () => {
  for (const s of RUN_STATUSES) {
    const r = stateForRunStatus(s);
    assert.ok(r.ok);
    if (r.ok) assert.equal(canTransition("RUNNING", r.to), true, `${s} → ${r.to}`);
  }
});
