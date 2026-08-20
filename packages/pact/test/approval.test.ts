import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claim, newViewerId, sameViewer } from "../src/approval.js";

const later = new Date(Date.now() + 60000);
const earlier = new Date(Date.now() - 60000);
const now = new Date();

test("незаявленная ссылка заявляется за обратившимся", () => {
  const v = claim("pending", null, later, undefined, now);
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.fresh, true);
});

test("заявленная ссылка открывается только тем же зрителем", () => {
  const viewer = newViewerId();
  assert.equal(claim("pending", viewer, later, viewer, now).ok, true);
  const other = claim("pending", viewer, later, newViewerId(), now);
  assert.equal(other.ok, false);
  assert.match(other.ok === false ? other.reason : "", /claimed_by_other/);
});

test("ссылка без предъявленного зрителя после заявки не открывается", () => {
  const v = claim("pending", newViewerId(), later, undefined, now);
  assert.equal(v.ok, false);
});

test("истёкшая ссылка не открывается", () => {
  assert.equal(claim("pending", null, earlier, undefined, now).ok, false);
});

test("решённое подтверждение не пересматривается", () => {
  for (const s of ["approved", "denied", "expired"]) {
    const v = claim(s, null, later, undefined, now);
    assert.equal(v.ok, false, s);
    assert.match(v.ok === false ? v.reason : "", /already_/);
  }
});

test("сравнение зрителей не проходит по префиксу", () => {
  assert.equal(sameViewer("abcdef", "abc"), false);
  assert.equal(sameViewer("abc", "abc"), true);
});
