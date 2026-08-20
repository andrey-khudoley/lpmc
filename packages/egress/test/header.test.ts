import { strict as assert } from "node:assert";
import http from "node:http";
import { test } from "node:test";
import { isLegalHeaderValue } from "../src/header.js";

/**
 * Негативные тесты: запрещённое обязано получать отказ. Значения ниже — те
 * самые, на которых прокси снимался целиком, пока проверки не было.
 *
 * Непечатные символы собираются `chr()`, а не пишутся в строке напрямую: сырыми
 * они неотличимы от пробела, и тест, который нельзя прочитать глазами, проверяет
 * не то, что думает читатель.
 */
const chr = (code: number): string => String.fromCharCode(code);
const NUL = chr(0x00);
const UNIT_SEP = chr(0x1f);
const DEL = chr(0x7f);
const LF = chr(0x0a);
const CR = chr(0x0d);
const TAB = chr(0x09);

test("обычное значение проходит", () => {
  assert.equal(isLegalHeaderValue("sid=abc123"), true);
  assert.equal(isLegalHeaderValue(""), true);
  assert.equal(isLegalHeaderValue("a=1; b=2"), true);
});

test("табуляция и печатный latin1 допустимы", () => {
  assert.equal(isLegalHeaderValue(`sid=a${TAB}b`), true);
  assert.equal(isLegalHeaderValue("sid=abcÿ"), true);
});

test("символы вне latin1 отклоняются", () => {
  assert.equal(isLegalHeaderValue("sid=абв"), false);
  assert.equal(isLegalHeaderValue("sid=✓"), false);
});

test("расщепление заголовка переводом строки отклоняется", () => {
  assert.equal(isLegalHeaderValue(`sid=a${LF}Injected: 1`), false);
  assert.equal(isLegalHeaderValue(`sid=a${CR}${LF}Injected: 1`), false);
});

test("управляющие символы отклоняются", () => {
  assert.equal(isLegalHeaderValue(`sid=a${NUL}b`), false);
  assert.equal(isLegalHeaderValue(`sid=a${UNIT_SEP}b`), false);
  assert.equal(isLegalHeaderValue(`sid=a${DEL}b`), false);
});

/**
 * Главное свойство: проверка совпадает с проверкой Node. Разойдись они —
 * пропущенное здесь значение снова снимало бы процесс, а лишний отказ рвал бы
 * работу с сервисом на ровном месте.
 */
test("вердикт совпадает с поведением Node на построении запроса", () => {
  const samples = [
    "sid=abc",
    "sid=abcÿ",
    "sid=абв",
    "sid=✓",
    `sid=a${LF}b`,
    `sid=a${CR}b`,
    `sid=a${TAB}b`,
    `sid=a${NUL}b`,
    `sid=a${UNIT_SEP}b`,
    `sid=a${DEL}b`,
    "sid=a b",
    "",
  ];
  for (const value of samples) {
    let threw = false;
    try {
      const r = http.request({ host: "127.0.0.1", port: 1, headers: { cookie: value } });
      r.on("error", () => {});
      r.destroy();
    } catch {
      threw = true;
    }
    assert.equal(isLegalHeaderValue(value), !threw,
      `расхождение с Node на ${JSON.stringify(value)}`);
  }
});
