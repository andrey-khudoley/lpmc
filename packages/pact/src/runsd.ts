import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { hostname } from "node:os";
import { createPool, connectAs } from "@lpmc/runtime";
import type pg from "pg";
import { EVENTS, validateRunResult, type Envelope } from "@lpmc/contracts";
import { newToken } from "./approval.js";
import { TaskRegistry } from "./registry.js";
import { stateForRunStatus } from "./runs.js";
import { runConsumer, stopOnSignals } from "./consumer.js";

/**
 * Приём фактов исполнения: `runs.started` и завершающие события.
 *
 * Служба отдельная от приёма задач, потому что у них разный источник доверия:
 * приём читает недоверенный контур, а здесь — исполнителя. Разделение позволит
 * остановить одно, не останавливая другое.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/pact/nats/pact-enforcement.seed";
const CONSUMER = "pact-runs";
const SCHEMA_VERSION = "1.0.0";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`pact-runs@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const registry = new TaskRegistry(pool);
  const state = stopOnSignals();

  const handle = async (envelope: Envelope): Promise<void> => {
    const first = await pool.query(
      `INSERT INTO consumed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CONSUMER, envelope.event_id],
    );
    if (first.rowCount === 0) return;

    const p = (envelope.payload ?? {}) as Record<string, unknown>;
    const taskId = typeof p["task_id"] === "string" ? p["task_id"] : "";
    const runId = typeof p["run_id"] === "string" ? p["run_id"] : "";
    if (!taskId || !runId) {
      console.error(`событие запуска без task_id/run_id: ${envelope.event_id}`);
      return;
    }

    if (envelope.event_type === EVENTS.runStarted.eventType) {
      await registry.transition(taskId, "RUNNING", {
        toState: "RUNNING", reason: "run.started", causeEventId: envelope.event_id,
      }).catch((e: unknown) => {
        // Повторное «начал» после перехода — не повод останавливать поток:
        // факт уже отражён, второй раз отражать нечего.
        console.log(`переход в RUNNING не применён: ${e instanceof Error ? e.message : String(e)}`);
      });
      console.log(`задача ${taskId}: запуск ${runId} начат`);
      return;
    }

    // Результат исполнителя проверяется по контракту ДО отображения в состояние:
    // событие, не соответствующее схеме, не должно двигать задачу. Задача при
    // этом остаётся там, где была, — расхождение разбирает человек, а не автомат.
    const contract = validateRunResult((p["result"] ?? { status: p["status"], dod: [] }) as Record<string, unknown>);
    if (!contract.ok) {
      console.error(`задача ${taskId}: результат не соответствует контракту — ${contract.reason}`);
      return;
    }
    const outcome = stateForRunStatus(p["status"]);
    if (!outcome.ok) {
      console.error(`задача ${taskId}: ${outcome.reason}`);
      return;
    }

    // Остановка перед необратимым действием: исполнитель сдал запуск, не сделав
    // его. Арбитр заводит подтверждение и отправляет человеку одноразовую ссылку.
    if (p["status"] === "blocked_awaiting_approval") {
      await requestApproval(pool, envelope, taskId, runId, p);
    }
    const reported = typeof p["reason"] === "string" && p["reason"] !== "" ? `: ${p["reason"]}` : "";
    await registry.transition(taskId, outcome.to, {
      toState: outcome.to, reason: `${outcome.reason}${reported}`, causeEventId: envelope.event_id,
    });
    console.log(`задача ${taskId}: ${outcome.reason} → ${outcome.to}`);
  };

  // Один поток, три топика: durable-потребитель на каждый, потому что фильтр
  // потребителя — один subject.
  const onApproval = async (envelope: Envelope): Promise<void> => {
    const first = await pool.query(
      `INSERT INTO consumed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [`${CONSUMER}-approvals`, envelope.event_id]);
    if (first.rowCount === 0) return;
    const p = (envelope.payload ?? {}) as Record<string, unknown>;
    const taskId = String(p["task_id"] ?? "");
    const approved = p["decision"] === "approved";
    if (!taskId) return;

    if (!approved) {
      await registry.transition(taskId, "DENIED", {
        toState: "DENIED", kind: "DENIED", reason: "approval.denied",
        causeEventId: envelope.event_id });
      console.log(`задача ${taskId}: подтверждение не выдано → DENIED`);
      return;
    }
    // Возобновление — НОВЫЙ запуск: тот же task_id, новый run_id, новый лизинг
    // (MITA §5.6.3). Подтверждение, выданное на прежний запуск, для нового
    // недействительно, поэтому оно записывается в сам лизинг.
    await registry.transition(taskId, "READY", {
      toState: "READY", reason: "approval.granted", causeEventId: envelope.event_id });
    await resume(pool, registry, taskId, String(p["approval_id"] ?? ""), envelope);
  };

  await Promise.all([
    runConsumer(nc, { stream: "APPROVALS", durable: "pact-approvals-decided",
      filterSubject: EVENTS.approvalDecided.subject }, onApproval, state),
    runConsumer(nc, { stream: "RUNS", durable: "pact-runs-started",
      filterSubject: EVENTS.runStarted.subject }, handle, state),
    runConsumer(nc, { stream: "RUNS", durable: "pact-runs-completed",
      filterSubject: EVENTS.runCompleted.subject }, handle, state),
    runConsumer(nc, { stream: "RUNS", durable: "pact-runs-failed",
      filterSubject: EVENTS.runFailed.subject }, handle, state),
    runConsumer(nc, { stream: "RUNS", durable: "pact-runs-blocked",
      filterSubject: EVENTS.runBlocked.subject }, handle, state),
  ]);

  await nc.drain();
  await pool.end();
}

/**
 * Заведение подтверждения и отправка человеку одноразовой ссылки.
 *
 * Ссылка уходит обычным путём исходящего: предложение ответа класса
 * «уведомление» → проверка исходящего → доставка адаптером. Подтверждение при
 * этом через канал НЕ проходит: по ссылке человек попадает к привратнику
 * арбитра, а канал доставил лишь непрозрачное значение (W2-LINA-01).
 */
