import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  accountCall, allowModelCall, CALLS_PER_TURN, CONTEXT_SOFT_LIMIT_TOKENS,
  estimateTokens, foldContext, startTurn, type Message, type TurnState,
} from "../src/budget.js";

const fresh: TurnState = { calls: 0, turnTokens: 0, chainTokens: 0 };

test("число раундов не ограничено: предел стоит на обращениях к модели", () => {
  // Восемь обращений подряд без реплики человека — предел; девятое не проходит.
  let s = fresh;
  for (let i = 0; i < CALLS_PER_TURN; i += 1) {
    assert.equal(allowModelCall(s).proceed, true, `обращение ${i + 1}`);
    s = accountCall(s, 100);
  }
  const v = allowModelCall(s);
  assert.equal(v.proceed, false);
  assert.match(v.proceed === false ? v.reason : "", /calls_exhausted/);
});

test("реплика человека обнуляет счётчик хода", () => {
  let s = fresh;
  for (let i = 0; i < CALLS_PER_TURN; i += 1) s = accountCall(s, 10);
  assert.equal(allowModelCall(s).proceed, false);
  s = startTurn(s);
  assert.equal(allowModelCall(s).proceed, true);
});

test("токены цепочки переживают ход, токены хода — нет", () => {
  let s = accountCall(fresh, 500);
  s = startTurn(s);
  assert.equal(s.turnTokens, 0);
  assert.equal(s.chainTokens, 500);
});

test("мягкий порог не останавливает беседу, а требует свёртки", () => {
  const s: TurnState = { calls: 0, turnTokens: 0, chainTokens: CONTEXT_SOFT_LIMIT_TOKENS };
  const v = allowModelCall(s);
  assert.equal(v.proceed, true);
  assert.equal(v.proceed === true && v.fold, true);
});

test("свёртка сохраняет последние сообщения дословно", () => {
  const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "human" : "agent", text: `сообщение ${i}`,
  }));
  const folded = foldContext(messages, (m) => `конспект ${m.length}`, 3);
  assert.equal(folded.foldedCount, 7);
  assert.equal(folded.summary, "конспект 7");
  assert.deepEqual(folded.tail.map((m) => m.text), ["сообщение 7", "сообщение 8", "сообщение 9"]);
});

test("короткая беседа не сворачивается", () => {
  const messages: Message[] = [{ role: "human", text: "привет" }];
  const folded = foldContext(messages, () => "не должно вызваться", 6);
  assert.equal(folded.foldedCount, 0);
  assert.equal(folded.summary, "");
});

test("оценка размера не занижает: она нужна до обращения к модели", () => {
  assert.ok(estimateTokens("а".repeat(300)) >= 100);
});
