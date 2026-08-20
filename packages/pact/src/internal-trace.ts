/**
 * Признаки внутренней диагностики в тексте, предназначенном человеку
 * (W1-PACT-09, LINA L-11).
 *
 * Зачем это отдельная проверка. Текст отчёта составляет исполнитель, а он
 * работает с недоверенным содержимым и с ошибками внешних систем. Самый обычный
 * способ утечки устройства системы — не злой умысел, а пересылка человеку
 * сообщения об ошибке «как есть»: в нём окажутся пути на диске, имена служб
 * и трассировка стека.
 *
 * Признаки перечислены закрыто и намеренно узко. Широкая эвристика («слово
 * error») ловила бы законные тексты и приучала бы обходить проверку, а обойдённая
 * проверка не защищает ничего.
 */
export interface TraceHit {
  marker: string;
  where: number;
}

const MARKERS: readonly { marker: string; test: RegExp }[] = [
  // Путь внутри системы: и корень состояния, и каталог кода.
  { marker: "path.state", test: /\/var\/lib\/lpmc-system(\/|\b)/ },
  { marker: "path.code", test: /\/usr\/local\/lib\/lpmc(\/|\b)/ },
  // Кадр трассировки стека Node: «    at Функция (файл:строка)».
  { marker: "stack.frame", test: /^\s+at\s+\S+\s*\(/m },
  { marker: "stack.node_internal", test: /\bnode:internal\// },
  // Сокеты и служебные адреса узла.
  { marker: "path.socket", test: /\/run\/lpmc-[a-z]+\// },
  // Сообщения драйвера базы и psql.
  { marker: "db.error", test: /\b(?:ERROR|ОШИБКА):\s+(?:permission denied|relation|column)\b/ },
];

export function findInternalTrace(text: string): TraceHit | null {
  for (const m of MARKERS) {
    const found = m.test.exec(text);
    if (found) return { marker: m.marker, where: found.index };
  }
  return null;
}
