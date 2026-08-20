import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkEnvelope, checkEnvelopeFor } from "../src/index.js";

const good = {
  event_id: "11111111-1111-4111-8111-111111111111",
  event_type: "task.accepted",
  schema_version: "1.0.0",
  occurred_at: "2026-08-19T10:00:00.000Z",
  producer: { service: "pact", instance: "vds" },
  correlation_id: "c-1",
  payload: {},
};

test("полный конверт проходит", () => {
  assert.deepEqual(checkEnvelope(good), { ok: true });
});

test("разобранный JSON без полей конвертом не является", () => {
  const v = checkEnvelope({});
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /missing_field/);
});

test("тождество события обязано быть uuid: на нём держится дедупликация", () => {
  const v = checkEnvelope({ ...good, event_id: "событие-1" });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /event_id_not_uuid/);
});

test("продюсер обязателен: без него неизвестно, чьё это событие", () => {
  const { producer: _drop, ...rest } = good;
  assert.equal(checkEnvelope(rest).ok, false);
  assert.equal(checkEnvelope({ ...good, producer: { instance: "x" } }).ok, false);
});

test("отсутствие payload — не пустой payload", () => {
  const { payload: _drop, ...rest } = good;
  assert.equal(checkEnvelope(rest).ok, false);
  assert.equal(checkEnvelope({ ...good, payload: null }).ok, true);
});

test("расхождение старших версий темы и схемы отвергается", () => {
  assert.equal(checkEnvelopeFor("tasks.accepted.v1", good).ok, true);
  const v = checkEnvelopeFor("tasks.accepted.v2", good);
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /старшая версия/);
});

test("не объект конвертом не является", () => {
  for (const x of [null, "строка", 42, []]) {
    if (Array.isArray(x)) continue;
    assert.equal(checkEnvelope(x).ok, false, String(x));
  }
});
