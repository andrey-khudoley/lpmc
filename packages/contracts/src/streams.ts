/**
 * Потоки JetStream: состав и политика хранения.
 *
 * Это контрактное решение, а не деталь развёртывания, поэтому оно живёт здесь,
 * рядом с именами событий. Имя потока — домен subject в верхнем регистре;
 * та же конвенция используется в правах учётных записей брокера, где доступ
 * к API выдан по именам конкретных потоков.
 *
 * Право СОЗДАВАТЬ потоки не выдано ни одному контуру: их заводит отдельный
 * административный шаг под учётной записью, которая не принадлежит ни LINA,
 * ни PACT, ни исполнителям. Компонент, способный создать поток, способен
 * и переопределить его политику хранения — то есть тихо изменить свойства
 * доставки, на которые опираются соседи.
 */
export interface StreamSpec {
  name: string;
  subjects: string[];
  /** Срок хранения событий; 0 — без ограничения по времени. */
  maxAgeSeconds: number;
  description: string;
}

export const STREAMS: readonly StreamSpec[] = [
  { name: "INBOUND", subjects: ["inbound.>"], maxAgeSeconds: 7 * 24 * 3600,
    description: "сырые входящие сообщения каналов" },
  { name: "REQUESTS", subjects: ["requests.>"], maxAgeSeconds: 30 * 24 * 3600,
    description: "кандидаты в задачу, уточнения, отмены" },
  { name: "TASKS", subjects: ["tasks.>"], maxAgeSeconds: 0,
    description: "приём, отклонение и авторизация задач" },
  { name: "POLICY", subjects: ["policy.>"], maxAgeSeconds: 0,
    description: "вердикты политики" },
  { name: "APPROVALS", subjects: ["approvals.>"], maxAgeSeconds: 0,
    description: "запросы и решения подтверждения необратимых действий" },
  { name: "RUNS", subjects: ["runs.>"], maxAgeSeconds: 90 * 24 * 3600,
    description: "запросы запуска и результаты исполнения" },
  { name: "REPLIES", subjects: ["replies.>"], maxAgeSeconds: 30 * 24 * 3600,
    description: "предложения ответа до egress-проверки" },
  { name: "OUTBOUND", subjects: ["outbound.>"], maxAgeSeconds: 30 * 24 * 3600,
    description: "одобренные внешние сообщения; единственный продюсер — Egress Guard" },
  { name: "DELIVERIES", subjects: ["deliveries.>"], maxAgeSeconds: 30 * 24 * 3600,
    description: "результаты доставки внешних сообщений" },
  { name: "OWNERS", subjects: ["owners.>"], maxAgeSeconds: 0,
    description: "обновления проекции реестра владельцев" },
  { name: "REVIEWS", subjects: ["reviews.>"], maxAgeSeconds: 0,
    description: "решения человека по результату работы; срок хранения не ограничен, как у вердиктов" },
  // Перечень этапов закрыт намеренно: шаблон `*.dlq.v1` пересёкся бы с доменными
  // потоками (`inbound.>` и `inbound.dlq.v1` — один и тот же subject), а брокер
  // не допускает пересечения тем между потоками. Новый этап добавляет строку сюда.
  { name: "DLQ",
    subjects: ["task-ingress.dlq.v1", "qualification.dlq.v1", "routing.dlq.v1",
               "execution.dlq.v1", "delivery.dlq.v1"],
    maxAgeSeconds: 90 * 24 * 3600,
    description: "события, не прошедшие обработку; попадание сюда не подтверждает и не отклоняет задачу" },
];

/** Совпадает ли subject с темой потока (правила NATS: `*` — один сегмент, `>` — хвост). */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/**
 * Поток, в который попадёт событие. Отсутствие потока — ошибка контракта,
 * а не повод опубликовать «куда-нибудь»: событие без потока не сохранится
 * нигде, и потеря будет тихой.
 */
export function streamFor(subject: string): string {
  const hit = STREAMS.filter((s) => s.subjects.some((p) => subjectMatches(p, subject)));
  if (hit.length === 0) throw new Error(`нет потока для темы: ${subject}`);
  if (hit.length > 1) throw new Error(`тема ${subject} попадает в несколько потоков: ${hit.map((h) => h.name).join(", ")}`);
  return hit[0]!.name;
}
