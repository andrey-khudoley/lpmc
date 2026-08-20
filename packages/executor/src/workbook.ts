import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Рабочая тетрадь запуска: `runs/<владелец>/<task_id>/<run_id>/`.
 *
 * Тетрадь описывает ХОД работы и может быть очищена; доказательства результата
 * живут отдельно, в хранилище артефактов (MITA §12.4). Поэтому сюда пишутся план,
 * журнал и итог, но не файлы, на которые ссылается отчёт.
 *
 * Раскладка по владельцу первым уровнем не украшение: удалить всё, относящееся
 * к одному владельцу, должно быть одним действием.
 */
export class Workbook {
  readonly dir: string;

  constructor(root: string, ownerSlug: string, taskId: string, runId: string) {
    this.dir = join(root, ownerSlug, taskId, runId);
    mkdirSync(this.dir, { recursive: true, mode: 0o750 });
  }

  plan(steps: readonly string[]): void {
    this.write("plan.md", steps.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n");
  }

  note(line: string): void {
    // Журнал дописывается по строке: обрыв запуска не должен стирать то,
    // что уже произошло.
    const stamp = new Date().toISOString();
    writeFileSync(join(this.dir, "journal.log"), `${stamp} ${line}\n`, { flag: "a", mode: 0o640 });
  }

  result(data: unknown): void {
    this.write("result.json", JSON.stringify(data, null, 2) + "\n");
  }

  reply(text: string): void {
    this.write("reply.md", text + "\n");
  }

  private write(name: string, content: string): void {
    writeFileSync(join(this.dir, name), content, { mode: 0o640 });
  }
}
