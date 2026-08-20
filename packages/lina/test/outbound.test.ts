import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateOutbound } from "../src/outbound.js";
import { CLI_ADAPTER } from "../src/identity.js";

const self = { channel: CLI_ADAPTER.channel, adapterId: CLI_ADAPTER.adapterId };

const good = {
  message_id: "m-1",
  destination: { channel: "cli", adapter_id: "lina-cli", reply_route_id: "r-1" },
  content: { text: "ответ" },
  visibility: "external",
  idempotency_key: "k-1",
};

test("одобренное сообщение своего канала принимается", () => {
  assert.deepEqual(validateOutbound(good, self), { ok: true });
});

test("сообщение чужого адаптера не доставляется", () => {
  const m = { ...good, destination: { ...good.destination, adapter_id: "lina-telegram" } };
  const v = validateOutbound(m, self);
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /foreign_adapter/);
});

test("сообщение чужого канала не доставляется", () => {
  const m = { ...good, destination: { ...good.destination, channel: "telegram" } };
  assert.equal(validateOutbound(m, self).ok, false);
});

test("неизвестная видимость — отказ, а не доставка на всякий случай", () => {
  assert.equal(validateOutbound({ ...good, visibility: "internal" }, self).ok, false);
  assert.equal(validateOutbound({ ...good, visibility: "EXTERNAL" }, self).ok, false);
});

test("неполный адресат — отказ", () => {
  const m = { ...good, destination: { channel: "cli", adapter_id: "lina-cli" } };
  assert.equal(validateOutbound(m as never, self).ok, false);
});

test("отсутствие ключа идемпотентности — отказ: без него повтор неотличим от нового сообщения", () => {
  const { idempotency_key: _drop, ...rest } = good;
  assert.equal(validateOutbound(rest as never, self).ok, false);
});

test("пустой текст не доставляется", () => {
  assert.equal(validateOutbound({ ...good, content: { text: "" } }, self).ok, false);
});
