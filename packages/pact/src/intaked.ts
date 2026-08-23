import type pg from "pg";
import { createPool } from "@lpmc/runtime";
import { EVENTS, runRequestedSubject } from "@lpmc/contracts";
import { decide } from "./gate.js";
import { knownOwners, loadRules, recordCandidate, resolveOwner } from "./intake-store.js";
import { TaskRegistry } from "./registry.js";
import { stopOnSignals } from "./consumer.js";

/**
 * Приём задач: кандидат в задачу → задача → вердикт → запрос запуска.
 *
 * Порядок здесь не косметический. Кандидат сначала становится ЗАДАЧЕЙ, и только
 * затем задача проходит проверку политики. Иначе отказ политики не к чему было бы
 * привязать: не осталось бы ни идентификатора, ни журнала, ни маршрута ответа —
 * и обращение исчезало бы бесследно.
 *
 * Отказ в приёме (REJECTED) и отказ политики (DENIED) — разные исходы с разными
 * событиями и разными состояниями задачи (D-022). Первый означает сломанный или
 * неполный вход, второй — корректный вход без разрешения.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/pact/nats/pact-enforcement.seed";
const DURABLE = "pact-intake-candidates";
const CONSUMER = "pact-intake";
const SCHEMA_VERSION = "1.0.0";

/**
 * Исполнители, развёрнутые на этом узле. Список — свойство узла, а не политики:
 * правило вправе назвать любого исполнителя закрытого перечня, но обратиться
 * можно лишь к тому, кто здесь есть.
 */
const DEPLOYED_EXECUTORS = (process.env["LPMC_DEPLOYED_EXECUTORS"] ?? "mita")
  .split(",").map((x) => x.trim()).filter((x) => x !== "");

interface Qualification {
  id: string;
  request_id: string;
  event_id: string;
  decision_sender: string;
  decision_reply_route_id: string;
  decision_channel: string;
  decision_adapter_id: string;
  decision_capabilities: string[];
  owner_hint: string | null;
  payload: { objective: string; dod: string[]; correlation_id: string };
  qualifier_version: string;
}