async function requestApproval(
  pool: pg.Pool, envelope: Envelope, taskId: string, runId: string, p: Record<string, unknown>,
): Promise<void> {
  const suspension = (p["result"] as { suspension?: Record<string, unknown> } | undefined)?.suspension;
  const request = (p["approval_request"] ?? suspension ?? {}) as Record<string, unknown>;
  const host = String(request["host"] ?? "");
  const operationType = String(request["operation_type"] ?? "");
  const description = String(request["description"] ?? request["condition"] ?? "действие не описано");
  if (!host || !operationType) {
    console.error(`задача ${taskId}: запрос подтверждения без хоста или типа операции`);
    return;
  }

  const t = await pool.query<{ owner_slug: string; reply_route_id: string;
    channel: string | null; adapter_id: string | null }>(
    `SELECT owner_slug, reply_route_id, channel, adapter_id FROM tasks WHERE task_id = $1`, [taskId]);
  const task = t.rows[0];
  if (!task) return;

  const lease = await pool.query<{ granted_capabilities: string[] }>(
    `SELECT granted_capabilities FROM leases WHERE run_id = $1`, [runId]);
  const token = newToken();
  const approvalId = randomUUID();
  const ttl = Number(process.env["LPMC_APPROVAL_TTL_SECONDS"] ?? 1800);

  const inserted = await pool.query(
    `INSERT INTO approvals (approval_id, task_id, run_id, owner_slug, reply_route_id, channel,
       adapter_id, host, operation_type, description, capabilities, token, state, expires_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending',
            now() + make_interval(secs => $13)
      WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE task_id = $2 AND state = 'pending')`,
    [approvalId, taskId, runId, task.owner_slug, task.reply_route_id, task.channel ?? "cli",
     task.adapter_id ?? "lina-cli", host, operationType, description,
     lease.rows[0]?.granted_capabilities ?? [], token, ttl]);
  if (inserted.rowCount === 0) {
    console.log(`задача ${taskId}: подтверждение уже запрошено, второе не создаётся`);
    return;
  }

  const base = process.env["LPMC_APPROVAL_BASE_URL"] ?? "";
  const link = base !== "" ? `${base.replace(/\/$/, "")}/${token}/` : `(ссылка не настроена: ${token})`;
  await pool.query(
    `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id,
                         causation_id, dedup_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [EVENTS.approvalRequested.subject, EVENTS.approvalRequested.eventType, SCHEMA_VERSION,
     JSON.stringify({ approval_id: approvalId, task_id: taskId, run_id: runId,
       host, operation_type: operationType }),
     envelope.correlation_id, envelope.event_id, `approval-req:${approvalId}`]);
  await pool.query(
    `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id,
                         causation_id, dedup_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [EVENTS.replyProposed.subject, EVENTS.replyProposed.eventType, SCHEMA_VERSION,
     JSON.stringify({
       proposal_id: approvalId, reply_route_id: task.reply_route_id,
       channel: task.channel ?? "cli", adapter_id: task.adapter_id ?? "lina-cli",
       content_class: "notification",
       content: { text: `Нужно подтверждение необратимого действия.\n${description}\n`
         + `Внешняя система: ${host}. Ссылка одноразовая: ${link}` },
       // Ссылка действует минуты, годится один раз и не должна оставаться
       // в истории диалога (W2-LINA-02).
       ephemeral: true,
       task_id: taskId, owner: task.owner_slug,
     }),
     envelope.correlation_id, envelope.event_id, `approval-link:${approvalId}`]);
  console.log(`задача ${taskId}: запрошено подтверждение ${approvalId}`);
}

