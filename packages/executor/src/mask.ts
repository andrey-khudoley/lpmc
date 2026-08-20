/**
 * Маскирование в выходах (MITA W1-08).
 *
 * Механизм работает с первой волны, хотя маскировать пока нечего: набор значений
 * пуст, потому что секретов исполнителю не выдают. Встроить его позже означало бы
 * пройти по всем уже написанным путям вывода и не забыть ни одного — а забытый
 * путь обнаруживается тем, что значение уже утекло.
 *
 * Маскируется ЗНАЧЕНИЕ, а не имя: имя переменной в тексте безвредно, значение —
 * нет. Замена помечена меткой, чтобы по отчёту было видно, что здесь что-то было.
 */
export interface MaskValue {
  value: string;
  label: string;
}

export function maskText(text: string, values: readonly MaskValue[]): string {
  let out = text;
  // Длинные значения заменяются первыми: короткое значение может быть частью
  // длинного, и обратный порядок оставил бы хвост длинного в тексте.
  for (const v of [...values].sort((a, b) => b.value.length - a.value.length)) {
    if (v.value === "") continue;
    out = out.split(v.value).join(`«скрыто:${v.label}»`);
  }
  return out;
}

/** Рекурсивное маскирование структуры: отчёт — не только строка. */
export function maskDeep<T>(data: T, values: readonly MaskValue[]): T {
  if (typeof data === "string") return maskText(data, values) as unknown as T;
  if (Array.isArray(data)) return data.map((x) => maskDeep(x, values)) as unknown as T;
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) out[k] = maskDeep(v, values);
    return out as T;
  }
  return data;
}

/** Содержит ли текст значение из набора — проверка перед сохранением артефакта. */
export function containsMasked(text: string, values: readonly MaskValue[]): string | null {
  for (const v of values) {
    if (v.value !== "" && text.includes(v.value)) return v.label;
  }
  return null;
}
