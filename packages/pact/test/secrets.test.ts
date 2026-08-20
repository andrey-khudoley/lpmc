import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { open, seal } from "../src/secrets.js";

const master = randomBytes(32);

test("значение восстанавливается тем же главным ключом", () => {
  const sealed = seal("пароль-от-панели", master);
  assert.equal(open(sealed, master), "пароль-от-панели");
});

test("шифротекст не содержит значения", () => {
  const sealed = seal("пароль-от-панели", master);
  assert.equal(sealed.ciphertext.toString("utf8").includes("пароль"), false);
});

test("другой главный ключ не открывает значение", () => {
  const sealed = seal("тайна", master);
  assert.throws(() => open(sealed, randomBytes(32)));
});

test("подмена шифротекста обнаруживается, а не расшифровывается в мусор", () => {
  const sealed = seal("тайна", master);
  sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0xff;
  assert.throws(() => open(sealed, master));
});

test("подмена обёрнутого ключа данных обнаруживается", () => {
  const sealed = seal("тайна", master);
  sealed.wrappedKey[0] = sealed.wrappedKey[0]! ^ 0xff;
  assert.throws(() => open(sealed, master));
});

test("два шифрования одного значения дают разный шифротекст", () => {
  const a = seal("одно и то же", master);
  const b = seal("одно и то же", master);
  assert.notEqual(a.ciphertext.toString("hex"), b.ciphertext.toString("hex"));
});
