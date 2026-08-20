import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findInternalTrace } from "../src/internal-trace.js";

test("обычный отчёт человеку проходит", () => {
  assert.equal(findInternalTrace(
    "Готово. Прочитана страница «Example Domain», собран список из 12 позиций."), null);
});

test("путь внутри системы не выпускается", () => {
  assert.equal(findInternalTrace("не удалось открыть /var/lib/lpmc-system/mita/runs/x")?.marker, "path.state");
  assert.equal(findInternalTrace("сбой в /usr/local/lib/lpmc/packages/mita")?.marker, "path.code");
});

test("трассировка стека не выпускается", () => {
  const text = "Ошибка обработки\n    at handle (/app/x.js:12:5)\n    at next (/app/y.js:3:1)";
  assert.equal(findInternalTrace(text)?.marker, "stack.frame");
  assert.equal(findInternalTrace("TypeError в node:internal/streams/readable")?.marker, "stack.node_internal");
});

test("адрес служебного сокета не выпускается", () => {
  assert.equal(findInternalTrace("нет связи с /run/lpmc-pact/lease.sock")?.marker, "path.socket");
});

test("сообщение драйвера базы не выпускается", () => {
  assert.equal(findInternalTrace("ERROR: permission denied for schema pact")?.marker, "db.error");
});

test("признаки узкие: законный текст со словом «ошибка» проходит", () => {
  assert.equal(findInternalTrace("В форме была ошибка: поле «телефон» не заполнено."), null);
  assert.equal(findInternalTrace("Страница вернула ошибку 500, работа остановлена."), null);
});

test("слово «at» в обычном тексте не считается кадром стека", () => {
  assert.equal(findInternalTrace("Данные взяты at source, как и просили"), null);
});
