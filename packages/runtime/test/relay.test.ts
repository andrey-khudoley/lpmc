import { strict as assert } from "node:assert";
import { test } from "node:test";
import { msgId, toEnvelope, type RelayRow } from "../src/relay.js";

const row: RelayRow = {
  id: "17",
  event_id: "11111111-1111-4111-8111-111111111111",
  subject: "tasks.authorized.v1",
  event_type: "task.authorized",
  schema_version: "1.0.0",
  payload: { task_id: "t-1" },
  correlation_id: "c-1",
  causation_id: null,
  dedup_key: null,
  created_at: new Date("2026-08-19T10:00:00.000Z"),
};

test("без делового ключа тождество сообщения — сама строка outbox", () => {
  assert.equal(msgId(row), row.event_id);
});

test("с деловым ключом тождество включает тип события", () => {
  const withKey = { ...row, dedup_key: "req-42" };
  assert.equal(msgId(withKey), "task.authorized:req-42");
  // Два разных события одной задачи не должны схлопнуться в одно.
  assert.notEqual(msgId(withKey), msgId({ ...withKey, event_type: "task.accepted" }));
});

test("повторная отправка той же строки даёт то же тождество", () => {
  assert.equal(msgId(row), msgId({ ...row }));
});

test("occurred_at — момент записи факта, а не момент отправки", () => {
  const e = toEnvelope(row, "pact", "pact-1");
  assert.equal(e.occurred_at, "2026-08-19T10:00:00.000Z");
  assert.equal(e.producer.service, "pact");
  assert.equal(e.event_id, row.event_id);
  assert.ok(!("causation_id" in e));
  assert.ok(!("deduplication_key" in e));
});
