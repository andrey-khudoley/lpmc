import { hostname } from "node:os";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS, validateAuthorizedTask, validateRunResult, type Envelope } from "@lpmc/contracts";
import {
  Workbook, Artifacts, outcomeFor, parseCheck, verifyDod, maskDeep, maskText,
  type Check, type DodReport, type MaskValue,
} from "@lpmc/executor";
import type pg from "pg";
import { runConsumer, stopOnSignals } from "./consumer.js";
import { requestCredentials, requestSecret } from "./credentials.js";
import { createPage, flattenProperties, queryDataSource, NOTION_HOST } from "./notion.js";

/**
 * Контрактный исполнитель.
 *
 * От браузерного отличается ровно одним — способом действия. Всё остальное
 * совпадает намеренно (W1-CITA-01): проверка входа до первого внешнего действия,
 * рабочая тетрадь, артефакты, проверка приёмки наблюдением, маскирование,
 * отчёт человеку через проверку исходящего. Если бы это различалось, добавление
 * второй модальности означало бы вторую систему рядом с первой.
 *
 * Куда идти, исполнитель не берёт из постановки задачи: адресат — строка
 * конфигурации набора данных, а токен — секрет из custody арбитра.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/cita/nats/cita-executor.seed";
const RUNS_ROOT = process.env["LPMC_RUNS_ROOT"] ?? "/var/lib/lpmc-system/cita/runs";
const ARTIFACTS_ROOT = process.env["LPMC_ARTIFACTS_ROOT"] ?? "/var/lib/lpmc-system/cita/artifacts";
const SELF = "cita";
const SCHEMA_VERSION = "1.0.0";
const DEFAULT_LIMIT = Number(process.env["LPMC_DATASET_LIMIT"] ?? 100);

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`cita-runner@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const artifacts = new Artifacts(pool, ARTIFACTS_ROOT);
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "RUNS", durable: "cita-runner", filterSubject: `runs.requested.${SELF}.v1` },
    async (envelope: Envelope) => {
      const task = (envelope.payload ?? {}) as Record<string, unknown>;
      const owners = await knownOwners(pool);
      const verdict = validateAuthorizedTask(task as never, owners, SELF);
      if (!verdict.ok) {
        await publishFailure(pool, envelope, task, verdict.reason);
        console.error(`задача отклонена до действия: ${verdict.reason}`);
        return;
      }

      const runId = String(task["run_id"]);
      const taskId = String(task["task_id"]);
      const owner = String(task["owner"]);
      const lease = task["lease"] as { id: string; generation: number };
      const granted = task["granted_capabilities"] as string[];
      const dod = task["dod"] as string[];
      const objective = String(task["objective"] ?? "");
      const replyRouteId = String(task["reply_route_id"]);

      const fresh = await pool.query(
        `INSERT INTO runs (run_id, generation, task_id, owner_slug, lease_id, reply_route_id,
                           granted, objective, dod, workbook)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (run_id, generation) DO NOTHING`,
        [runId, lease.generation, taskId, owner, lease.id, replyRouteId,
         granted, objective, JSON.stringify(dod), `${owner}/${taskId}/${runId}`]);
      if (fresh.rowCount === 0) {
        await resumeOrAbandon(pool, envelope, runId, lease.generation, taskId);
        return;
      }

      const wb = new Workbook(RUNS_ROOT, owner, taskId, runId);
      wb.plan([
        "проверить состав авторизованной задачи",
        "получить учётные данные запуска и токен набора данных у арбитра",
        "запросить строки внешней базы с пагинацией",
        "проверить критерии приёмки наблюдением",
        "собрать внутренний результат и предложение ответа",
      ]);
      wb.note(`задача ${taskId}, запуск ${runId}, владелец ${owner}`);
      wb.note(`выданные полномочия: ${granted.join(", ")}`);

      await publish(pool, {
        subject: EVENTS.runStarted.subject, eventType: EVENTS.runStarted.eventType,
        payload: { task_id: taskId, run_id: runId, executor: SELF },
        correlationId: envelope.correlation_id, causationId: envelope.event_id,
        dedupKey: `started:${runId}:${lease.generation}`,
      });

      // Подтверждение приходит В ЗАДАЧЕ и относится ровно к этому запуску.
      // Его отсутствие — не ошибка: значит, необратимого пока не подтверждали.
      const approval = (task["approval"] ?? null) as { id?: string } | null;
      const masks = await maskValues(pool, runId);
      // Учётные данные сохраняются для проверки: она выполняется после работы
      // и обращается к внешней системе заново.
      let verifyCreds: Awaited<ReturnType<typeof requestCredentials>> | null = null;
      let verifyToken: string | null = null;
      let verifyDataset: string | null = null;
      const calls: { host: string; outcome: string }[] = [];
      const artifactRefs: string[] = [];
      let rows: Record<string, string>[] = [];
      let failure: string | null = null;
      let needsApproval: { host: string; operation_type: string; description: string } | null = null;
      const changes: Record<string, unknown>[] = [];

      try {
        // Остановка перед необратимым действием происходит ДО любого внешнего
        // обращения (MITA §7, W2-MITA-03). Иначе неудача постороннего вызова —
        // например, чтения — маскировала бы саму необходимость подтверждения,
        // и человек не узнал бы, что у него спрашивали разрешение.
        // Намерение совершить необратимое действие объявлено формой приёмки,
        // а не наличием полномочия: задача на чтение не должна ждать
        // подтверждения только потому, что право на запись у неё есть.
        const creation = dod.map(parseCheck).find((c) => c?.kind === "record-created");
        if (creation?.kind === "record-created" && granted.includes("record.create")
            && approval === null) {
          needsApproval = {
            host: NOTION_HOST, operation_type: "write",
            description: `создать запись «${creation.title}» во внешнем наборе данных`,
          };
          wb.note("остановка перед необратимым действием: нужно подтверждение человека");
        } else if (!granted.includes("dataset.query")) {
          failure = "capability.not_granted";
          wb.note("полномочие dataset.query не выдано: внешних обращений не будет");
        } else {
          const ds = await dataset(pool, owner);
          if (ds === null) {
            failure = "input.dod_not_verifiable";
            wb.note(`для владельца ${owner} не задан ни один набор данных`);
          } else {
            const creds = await requestCredentials(runId, lease.id);
            verifyCreds = creds;
            verifyDataset = ds.external_id;
            wb.note(`учётные данные запуска получены, срок до ${creds.expiresAt}`);
            const token = await requestSecret(runId, lease.id, ds.secret_name);
            if (!token.ok) {
              // Секрет не выдан — внешнего обращения не будет вовсе. Это не сбой
              // исполнителя: custody арбитра сообщила, что выдавать нечего.
              failure = `dependency.secret_service_unavailable`;
              wb.note(`токен набора данных не выдан: ${token.reason}`);
              calls.push({ host: NOTION_HOST, outcome: `токен не выдан: ${token.reason}` });
            } else {
              // Значение токена попадает в набор маскирования немедленно:
              // всё, что уйдёт в отчёт или артефакт, проходит через него.
              masks.push({ value: token.value, label: `токен набора ${ds.alias}` });
              verifyToken = token.value;
              const out = await queryDataSource(creds, token.value, ds.external_id, DEFAULT_LIMIT);
              calls.push({ host: NOTION_HOST,
                outcome: out.ok ? `получено строк ${out.rows.length} за ${out.requests} запрос(ов)`
                  : `отказ ${out.status}: ${out.reason}` });
              if (!out.ok) {
                failure = out.status === 429 ? "execution.service_unavailable"
                  : "execution.interface_changed";
                wb.note(`внешний интерфейс отказал: ${out.reason}`);
              } else {
                rows = out.rows.map((r) => flattenProperties(r.properties));
                if (creation?.kind === "record-created" && approval?.id) {
                  const created = await createPage(creds, token.value, ds.external_id,
                    creation.title,
                    process.env["LPMC_NOTION_TITLE_PROPERTY"] ?? "Name");
                  calls.push({ host: NOTION_HOST,
                    outcome: created.ok ? `создана запись ${created.record.id}`
                      : `отказ ${created.status}: ${created.reason}` });
                  if (created.ok) {
                    changes.push({ system: NOTION_HOST, object: created.record.id,
                      operation: "record.create", reversible: false });
                    wb.note(`создана запись ${created.record.id} по подтверждению ${approval.id}`);
                  } else {
                    failure = "execution.interface_changed";
                  }
                }
                wb.note(`получено строк: ${rows.length}; ещё есть: ${out.hasMore ? "да" : "нет"}`);
                if (granted.includes("report.build")) {
                  const columns = Object.keys(rows[0] ?? {});
                  const table = [columns.join(" | "), columns.map(() => "---").join(" | "),
                    ...rows.map((r) => columns.map((c) => (r[c] ?? "").replace(/\|/g, "/")).join(" | "))]
                    .join("\n");
                  const stored = await artifacts.put(runId, "dataset", "text/markdown",
                    maskText(`# ${ds.alias}\n\nстрок: ${rows.length}\n\n${table}`, masks));
                  artifactRefs.push(stored.artifactRef);
                }
              }
            }
          }
        }
      } catch (e) {
        failure = "execution.service_unavailable";
        wb.note(`запуск прерван: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Проверка приёмки — отдельное наблюдение по собранному результату.
      const report = await verifyDod(dod, async (check: Check) => {
        if (check.kind === "rows-at-least") {
          return { outcome: rows.length >= check.count ? "verified" as const : "failed" as const,
            method: `подсчёт собранных строк: ${rows.length}`,
            artifactRef: artifactRefs[0] ?? null };
        }
        if (check.kind === "record-created") {
          // Отдельное наблюдение ПОСЛЕ действия: запись ищется повторным
          // запросом к внешней системе, а не по факту успешного ответа
          // на создание. Успешный ответ — косвенный признак (§15.3, п. 2).
          if (verifyCreds === null || verifyToken === null) {
            return { outcome: "not_checked" as const,
              method: "внешний интерфейс недоступен для проверки", artifactRef: null };
          }
          const seen = await queryDataSource(verifyCreds, verifyToken, verifyDataset ?? "", 5, {
            property: process.env["LPMC_NOTION_TITLE_PROPERTY"] ?? "Name",
            title: { equals: check.title },
          });
          const found = seen.ok && seen.rows.length > 0;
          return { outcome: found ? "verified" as const : "failed" as const,
            method: `повторный запрос: записей с заголовком «${check.title}» — `
              + `${seen.ok ? seen.rows.length : "запрос не удался"}`,
            artifactRef: artifactRefs[0] ?? null };
        }
        if (check.kind === "artifact-exists") {
          return { outcome: artifactRefs.length > 0 ? "verified" as const : "failed" as const,
            method: `наличие артефакта вида ${check.artifactKind}`,
            artifactRef: artifactRefs[0] ?? null };
        }
        // Формы браузерной модальности контрактному исполнителю недоступны:
        // он не открывает страниц, и делать вид, что открыл, не станет.
        return { outcome: "not_checked" as const,
          method: "форма проверки не поддерживается контрактной модальностью",
          artifactRef: null };
      });
      await saveChecks(pool, runId, report);

      const decided = needsApproval !== null
        // Приостанавливающий исход: запуск закрыт, задача — нет.
        ? { status: "blocked_awaiting_approval" as const, reason: "approval.required_not_granted" }
        : failure !== null && rows.length === 0
          ? { status: "failed" as const, reason: failure }
          : outcomeFor(report, failure === null);
      const result = maskDeep({
        status: decided.status,
        reason: decided.reason,
        suspension: decided.status === "blocked_awaiting_approval"
          ? { condition: "approval.required_not_granted", awaited_decision_id: null,
              // Ничего не менялось: остановка произошла ДО действия.
              external_state: "no_change" as const,
              host: needsApproval?.host, operation_type: needsApproval?.operation_type,
              description: needsApproval?.description }
          : decided.status === "blocked_awaiting_human"
            ? { condition: "dod.not_verifiable", awaited_decision_id: null,
                external_state: "no_change" as const }
            : null,
        summary: rows.length > 0
          ? `собрано строк: ${rows.length}` : "внешних наблюдений нет",
        artifact_refs: artifactRefs,
        changes,
        dod: report.entries,
        external_calls: calls,
        capabilities_used: granted,
        provenance_flags: { source: "contract", untrusted_content: true },
      }, masks);
      const contract = validateRunResult(result);
      if (!contract.ok) {
        wb.note(`результат не соответствует контракту: ${contract.reason}`);
        console.error(`результат запуска ${runId} не соответствует контракту: ${contract.reason}`);
      }
      wb.result(result);

      await pool.query(
        `UPDATE runs SET status = $3, reason = $4, result = $5::jsonb, finished_at = now()
          WHERE run_id = $1 AND generation = $2`,
        [runId, lease.generation, decided.status, decided.reason ?? "", JSON.stringify(result)]);

      const suspending = decided.status === "blocked_awaiting_human"
        || decided.status === "blocked_awaiting_approval";
      const subject = decided.status === "failed" ? EVENTS.runFailed.subject
        : suspending ? EVENTS.runBlocked.subject : EVENTS.runCompleted.subject;
      const eventType = decided.status === "failed" ? EVENTS.runFailed.eventType
        : suspending ? EVENTS.runBlocked.eventType : EVENTS.runCompleted.eventType;
      await publish(pool, {
        subject, eventType,
        payload: { task_id: taskId, run_id: runId, executor: SELF,
          status: decided.status, reason: decided.reason, result,
          ...(needsApproval ? { approval_request: needsApproval } : {}) },
        correlationId: envelope.correlation_id, causationId: envelope.event_id,
        dedupKey: `finished:${runId}:${lease.generation}`,
      });

      const reply = maskText(
        (decided.status === "blocked_awaiting_approval"
          ? `Работа остановлена перед необратимым действием: ${objective}\n`
          : `Готово по задаче: ${objective}\n`)
        + `${result.summary}\n`
        + (artifactRefs.length > 0 ? `Приложения: ${artifactRefs.length}\n` : "")
        + (decided.status === "blocked_awaiting_approval"
          ? "Следующий шаг: подтвердить действие по ссылке, которая придёт отдельным сообщением."
          : report.allVerified ? "Критерии приёмки подтверждены наблюдением."
            : "Критерии приёмки требуют проверки человеком."),
        masks);
      wb.reply(reply);
      await publish(pool, {
        subject: EVENTS.replyProposed.subject, eventType: EVENTS.replyProposed.eventType,
        payload: {
          proposal_id: runId, reply_route_id: replyRouteId,
          channel: String(task["channel"] ?? "cli"),
          adapter_id: String(task["adapter_id"] ?? "lina-cli"),
          content_class: "result", content: { text: reply },
          task_id: taskId, owner,
        },
        correlationId: envelope.correlation_id, causationId: envelope.event_id,
        dedupKey: `reply:${runId}:${lease.generation}`,
      });
      console.log(`запуск ${runId}: ${decided.status}; строк ${rows.length}, артефактов ${artifactRefs.length}`);
    },
    state,
  );

  await nc.drain();
  await pool.end();
}

async function dataset(pool: pg.Pool, owner: string): Promise<
  { alias: string; external_id: string; secret_name: string } | null> {
  const r = await pool.query<{ alias: string; external_id: string; secret_name: string }>(
    `SELECT alias, external_id, secret_name FROM datasets WHERE owner_slug = $1 ORDER BY id LIMIT 1`,
    [owner]);
  return r.rows[0] ?? null;
}

async function knownOwners(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ slug: string }>("SELECT slug FROM owners");
  return r.rows.map((x) => x.slug);
}

async function maskValues(pool: pg.Pool, runId: string): Promise<MaskValue[]> {
  const r = await pool.query<{ value: string; label: string }>(
    "SELECT value, label FROM mask_values WHERE run_id IS NULL OR run_id = $1", [runId]);
  return r.rows;
}

async function saveChecks(pool: pg.Pool, runId: string, report: DodReport): Promise<void> {
  for (const e of report.entries) {
    await pool.query(
      `INSERT INTO dod_checks (run_id, item, outcome, method, artifact_ref) VALUES ($1, $2, $3, $4, $5)`,
      [runId, e.item, e.outcome, e.method, e.artifact_ref]);
  }
}

async function resumeOrAbandon(
  pool: pg.Pool, envelope: Envelope, runId: string, generation: number, taskId: string,
): Promise<void> {
  const saved = await pool.query<{ status: string | null }>(
    `SELECT status FROM runs WHERE run_id = $1 AND generation = $2`, [runId, generation]);
  const status = saved.rows[0]?.status ?? null;
  if (status !== null) {
    console.log(`запуск ${runId} уже завершён (${status}), внешнее действие не повторяется`);
    return;
  }
  await pool.query(
    `UPDATE runs SET status = 'failed', reason = 'run.interrupted', finished_at = now()
      WHERE run_id = $1 AND generation = $2`, [runId, generation]);
  await publish(pool, {
    subject: EVENTS.runFailed.subject, eventType: EVENTS.runFailed.eventType,
    payload: { task_id: taskId, run_id: runId, executor: SELF, status: "failed",
      reason: "execution.service_unavailable",
      result: { status: "failed", reason: "execution.service_unavailable", suspension: null,
        summary: "запуск был прерван; действия не повторяются", dod: [] } },
    correlationId: envelope.correlation_id, causationId: envelope.event_id,
    dedupKey: `interrupted:${runId}:${generation}`,
  });
  console.log(`запуск ${runId} был прерван: объявлен неудавшимся`);
}

async function publishFailure(
  pool: pg.Pool, envelope: Envelope, task: Record<string, unknown>, reason: string,
): Promise<void> {
  const taskId = typeof task["task_id"] === "string" ? task["task_id"] : null;
  const runId = typeof task["run_id"] === "string" ? task["run_id"] : null;
  if (!taskId || !runId) {
    await publish(pool, {
      subject: "execution.dlq.v1", eventType: envelope.event_type,
      payload: { reason, event_id: envelope.event_id },
      correlationId: envelope.correlation_id, causationId: envelope.event_id,
      dedupKey: `dlq:${envelope.event_id}`,
    });
    return;
  }
  await publish(pool, {
    subject: EVENTS.runFailed.subject, eventType: EVENTS.runFailed.eventType,
    payload: { task_id: taskId, run_id: runId, executor: SELF, status: "failed",
      reason: mapInputReason(reason),
      result: { status: "failed", reason: mapInputReason(reason), suspension: null,
        summary: "задача отклонена до первого внешнего действия", dod: [] } },
    correlationId: envelope.correlation_id, causationId: envelope.event_id,
    dedupKey: `rejected:${runId}`,
  });
}

/** Причина отказа входа приводится к закрытому перечню, а не пересказывается. */
function mapInputReason(reason: string): string {
  if (reason.includes("unknown_executor")) return "input.unknown_executor";
  if (reason.includes("executor_mismatch")) return "input.executor_mismatch";
  if (reason.includes("unknown_owner")) return "input.unknown_owner";
  return "input.missing_field";
}

async function publish(
  pool: pg.Pool,
  e: { subject: string; eventType: string; payload: unknown; correlationId: string;
       causationId?: string; dedupKey?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, causation_id, dedup_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [e.subject, e.eventType, SCHEMA_VERSION, JSON.stringify(e.payload),
     e.correlationId, e.causationId ?? null, e.dedupKey ?? null]);
}

main().catch((e: unknown) => {
  console.error(`исполнитель остановлен: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
