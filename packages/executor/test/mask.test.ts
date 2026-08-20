import { strict as assert } from "node:assert";
import { test } from "node:test";
import { containsMasked, maskDeep, maskText } from "../src/mask.js";

const values = [{ value: "тайна", label: "пароль" }];

test("пустой набор ничего не меняет: маскировать пока нечего", () => {
  assert.equal(maskText("текст с тайной", []), "текст с тайной");
});

test("значение заменяется меткой, а не удаляется бесследно", () => {
  assert.equal(maskText("вот тайна тут", values), "вот «скрыто:пароль» тут");
});

test("длинные значения заменяются раньше коротких", () => {
  const vs = [{ value: "abc", label: "к" }, { value: "abcdef", label: "д" }];
  assert.equal(maskText("abcdef", vs), "«скрыто:д»");
});

test("маскирование доходит до вложенных полей отчёта", () => {
  const out = maskDeep({ a: ["тайна"], b: { c: "и тайна" }, n: 1 }, values);
  assert.deepEqual(out, { a: ["«скрыто:пароль»"], b: { c: "и «скрыто:пароль»" }, n: 1 });
});

test("проверка перед сохранением находит значение", () => {
  assert.equal(containsMasked("тут тайна", values), "пароль");
  assert.equal(containsMasked("чисто", values), null);
});