async function main(): Promise<void> {
  const pool = createPool();
  const registry = new TaskRegistry(pool);
  const state = stopOnSignals();

  // Enforcement не читает брокер вовсе: его вход — разбор, сделанный диспетчером,
  // и лежит он в схеме диспетчера. Права выданы точечно: чтение и отметка о том,
  // что разбор взят в работу. Изменить содержимое разбора enforcement не может —
  // иначе он мог бы подправить вход перед тем, как принять по нему решение.
  while (state.running) {
    // Отказы разбора публикует enforcement: у диспетчера нет права публиковать
    // события вовсе, а обращение, отвергнутое на разборе, обязано оставить след
    // в DLQ приёма — иначе оно исчезает бесследно (W1-SYS-03).
    await drainRejections(pool);
    const taken = await claim(pool);
    if (taken === null) {
      await sleep(Number(process.env["LPMC_INTAKE_IDLE_MS"] ?? 300));
      continue;
    }
    try {
      await handle(pool, registry, taken);
    } catch (e) {
      console.error(`приём не выполнен: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await pool.end();
}

/** Взятие одного разбора: отметка ставится сразу, повторной обработки не будет. */
async function claim(pool: pg.Pool): Promise<Qualification | null> {
  const r = await pool.query<Qualification>(
    `UPDATE dispatch.qualifications SET taken_at = now()
      WHERE id = (SELECT id FROM dispatch.qualifications
                   WHERE taken_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, request_id, event_id, decision_sender, decision_reply_route_id,
                decision_channel, decision_adapter_id, decision_capabilities,
                owner_hint, payload, qualifier_version`);
  return r.rows[0] ?? null;
}

async function handle(pool: pg.Pool, registry: TaskRegistry, q: Qualification): Promise<void> {
  const correlationId = q.payload.correlation_id;
  const owner = await resolveOwner(pool, q.decision_sender, q.decision_reply_route_id);
  const ident = {
    requestId: q.request_id, sender: q.decision_sender, replyRouteId: q.decision_reply_route_id,
    channel: q.decision_channel, adapterId: q.decision_adapter_id, ownerHint: q.owner_hint,
  };
  if (owner === null) {
    // Отсутствие привязки — отказ на валидации, а не догадка по подсказке (D-020).
    await recordCandidate(pool, { ...ident, ownerResolved: null, taskId: null,
      outcome: "REJECTED", reason: "input.owner_binding_missing" });
    console.log(`кандидат ${q.request_id} отклонён: привязка владельца не задана`);
    return;
  }
  if (q.owner_hint !== null && q.owner_hint !== owner) {
    console.log(`подсказка владельца «${q.owner_hint}» разошлась с выведенным «${owner}»`);
  }

  const accepted = await registry.accept(
    {
      ownerSlug: owner, replyRouteId: q.decision_reply_route_id,
      channel: q.decision_channel, adapterId: q.decision_adapter_id,
      objective: q.payload.objective, dod: q.payload.dod,
      idempotencyKey: q.request_id, correlationId,
    },
    {
      subject: EVENTS.taskAccepted.subject, eventType: EVENTS.taskAccepted.eventType,
      schemaVersion: SCHEMA_VERSION,
      payload: { request_id: q.request_id, owner, reply_route_id: q.decision_reply_route_id },
      correlationId, causationId: q.event_id, dedupKey: q.request_id,
    });
  await recordCandidate(pool, { ...ident, ownerResolved: owner, taskId: accepted.taskId,
    outcome: "ACCEPTED", reason: "task.accepted" });
  if (!accepted.created) {
    console.log(`кандидат ${q.request_id}: задача уже создана, повтор не создал вторую`);
    return;
  }

  await registry.transition(accepted.taskId, "VALIDATED", {
    toState: "VALIDATED", reason: "input.valid", causeEventId: q.event_id });
  await registry.transition(accepted.taskId, "POLICY_PENDING", {
    toState: "POLICY_PENDING", reason: "policy.pending", causeEventId: q.event_id });

  const [{ rules, version }, owners] = await Promise.all([loadRules(pool), knownOwners(pool)]);
  // На вход гейта идут ТОЛЬКО значения закрытых типов из разбора. Ни цель,
  // ни критерии приёмки сюда не передаются: они лежат в payload и попадают
  // лишь в карточку задачи.
  const verdict = decide(
    { sender: q.decision_sender, ownerSlug: owner,
      requestedCapabilities: q.decision_capabilities, rulesetVersion: version },
    rules, owners);

  const policyEvent = {
    subject: EVENTS.policyDecided.subject, eventType: EVENTS.policyDecided.eventType,
    schemaVersion: SCHEMA_VERSION,
    payload: {
      task_id: accepted.taskId,
      decision: verdict.ok ? "ALLOWED" : verdict.kind,
      reason: verdict.ok ? "policy.rule_matched" : verdict.reason,
      ruleset_version: verdict.rulesetVersion,
      qualifier_version: q.qualifier_version,
      granted_capabilities: verdict.ok ? verdict.grantedCapabilities : [],
    },
    correlationId, causationId: q.event_id, dedupKey: `policy:${accepted.taskId}`,
  };

  if (!verdict.ok) {
    const to = verdict.kind === "REJECTED" ? "REJECTED" : "DENIED";
    await registry.transition(accepted.taskId, to, {
      toState: to, kind: verdict.kind, reason: verdict.reason,
      rulesetVersion: verdict.rulesetVersion, causeEventId: q.event_id }, policyEvent);
    console.log(`задача ${accepted.taskId}: ${verdict.kind} — ${verdict.reason}`);
    return;
  }

  // Политика назвала исполнителя — но развёрнут ли он, политика не знает и знать
  // не должна: состав узла не предмет правил. Проверка здесь, и отказ уходит
  // в СВОЮ очередь разбора: это сбой маршрутизации, а не приёма и не политики.
  if (!DEPLOYED_EXECUTORS.includes(verdict.executor)) {
    await pool.query(
      `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id,
                           causation_id, dedup_key)
       VALUES ('routing.dlq.v1', 'task.authorized', $1, $2::jsonb, $3, $4, $5)`,
      [SCHEMA_VERSION,
       JSON.stringify({ reason: "routing.executor_not_deployed", executor: verdict.executor,
         task_id: accepted.taskId }),
       correlationId, q.event_id, `routing:${accepted.taskId}`]);
    await registry.transition(accepted.taskId, "DENIED", {
      toState: "DENIED", kind: "DENIED", reason: `routing.executor_not_deployed:${verdict.executor}`,
      rulesetVersion: verdict.rulesetVersion, causeEventId: q.event_id }, policyEvent);
    console.log(`задача ${accepted.taskId}: исполнитель ${verdict.executor} не развёрнут`);
    return;
  }

  await registry.transition(accepted.taskId, "READY", {
    toState: "READY", reason: "policy.rule_matched", rulesetVersion: verdict.rulesetVersion,
    grantedCapabilities: verdict.grantedCapabilities, causeEventId: q.event_id }, policyEvent);

  const lease = await registry.issueLease(
    accepted.taskId, verdict.executor, verdict.grantedCapabilities, verdict.leaseTtlSeconds,
    {
      subject: EVENTS.taskAuthorized.subject, eventType: EVENTS.taskAuthorized.eventType,
      schemaVersion: SCHEMA_VERSION,
      payload: {
        task_id: accepted.taskId, owner, executor: verdict.executor,
        granted_capabilities: verdict.grantedCapabilities, ruleset_version: verdict.rulesetVersion,
      },
      correlationId, causationId: q.event_id, dedupKey: `authorized:${accepted.taskId}`,
    });
  await registry.transition(accepted.taskId, "LEASED", {
    toState: "LEASED", reason: "lease.issued",
    grantedCapabilities: verdict.grantedCapabilities, causeEventId: q.event_id,
  }, {
    subject: runRequestedSubject(verdict.executor), eventType: "run.requested",
    schemaVersion: SCHEMA_VERSION,
    payload: {
      task_id: accepted.taskId, run_id: lease.runId, executor: verdict.executor, owner,
      granted_capabilities: verdict.grantedCapabilities,
      lease: { id: lease.leaseId, generation: lease.generation, ttl_seconds: verdict.leaseTtlSeconds },
      reply_route_id: q.decision_reply_route_id,
      channel: q.decision_channel, adapter_id: q.decision_adapter_id,
      dod: q.payload.dod, objective: q.payload.objective,
      // Адрес браузерного инстанса владельца выдаёт арбитр вместе с полномочиями,
      // а не выбирает исполнитель: инстанс принадлежит владельцу (W2-MITA-02), и
      // соответствие «владелец → инстанс» — такая же политика, как allowlist.
      // Исполнителю схема арбитра недоступна, поэтому значение едет в задаче.
      cdp_url: await browserFor(pool, owner),
    },
    correlationId, causationId: q.event_id, dedupKey: `run:${lease.runId}`,
  });
  console.log(`задача ${accepted.taskId}: ALLOWED — ${verdict.grantedCapabilities.join(", ")}`
    + `; запуск ${lease.runId} адресован исполнителю ${verdict.executor}`);
}

/** Адрес браузерного инстанса владельца; null, если инстанс не назначен. */
async function browserFor(pool: pg.Pool, owner: string): Promise<string | null> {
  try {
    const r = await pool.query<{ cdp_url: string }>(
      "SELECT cdp_url FROM browser_instances WHERE owner_slug = $1 AND disabled_at IS NULL", [owner]);
    return r.rows[0]?.cdp_url ?? null;
  } catch { return null; }
}

async function drainRejections(pool: pg.Pool): Promise<void> {
  const r = await pool.query<{ event_id: string; request_id: string | null; reason: string;
    payload: Record<string, unknown>; stage: string }>(
    `UPDATE dispatch.rejections SET taken_at = now()
      WHERE id IN (SELECT id FROM dispatch.rejections WHERE taken_at IS NULL
                    ORDER BY id LIMIT 16 FOR UPDATE SKIP LOCKED)
      RETURNING event_id, request_id, reason, payload, stage`);
  for (const row of r.rows) {
    const correlation = typeof row.payload["correlation_id"] === "string"
      ? row.payload["correlation_id"] : row.event_id;
    await pool.query(
      `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id,
                           causation_id, dedup_key)
       VALUES ($7, $1, $2, $3::jsonb, $4, $5, $6)`,
      ["request.submitted", SCHEMA_VERSION,
       JSON.stringify({ reason: row.reason, request_id: row.request_id }),
       correlation, row.event_id, `dlq:${row.event_id}`, `${row.stage}.dlq.v1`]);
    console.log(`отказ этапа ${row.stage} (${row.event_id}) отправлен в ${row.stage}.dlq.v1: ${row.reason}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e: unknown) => {
  console.error(`служба приёма задач остановлена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
