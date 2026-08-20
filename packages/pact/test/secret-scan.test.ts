import { strict as assert } from "node:assert";
import { test } from "node:test";
import { digestOf, findSecret, type SecretDigest } from "../src/secret-scan.js";

const secret = "s3cr3t-token-xyz";
const d: SecretDigest = {
  salt: "соль-1", digest: digestOf("соль-1", secret), length: secret.length, issuedFor: "lease-7",
};

test("пустой набор выдач ничего не находит: на первой волне выдач нет", () => {
  assert.equal(findSecret(`вот ${secret} внутри`, []), null);
});

test("действующая выдача находится внутри текста", () => {
  assert.equal(findSecret(`держите: ${secret} — готово`, [d]), "lease-7");
});

test("возвращается ссылка на выдачу, а не сам секрет", () => {
  const found = findSecret(secret, [d]);
  assert.equal(found, "lease-7");
  assert.notEqual(found, secret);
});

test("похожий, но другой текст не срабатывает", () => {
  assert.equal(findSecret("s3cr3t-token-xyZ", [d]), null);
});

test("текст короче секрета не проверяется впустую", () => {
  assert.equal(findSecret("короткий", [d]), null);
});

test("другая соль не находит тот же секрет: хеши солятся выдачей", () => {
  const other = { ...d, salt: "соль-2" };
  assert.equal(findSecret(secret, [other]), null);
});
