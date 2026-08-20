import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseReview } from "../src/review.js";

test("принятие не требует пояснения", () => {
  assert.deepEqual(parseReview({ decision: "accepted", note: "" }), { ok: true, decision: "accepted", note: "" });
});

test("отказ без причины не принимается: он не даёт исполнителю ничего", () => {
  const r = parseReview({ decision: "rejected", note: "   " });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /rejection_without_reason/);
});

test("отказ с причиной проходит и причина сохраняется дословно", () => {
  const r = parseReview({ decision: "rejected", note: "  нет списка цен  " });
  assert.equal(r.ok && r.note, "нет списка цен");
});

test("решение вне закрытого перечня отклоняется без приведения", () => {
  for (const d of ["ACCEPTED", "accept", "принято", "partially"]) {
    assert.equal(parseReview({ decision: d, note: "" }).ok, false, d);
  }
});
