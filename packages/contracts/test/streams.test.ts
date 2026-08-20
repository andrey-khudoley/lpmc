import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EVENTS, STREAMS, streamFor, subjectMatches, runRequestedSubject } from "../src/index.js";

test("шаблон * покрывает ровно один сегмент", () => {
  assert.equal(subjectMatches("outbound.*.v1", "outbound.cli.v1"), true);
  assert.equal(subjectMatches("outbound.*.v1", "outbound.cli.main.v1"), false);
  assert.equal(subjectMatches("requests.*", "requests.task-candidate.v1"), false);
});

test("шаблон > покрывает непустой хвост", () => {
  assert.equal(subjectMatches("runs.>", "runs.started.v1"), true);
  assert.equal(subjectMatches("runs.>", "runs.requested.mita.v1"), true);
  assert.equal(subjectMatches("runs.>", "runs"), false);
});

test("темы потоков не пересекаются: иначе брокер откажет в создании", () => {
  const pairs: string[] = [];
  for (const a of STREAMS) {
    for (const b of STREAMS) {
      if (a.name >= b.name) continue;
      for (const pa of a.subjects) {
        for (const pb of b.subjects) {
          // Грубая проверка пересечения шаблонов: сравниваем посегментно,
          // считая «*» совместимой с любым сегментом, а «>» — с любым хвостом.
          if (patternsOverlap(pa, pb)) pairs.push(`${a.name}:${pa} ↔ ${b.name}:${pb}`);
        }
      }
    }
  }
  assert.deepEqual(pairs, []);
});

function patternsOverlap(a: string, b: string): boolean {
  const x = a.split("."); const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i]; const q = y[i];
    if (p === ">" || q === ">") return true;
    if (p === undefined || q === undefined) return false;
    if (p === "*" || q === "*") continue;
    if (p !== q) return false;
  }
  return true;
}

test("каждое событие нормативной таблицы попадает ровно в один поток", () => {
  const subjects = Object.values(EVENTS).map((e) => e.subject);
  for (const s of subjects) assert.ok(streamFor(s).length > 0, s);
  assert.equal(streamFor(runRequestedSubject("mita")), "RUNS");
  assert.equal(streamFor("tasks.authorized.v1"), "TASKS");
  assert.equal(streamFor("execution.dlq.v1"), "DLQ");
  assert.equal(streamFor("outbound.cli.v1"), "OUTBOUND");
});

test("тема без потока — ошибка, а не публикация «куда-нибудь»", () => {
  assert.throws(() => streamFor("unknown.thing.v1"), /нет потока/);
});
