import { readFileSync } from "node:fs";

/**
 * Разрешённая пара «хост × методы». Пустой перечень методов означает, что
 * не разрешён ни один метод: умолчания «разрешено» не существует нигде.
 */
export interface Allow {
  host: string;
  methods: string[];
  /**
   * Разрешённые префиксы пути. Пустой перечень означает «любой путь» — так
   * сохраняется прежнее поведение для хостов, где путь не важен.
   *
   * Зачем это нужно: договорные интерфейсы используют POST для чтения (запрос
   * строк базы — POST .../query). Разрешение «POST на хост» открыло бы заодно
   * создание и изменение. Разрешение не должно быть грубее действия.
   */
  paths?: string[];
}

/**
 * Конфигурация прокси.
 *
 * Обратите внимание: опции отключения проверки сертификата внешнего узла здесь
 * НЕТ, и это сделано намеренно. Такая опция однажды была бы включена «на время
 * отладки», после чего прокси продолжал бы работать, перестав быть механизмом
 * защиты, — и заметить это было бы нечем.
 */
export interface Config {
  listen: string;
  adminSocket: string;
  caCert: string;
  caKey: string;
  /** Публичный ключ PACT (Ed25519, base64) — им проверяется подпись токена. */
  pactPublicKey: string;
  /**
   * Внешняя граница политики узла: запрос обязан удовлетворять и ей, и набору
   * из токена запуска. Пустой перечень запрещает всё — так сужается объём
   * первой волны, механизмом, а не соглашением.
   */
  allow: Allow[];
}

interface RawConfig {
  listen?: string;
  admin_socket?: string;
  ca_cert?: string;
  ca_key?: string;
  pact_public_key?: string;
  allow?: Allow[];
}

export function loadConfig(path: string): { config: Config; pactPublicKey: Buffer } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  const missing = (["listen", "admin_socket", "ca_cert", "ca_key", "pact_public_key"] as const)
    .filter((k) => !raw[k]);
  if (missing.length > 0) {
    throw new Error(`${path}: обязательны поля ${missing.join(", ")}`);
  }
  const pub = Buffer.from(raw.pact_public_key!, "base64");
  if (pub.length !== 32) {
    throw new Error(
      `${path}: pact_public_key должен быть 32 байта Ed25519, получено ${pub.length}`,
    );
  }
  const config: Config = {
    listen: raw.listen!,
    adminSocket: raw.admin_socket!,
    caCert: raw.ca_cert!,
    caKey: raw.ca_key!,
    pactPublicKey: raw.pact_public_key!,
    allow: raw.allow ?? [],
  };
  return { config, pactPublicKey: pub };
}

/**
 * Проверка «хост, метод и путь разрешены этим перечнем». Сравнение хоста точное,
 * без подстановочных шаблонов: поддомен не наследует разрешение родителя.
 *
 * Путь сравнивается префиксом и только если он назван: правило без путей
 * разрешает любой путь, как и раньше. Пустой путь запроса приводится к «/»,
 * иначе разрешение «/v1/» не совпало бы с запросом к корню.
 */
export function permits(list: Allow[], host: string, method: string, path?: string): boolean {
  const target = normalizePath(path);
  return list.some((a) => {
    if (a.host.toLowerCase() !== host.toLowerCase()) return false;
    if (!a.methods.includes(method)) return false;
    const prefixes = a.paths ?? [];
    if (prefixes.length === 0) return true;
    return prefixes.some((p) => target.startsWith(p));
  });
}

/** Путь без строки запроса: разрешение выдаётся ресурсу, а не его параметрам. */
function normalizePath(path: string | undefined): string {
  if (!path || path === "") return "/";
  const withoutQuery = path.split("?")[0] ?? "/";
  // Абсолютный URL в строке запроса — обычная форма обращения к прокси.
  const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(withoutQuery);
  return m ? (m[1] ?? "/") : withoutQuery;
}
