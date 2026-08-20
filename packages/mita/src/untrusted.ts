/**
 * Признак недоверенного контента, похожего на инструкцию (W2-MITA-05, MITA §20.3).
 *
 * Смысл механизма не в том, чтобы «защититься от инъекции» распознаванием —
 * распознавание можно обойти. Смысл в том, чтобы факт встречи с таким текстом
 * был ЗАФИКСИРОВАН: инструкция со страницы не выполняется в любом случае, потому
 * что исполнитель не берёт из содержимого ни адресации, ни полномочий; но если
 * страница пытается командовать, об этом должны знать человек и арбитр.
 *
 * Признаки узкие и намеренно не претендуют на полноту. Широкая эвристика ловила
 * бы обычные тексты, к ней привыкли бы как к шуму — и перестали бы замечать.
 */
export interface InstructionHit {
  marker: string;
  where: number;
}

/**
 * Граница слова по свойствам Unicode.
 *
 * `\b` в JavaScript опирается на латинский набор: перед кириллической буквой
 * он не срабатывает, и признак на русском молча не находился бы. Ошибка тихая —
 * механизм выглядит работающим, потому что английские признаки ловятся.
 */
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";

const MARKERS: readonly { marker: string; test: RegExp }[] = [
  { marker: "обращение.к.агенту", test: /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions?\b/i },
  { marker: "обращение.к.агенту.ру",
    test: new RegExp(`${L}игнорируй\\s+(?:все\\s+)?(?:предыдущие|прошлые)\\s+(?:инструкции|указания)${R}`, "iu") },
  { marker: "роль", test: /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:assistant|agent|system)\b/i },
  { marker: "выдача.секрета", test: /\b(?:reveal|send|share)\s+(?:the\s+)?(?:api\s+)?(?:key|token|password|secret)\b/i },
  { marker: "выдача.секрета.ру",
    test: new RegExp(`${L}(?:пришли|отправь|покажи)\\s+(?:мне\\s+)?(?:ключ|токен|пароль|секрет)`, "iu") },
  { marker: "смена.адресата", test: /\b(?:send|forward)\s+(?:the\s+)?(?:reply|answer|result)\s+to\b/i },
  { marker: "смена.адресата.ру",
    test: new RegExp(`${L}отправь\\s+ответ\\s+(?:в|на)${R}`, "iu") },
  { marker: "разметка.системного.сообщения", test: /<\|?(?:im_start|system)\|?>/i },
];

export function findInstructionLike(text: string): InstructionHit | null {
  for (const m of MARKERS) {
    const found = m.test.exec(text);
    if (found) return { marker: m.marker, where: found.index };
  }
  return null;
}
