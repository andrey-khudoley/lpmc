/**
 * Квалификация Лины для веб-контура.
 *
 * Та же идея, что в контуре LINA: полнота запроса — единственное решение, и она
 * детерминирована. Лина правит поля задачи командами на естественном языке и
 * на каждом шаге пересобирает «текст задачи» (промпт). Пока не хватает
 * обязательного поля (владелец, критерии приёмки) — задаёт уточняющий вопрос;
 * когда всё на месте — обращение полное и задачу можно передать исполнителю.
 */

export interface TaskFields {
  title: string;
  owner: string;
  dod: string;
}

/** Промпт задачи собирается из полей — поэтому он всегда согласован с ними. */
export function buildLinaText(t: TaskFields): string {
  return [
    `цель: ${t.title.trim() || "—"}`,
    `владелец: ${t.owner.trim() || "—"}`,
    `критерии приёмки: ${t.dod.trim() || "—"}`,
  ].join("\n");
}

export interface Patch {
  title?: string;
  owner?: string;
  prio?: string;
  status?: string;
  due_date?: string;
  dod?: string;
}

/** Разбор команды правки полей из свободного текста. Возвращает патч и что изменилось. */
export function parseCommand(text: string, knownOwners: readonly string[]): { patch: Patch; labels: string[] } {
  const patch: Patch = {};
  const labels: string[] = [];
  const t = text.trim();

  const due = /(?:срок|дедлайн|due)\D{0,4}(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/i.exec(t);
  if (due) {
    const d = Number(due[1]); const m = Number(due[2]);
    let y = due[3] ? Number(due[3]) : 2026; if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      patch.due_date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      labels.push(`срок ${patch.due_date}`);
    }
  }

  const own = /(?:владел\S*|клиент\S*|owner)\s+([a-z0-9][a-z0-9-]*)/i.exec(t);
  if (own) {
    const o = own[1]!.toLowerCase();
    if (knownOwners.includes(o)) { patch.owner = o; labels.push(`владелец ${o}`); }
  }

  const pr = /приоритет\S*\s+(высок\S*|обычн\S*|низк\S*)/i.exec(t) || /(высок\S+|низк\S+)\s+приоритет/i.exec(t);
  if (pr) {
    const s = pr[1]!.toLowerCase();
    const v = s.startsWith("высок") ? "высокий" : s.startsWith("низк") ? "низкий" : "обычный";
    patch.prio = v; labels.push(`приоритет ${v}`);
  }

  if (/в работ[ае]|в работу/i.test(t)) { patch.status = "doing"; labels.push("статус в работе"); }
  else if (/на проверк/i.test(t)) { patch.status = "review"; labels.push("статус на проверке"); }
  else if (/готов[оа]|заверш/i.test(t)) { patch.status = "done"; labels.push("статус готово"); }
  else if (/к выполнени/i.test(t)) { patch.status = "todo"; labels.push("статус к выполнению"); }

  const rn = /переименуй\s+(?:в\s+)?["«]?(.+?)["»]?$/i.exec(t);
  if (rn) { patch.title = rn[1]!.trim(); labels.push("переименовано"); }

  const dd = /(?:критери\S*|приёмк\S*|приемк\S*|dod)\s*[:\-—]?\s*(.+)$/i.exec(t);
  if (dd && !rn) {
    const v = dd[1]!.trim();
    if (v.length > 2) { patch.dod = v; labels.push("критерии приёмки обновлены"); }
  }

  return { patch, labels };
}

/** Первое незаполненное обязательное поле, либо null — обращение полное. */
export function missingField(t: TaskFields): "owner" | "dod" | null {
  if (!t.title.trim()) return null;
  if (!t.owner.trim() || t.owner.trim() === "—") return "owner";
  if (!t.dod.trim()) return "dod";
  return null;
}

/**
 * Разбор свободной реплики в общий диалог Лины: «добавь задачу … от клиента …».
 * Слаги владельцев — латиница, тексты задач — кириллица, поэтому владелец
 * отделяется от темы надёжно. Возвращает тему (title) и, если распознан,
 * действующего владельца. Владелец сверяется со списком, чтобы не создать задачу
 * на несуществующего клиента — тогда Лина переспросит.
 */
export function parseInbox(text: string, knownOwners: readonly string[]): { owner: string | undefined; title: string } {
  let t = text.trim();
  // Снять ведущий глагол намерения и слово «задача», если они есть.
  t = t.replace(
    /^\s*(?:лина[,:\s]+)?(?:пожалуйста[,:\s]+)?(?:добав\S*|созда\S*|заведи\S*|сделай|поставь|нов\S*)\s+(?:задач\S*|таск\S*)?\s*[:\-—]?\s*/i,
    "");

  let owner: string | undefined;
  const strip = (frag: string): void => { t = t.replace(frag, " "); };
  const phrases = [
    /(?:^|\s)(?:от|для)\s+(?:клиент\S*\s+|владельц\S*\s+)?([a-z0-9][a-z0-9-]+)/i,
    /(?:^|\s)(?:клиент\S*|владел\S*|owner)\s+([a-z0-9][a-z0-9-]+)/i,
  ];
  for (const re of phrases) {
    const mm = re.exec(t);
    if (mm && knownOwners.includes(mm[1]!.toLowerCase())) { owner = mm[1]!.toLowerCase(); strip(mm[0]); break; }
  }
  // Голый слаг известного владельца где-либо в тексте (тема — кириллица, потому
  // латинский слаг в ней не встречается и ложного срабатывания не даёт).
  if (!owner) {
    for (const o of knownOwners) {
      const re = new RegExp("(?:^|\\s)" + o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)", "i");
      if (re.test(t)) { owner = o; t = t.replace(re, " "); break; }
    }
  }
  const title = t.replace(/\s+/g, " ").replace(/^[\s,;:.—-]+|[\s,;:.—-]+$/g, "").trim();
  return { owner, title };
}

export function questionFor(field: "owner" | "dod"): { field: string; text: string; placeholder: string } {
  if (field === "owner") {
    return {
      field, placeholder: "владелец …",
      text: "К какому владельцу отнести задачу? Укажите слаг (например internal или notion-demo).",
    };
  }
  return {
    field: "dod", placeholder: "критерии приёмки …",
    text: "По какому признаку считать работу выполненной? Перечислите критерии приёмки.",
  };
}
