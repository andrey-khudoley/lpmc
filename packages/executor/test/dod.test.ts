import { strict as assert } from "node:assert";
import { test } from "node:test";
import { outcomeFor, parseCheck, verifyDod, type Check, type Observation } from "../src/dod.js";

const verified = async (): Promise<Observation> =>
  ({ outcome: "verified", method: "отдельный запрос состояния", artifactRef: "a-1" });
const failed = async (): Promise<Observation> =>
  ({ outcome: "failed", method: "отдельный запрос состояния", artifactRef: "a-2" });

test("разбираются только явные формы проверки", () => {
  assert.deepEqual(parseCheck("http-status https://example.com/ = 200"),
    { kind: "http-status", url: "https://example.com/", expect: 200 });
  assert.deepEqual(parseCheck('page-contains https://example.com/ "Example Domain"'),
    { kind: "page-contains", url: "https://example.com/", text: "Example Domain" });
  assert.deepEqual(parseCheck("artifact-exists screenshot"),
    { kind: "artifact-exists", artifactKind: "screenshot" });
});

test("форма контрактной модальности разбирается тем же кодом", () => {
  assert.deepEqual(parseCheck("rows-at-least 100"), { kind: "rows-at-least", count: 100 });
  assert.deepEqual(parseCheck('record-created "Отчёт за август"'),
    { kind: "record-created", title: "Отчёт за август" });
});

test("намерение совершить необратимое выражено формой приёмки, а не текстом", () => {
  // Именно по наличию этой формы исполнитель понимает, что предстоит
  // необратимое действие, и останавливается заранее.
  assert.equal(parseCheck('record-created "X"')?.kind, "record-created");
  assert.equal(parseCheck("создать запись"), null);
});

test("свободный текст не разбирается и не додумывается", () => {
  for (const s of ["готово, если страница прочитана", "настроить интеграцию",
                   "http-status без url", "page-contains https://x/ без кавычек"]) {
    assert.equal(parseCheck(s), null, s);
  }
});

test("непроверяемый пункт получает not_checked, а не verified", async () => {
  const r = await verifyDod(["сделать красиво"], verified);
  assert.equal(r.entries[0]?.outcome, "not_checked");
  assert.equal(r.allVerified, false);
});

test("проверяемый пункт проходит через наблюдателя", async () => {
  const seen: Check[] = [];
  const r = await verifyDod(["http-status https://example.com/ = 200"], async (c) => {
    seen.push(c);
    return { outcome: "verified", method: "повторный запрос", artifactRef: "a-9" };
  });
  assert.equal(seen.length, 1);
  assert.equal(r.entries[0]?.outcome, "verified");
  assert.equal(r.entries[0]?.artifact_ref, "a-9");
  assert.equal(r.allVerified, true);
});

test("completed только когда подтверждён каждый пункт", async () => {
  const all = await verifyDod(["http-status https://x/ = 200"], verified);
  assert.deepEqual(outcomeFor(all, true), { status: "completed", reason: null });

  const mixed = await verifyDod(["http-status https://x/ = 200", "сделать красиво"], verified);
  assert.equal(outcomeFor(mixed, true).status, "partially_completed");
});

test("непроверенный пункт без единого подтверждения доводит запуск до человека", async () => {
  const none = await verifyDod(["сделать красиво"], verified);
  assert.deepEqual(outcomeFor(none, true), { status: "blocked_awaiting_human", reason: "dod.not_verifiable" });
});

test("провалившаяся проверка не считается частичным успехом сама по себе", async () => {
  const r = await verifyDod(["http-status https://x/ = 200"], failed);
  assert.deepEqual(outcomeFor(r, true), { status: "failed", reason: "dod.not_verifiable" });
});

test("неудача действий важнее любых проверок", async () => {
  const r = await verifyDod(["http-status https://x/ = 200"], verified);
  assert.equal(outcomeFor(r, false).status, "failed");
});

test("причина обязательна для всякого исхода, кроме completed", async () => {
  const r = await verifyDod(["сделать красиво"], verified);
  for (const ok of [true, false]) {
    const o = outcomeFor(r, ok);
    if (o.status !== "completed") assert.notEqual(o.reason, null);
  }
});
