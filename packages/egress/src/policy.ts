import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Allow } from "./config.js";

/**
 * Действующая политика узла = базовый перечень из конфигурации роли ПЛЮС
 * перечень, опубликованный арбитром во время работы.
 *
 * Зачем сумма, а не замена: базовый перечень принадлежит развёртыванию и
 * переживает перезапуск и откат к состоянию из роли; опубликованный принадлежит
 * оператору, который заводит сценарии на живом узле. Ни один из них не должен
 * молча отменять другой.
 *
 * Снимок хранится файлом рядом с ключами прокси и перечитывается при старте:
 * иначе перезапуск прокси возвращал бы границу к состоянию роли, и работавший
 * сценарий переставал бы работать без единого изменения политики.
 */
export class NodePolicy {
  private published: Allow[] = [];

  constructor(private readonly baseline: Allow[], private readonly snapshotPath: string) {
    try {
      const raw = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as { allow?: Allow[] };
      this.published = Array.isArray(raw.allow) ? raw.allow : [];
    } catch {
      this.published = []; // снимка ещё нет — граница равна базовому перечню
    }
  }

  /** Перечень для проверки запроса. Совпадающие хосты объединяются по методам. */
  current(): Allow[] {
    const byHost = new Map<string, Allow>();
    for (const a of [...this.baseline, ...this.published]) {
      const host = String(a.host || "").toLowerCase();
      if (!host) continue;
      const prev = byHost.get(host);
      if (!prev) { byHost.set(host, { host, methods: [...(a.methods ?? [])], paths: [...(a.paths ?? [])] }); continue; }
      for (const m of a.methods ?? []) if (!prev.methods.includes(m)) prev.methods.push(m);
      // Пустой перечень путей означает «любой путь» и потому поглощает частные.
      if ((prev.paths ?? []).length === 0 || (a.paths ?? []).length === 0) prev.paths = [];
      else for (const p of a.paths ?? []) if (!prev.paths!.includes(p)) prev.paths!.push(p);
    }
    return [...byHost.values()];
  }

  /** Принять опубликованный арбитром перечень: применить и сохранить снимок. */
  apply(list: Allow[]): { hosts: number } {
    this.published = list.map((a) => ({
      host: String(a.host).toLowerCase(),
      methods: (a.methods ?? []).map((m) => String(m).toUpperCase()),
      paths: a.paths ?? [],
    }));
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      writeFileSync(this.snapshotPath, JSON.stringify({ allow: this.published }, null, 2), { mode: 0o640 });
    } catch (e) {
      // Снимок не записался — политика всё равно применена в памяти, но об этом
      // нужно знать: после перезапуска граница вернётся к базовой.
      console.error(`снимок политики не сохранён (${this.snapshotPath}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return { hosts: this.published.length };
  }
}