/**
 * Возобновление после подтверждения: новый запуск с новым лизингом.
 *
 * Подтверждение записывается в лизинг, а не в задачу: оно действительно ровно
 * для одного запуска, и следующий обязан получать своё (MITA §5.6.3, п. 3).
 */
async function resume(
  pool: pg.Pool, registry: TaskRegistry, taskId: string, approvalId: string, envelope: Envelope,
): Promise<void> {
  const t = await pool.query<{ owner_slug: string; reply_route_id: string; objective: string;
    dod: string[]; channel: string | null; adapter_id: string | null; correlation_id: string }>(
    `SELECT owner_slug, reply_route_id, objective, dod, channel, adapter_id, correlation_id
       FROM tasks WHERE task_id = $1`, [taskId]);
  const task = t.rows[0];
  if (!task) return;
  const prior = await pool.query<{ executor: string; granted_capabilities: string[] }>(
    `SELECT executor, granted_capabilities FROM leases WHERE task_id = $1
      ORDER BY generation DESC LIMIT 1`, [taskId]);
  const before = prior.rows[0];
  if (!before) return;

  // Привязка прежнего запуска отзывается в прокси немедленно: возобновление
  // означает, что прежний запуск закончился, и его доступ во внешнюю сеть
  // не должен пережить выдачу нового (D-019).
  const priorRun = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM leases WHERE task_id = $1 ORDER BY generation DESC LIMIT 1`, [taskId]);
  if (priorRun.rows[0]) await revokeBinding(priorRun.rows[0].run_id);

  const ttl = Number(process.env["LPMC_LEASE_TTL_SECONDS"] ?? 1800);
  const lease = await registry.issueLease(
    taskId, before.executor, before.granted_capabilities, ttl,
    {
      subject: EVENTS.taskAuthorized.subject, eventType: EVENTS.taskAuthorized.eventType,
      schemaVersion: SCHEMA_VERSION,
      payload: { task_id: taskId, owner: task.owner_slug, executor: before.executor,
        granted_capabilities: before.granted_capabilities, approval_id: approvalId },
      correlationId: task.correlation_id, causationId: envelope.event_id,
      dedupKey: `authorized:${taskId}:${approvalId}`,
    });
  await pool.query(`UPDATE leases SET approval_id = $2 WHERE lease_id = $1`,
    [lease.leaseId, approvalId]);
  await pool.query(`UPDATE approvals SET resumed_run_id = $2 WHERE approval_id = $1`,
    [approvalId, lease.runId]);
  await registry.transition(taskId, "LEASED", {
    toState: "LEASED", reason: "lease.issued_after_approval",
    grantedCapabilities: before.granted_capabilities, causeEventId: envelope.event_id,
  }, {
    subject: `runs.requested.${before.executor}.v1`, eventType: "run.requested",
    schemaVersion: SCHEMA_VERSION,
    payload: {
      task_id: taskId, run_id: lease.runId, executor: before.executor, owner: task.owner_slug,
      granted_capabilities: before.granted_capabilities,
      lease: { id: lease.leaseId, generation: lease.generation, ttl_seconds: ttl },
      approval: { id: approvalId },
      reply_route_id: task.reply_route_id, channel: task.channel ?? "cli",
      adapter_id: task.adapter_id ?? "lina-cli",
      dod: task.dod, objective: task.objective,
    },
    correlationId: task.correlation_id, causationId: envelope.event_id,
    dedupKey: `run:${lease.runId}`,
  });
  console.log(`задача ${taskId}: возобновлена запуском ${lease.runId} по подтверждению ${approvalId}`);
}

/**
 * Отзыв привязки запуска в прокси. Ошибка отзыва не останавливает возобновление:
 * привязка ограничена сроком лизинга, и худший исход — она доживёт до него сама.
 * Молчать о такой ошибке нельзя, поэтому она попадает в журнал.
 */
function revokeBinding(runId: string): Promise<void> {
  const socketPath = process.env["LPMC_EGRESS_ADMIN_SOCKET"] ?? "/run/lpmc-egress/admin.sock";
  return new Promise((resolve) => {
    const req = httpRequest(
      { socketPath, path: `/bindings/${encodeURIComponent(runId)}`, method: "DELETE" },
      (res) => {
        res.resume();
        res.on("end", () => {
          console.log(`привязка запуска ${runId} отозвана (код ${res.statusCode ?? "-"})`);
          resolve();
        });
      });
    req.on("error", (e) => {
      console.error(`привязку запуска ${runId} отозвать не удалось: ${e.message}`);
      resolve();
    });
    req.end();
  });
}

main().catch((e: unknown) => {
  console.error(`служба приёма запусков остановлена: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
