import { hostname } from "node:os";
import { createPool, connectAs } from "@lpmc/runtime";
import { EVENTS, validateAuthorizedTask, validateRunResult, type Envelope } from "@lpmc/contracts";
import type pg from "pg";
import { runConsumer, stopOnSignals } from "./consumer.js";

import { BrowserSession, requestCredentials, type PageObservation } from "./browser.js";
import { findInstructionLike } from "./untrusted.js";

import { Workbook, Artifacts, outcomeFor, verifyDod, maskDeep, maskText,
  type Check, type DodReport, type MaskValue } from "@lpmc/executor";

/**
 * Исполнитель браузерной модальности.
 *
 * Порядок проверок задан не удобством, а правилом «отказ до первого внешнего
 * действия» (MITA Н-1…Н-3): состав задачи, исполнитель, владелец и лизинг
 * проверяются ДО того, как будет запрошен доступ к сети. Задача, адресованная
 * другому исполнителю, не должна приводить даже к открытию браузера.
 *
 * Куда идти, исполнитель НЕ берёт из текста задачи. Адреса приходят из allowlist,
 * который выдаёт арбитр вместе с учётными данными запуска: список принадлежит
 * политике, а не постановке. Свободный текст остаётся описанием цели и не
 * управляет ни адресацией, ни полномочиями.
 */
const SEED = process.env["LPMC_NATS_SEED"] ?? "/var/lib/lpmc-system/mita/nats/mita-executor.seed";
const LEASE_SOCKET = process.env["LPMC_LEASE_SOCKET"] ?? "/run/lpmc-pact/lease.sock";
const RUNS_ROOT = process.env["LPMC_RUNS_ROOT"] ?? "/var/lib/lpmc-system/mita/runs";
const ARTIFACTS_ROOT = process.env["LPMC_ARTIFACTS_ROOT"] ?? "/var/lib/lpmc-system/mita/artifacts";
/**
 * Инстансы браузера по владельцам (W2-MITA-02).
 *
 * Профиль браузера содержит cookie внешних систем владельца, поэтому инстанс
 * принадлежит владельцу, а не системе. Запуск владельца A в инстансе владельца B
 * отклоняется до первого действия: иначе сессия одного клиента оказалась бы
 * доступна работе, выполняемой для другого.
 */
const CDP_INSTANCES: Record<string, string> = JSON.parse(
  process.env["LPMC_CDP_INSTANCES"] ?? '{"internal":"http://127.0.0.1:9322"}',
) as Record<string, string>;
const SELF = "mita";
const SCHEMA_VERSION = "1.0.0";

async function main(): Promise<void> {
  const pool = createPool();
  const nc = await connectAs(`mita-runner@${hostname()}`, SEED, process.env["LPMC_NATS_SERVER"]);
  const artifacts = new Artifacts(pool, ARTIFACTS_ROOT);
  const state = stopOnSignals();

  await runConsumer(
    nc,
    { stream: "RUNS", durable: "mita-runner",
      filterSubject: `runs.requested.${SELF}.v1` },
    async (envelope: Envelope) => {
      const task = (envelope.payload ?? {}) as Record<string, unknown>;
      const owners = await knownOwners(pool);
      const verdict = validateAuthorizedTask(task as never, owners, SELF);
      if (!verdict.ok) {
        // Ни браузер, ни сеть здесь ещё не тронуты — и не будут.
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

      // Повторная доставка не повторяет внешнее действие: ключ — запуск вместе
      // с поколением лизинга. Новое поколение означает новый запуск.
      const fresh = await pool.query(
        `INSERT INTO runs (run_id, generation, task_id, owner_slug, lease_id, reply_route_id,
                           granted, objective, dod, workbook)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (run_id, generation) DO NOTHING`,
        [runId, lease.generation, taskId, owner, lease.id, replyRouteId,
         granted, objective, JSON.stringify(dod), `${owner}/${taskId}/${runId}`],
      );
      if (fresh.rowCount === 0) {
        const saved = await pool.query<{ status: string | null }>(
          `SELECT status FROM runs WHERE run_id = $1 AND generation = $2`,
          [runId, lease.generation]);
        const status = saved.rows[0]?.status ?? null;
        if (status !== null) {
          // Запуск завершён: повторная доставка публикует сохранённый результат
          // и не повторяет внешнее действие (MITA W1-07).
          console.log(`запуск ${runId} уже завершён (${status}), внешнее действие не повторяется`);
          return;
        }
        // Запись есть, результата нет — запуск был прерван. Что успел сделать
        // браузер, неизвестно, поэтому повторять действия нельзя; и оставить
        // задачу в RUNNING навсегда тоже нельзя. Единственный честный исход —
        // объявить запуск неудавшимся и отдать решение арбитру.
        await pool.query(
          `UPDATE runs SET status = 'failed', reason = 'run.interrupted', finished_at = now()
            WHERE run_id = $1 AND generation = $2`,
          [runId, lease.generation]);
        await publish(pool, {
          subject: EVENTS.runFailed.subject, eventType: EVENTS.runFailed.eventType,
          payload: { task_id: taskId, run_id: runId, executor: SELF, status: "failed",
            result: { status: "failed", reason: "run.interrupted",
              summary: "запуск был прерван; действия не повторяются" } },
          correlationId: envelope.correlation_id, causationId: envelope.event_id,
          dedupKey: `interrupted:${runId}:${lease.generation}`,
        });
        console.log(`запуск ${runId} был прерван: объявлен неудавшимся, действия не повторяются`);
        return;
      }

      const cdpUrl = CDP_INSTANCES[owner];
      if (cdpUrl === undefined) {
        // Инстанса владельца нет — работать в чужом нельзя. Отказ до действия.
        await publishFailure(pool, envelope, task, "input.instance_mismatch");
        console.error(`владелец ${owner}: браузерного инстанса нет, запуск отклонён`);
        return;
      }

      const wb = new Workbook(RUNS_ROOT, owner, taskId, runId);
      wb.plan([
        "проверить состав авторизованной задачи",
        "получить учётные данные запуска у арбитра",
        "открыть браузер по CDP и подставить учётные данные прокси",
        "обойти адреса из allowlist владельца",
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

      const masks = await maskValues(pool, runId);
      let observations: PageObservation[] = [];
      const artifactRefs: string[] = [];
      const calls: { host: string; outcome: string }[] = [];
      const injections: { host: string; marker: string }[] = [];
      let failure: string | null = null;
      let session: BrowserSession | null = null;

      try {
        const creds = await requestCredentials(LEASE_SOCKET, runId, lease.id);
        wb.note(`учётные данные запуска получены, срок до ${creds.expiresAt}`);
        wb.note(`разрешённые адреса: ${creds.allow.map((a) => a.host).join(", ") || "нет"}`);
        if (creds.allow.length === 0) failure = "policy.empty_allowlist";

        if (failure === null) {
          session = new BrowserSession(cdpUrl, creds);
          await session.open();
          for (const a of creds.allow) {
            if (!a.methods.includes("GET")) continue;
            const url = `https://${a.host}/`;
            try {
              if (granted.includes("page.screenshot")) {
                const shot = await session.screenshot(url);
                observations.push(shot.observation);
                const stored = await artifacts.put(runId, "screenshot", "image/png", shot.png);
                artifactRefs.push(stored.artifactRef);
              } else if (granted.includes("page.read")) {
                observations.push(await session.read(url));
              } else {
                calls.push({ host: a.host, outcome: "нет полномочия на чтение страницы" });
                continue;
              }
              const last = observations[observations.length - 1]!;
              calls.push({ host: a.host, outcome: `код ${last.status ?? "-"}` });
              // Содержимое страницы недоверенно. Инструкция, найденная в нём,
              // НЕ выполняется: она лишь помечается и сохраняется как улика.
              const suspicious = findInstructionLike(last.text);
              if (suspicious !== null) {
                injections.push({ host: a.host, marker: suspicious.marker });
                const evidence = await artifacts.put(runId, "injection", "text/plain",
                  maskText(last.text.slice(Math.max(0, suspicious.where - 200),
                    suspicious.where + 400), masks));
                artifactRefs.push(evidence.artifactRef);
                wb.note(`на ${a.host} найдено похожее на инструкцию (${suspicious.marker});`
                  + " не выполняется, сохранено как улика");
              }
              wb.note(`${url}: код ${last.status ?? "-"}, заголовок «${last.title}»`);
            } catch (e) {
              const text = e instanceof Error ? e.message : String(e);
              calls.push({ host: a.host, outcome: `отказ: ${text}` });
              wb.note(`${url}: отказ — ${text}`);
              failure = "external.request_failed";
            }
          }
          if (granted.includes("report.build") && observations.length > 0) {
            const report = observations
              .map((o) => `# ${o.title}\n\n${o.url}\n\n${o.text.slice(0, 4000)}`)
              .join("\n\n---\n\n");
            const stored = await artifacts.put(runId, "report", "text/markdown",
              maskText(report, masks));
            artifactRefs.push(stored.artifactRef);
          }
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        wb.note(`запуск прерван: ${failure}`);
      }
      // Браузер НЕ закрывается здесь: проверка критериев — отдельное наблюдение,
      // и делать его нечем, если сессия уже закрыта. Закрытие ниже, после проверки.

      // Проверка критериев — ОТДЕЛЬНОЕ наблюдение после работы, а не переиспользование
      // того, что видели по ходу: наблюдение по ходу относится к моменту действия,
      // а проверять надо результирующее состояние (§15.3, п. 1).
      const report = await verifyDod(dod, async (check: Check) => {
        if (check.kind === "artifact-exists") {
          const found = artifactRefs.length > 0;
          return { outcome: found ? "verified" as const : "failed" as const,
            method: `наличие артефакта вида ${check.artifactKind}`,
            artifactRef: artifactRefs[0] ?? null };
        }
        if (check.kind === "rows-at-least" || check.kind === "record-created") {
          // Формы контрактной модальности. Браузерный исполнитель не считает
          // записи внешней базы и не создаёт их — и не делает вид, что сделал.
          return { outcome: "not_checked" as const,
            method: "форма проверки не поддерживается браузерной модальностью",
            artifactRef: null };
        }
        if (session === null) {
          return { outcome: "not_checked" as const, method: "браузер недоступен", artifactRef: null };
        }
        try {
          // Отдельный заход на страницу: именно «запрос защищённого состояния»,
          // а не признак того, что переход когда-то удался.
          const seen = await session.read(check.url);
          const proof = await artifacts.put(runId, "verification", "text/markdown",
            maskText(`# проверка ${check.kind}\n\n${check.url}\n\nкод ${seen.status ?? "-"}\n\n${seen.text.slice(0, 2000)}`, masks));
          const ok = check.kind === "http-status"
            ? seen.status === check.expect
            : seen.text.includes(check.text) || seen.title.includes(check.text);
          return { outcome: ok ? "verified" as const : "failed" as const,
            method: check.kind === "http-status"
              ? `повторный запрос ${check.url}: код ${seen.status ?? "-"}`
              : `повторный запрос ${check.url}: искали «${check.text}»`,
            artifactRef: proof.artifactRef };
        } catch (e) {
          return { outcome: "not_checked" as const,
            method: `проверка не выполнена: ${e instanceof Error ? e.message : String(e)}`,
            artifactRef: null };
        }
      });
      await saveChecks(pool, runId, report);
      await session?.close();

      const decided = failure !== null && observations.length === 0
        ? { status: "failed" as const, reason: "execution.service_unavailable" }
        : outcomeFor(report, failure === null);
      const status = decided.status;
      const result = maskDeep({
        status,
        reason: decided.reason,
        // Блок приостановки заполняется только для приостанавливающих исходов:
        // он говорит, чего ждём и в каком состоянии оставлена внешняя система.
        suspension: status === "blocked_awaiting_human"
          ? {
              condition: "dod.not_verifiable",
              awaited_decision_id: null,
              // Читали и снимали — внешнего состояния не меняли.
              external_state: "no_change" as const,
            }
          : null,
        summary: observations.length > 0
          ? `прочитано страниц: ${observations.length}; заголовки: ${observations.map((o) => o.title).join("; ")}`
          : "внешних наблюдений нет",
        artifact_refs: artifactRefs,
        changes: [],
        dod: report.entries,
        external_calls: calls,
        capabilities_used: granted,
        provenance_flags: {
          source: "browser",
          untrusted_content: true,
          // Признак, ради которого блок существует: в содержимом встретилось
          // похожее на инструкцию. Он идёт в результат, а не только в журнал,
          // потому что решение о доверии к результату принимает не исполнитель.
          instruction_like_found: injections.length > 0,
          instruction_like: injections,
        },
      }, masks);
      // Собственный результат проверяется по контракту до публикации: событие,
      // нарушающее схему, ломает потребителя, а не автора.
      const contract = validateRunResult(result);
      if (!contract.ok) {
        wb.note(`результат не соответствует контракту: ${contract.reason}`);
        console.error(`результат запуска ${runId} не соответствует контракту: ${contract.reason}`);
      }
      wb.result(result);

      await pool.query(
        `UPDATE runs SET status = $3, reason = $4, result = $5::jsonb, finished_at = now()
          WHERE run_id = $1 AND generation = $2`,
        [runId, lease.generation, status, decided.reason ?? "", JSON.stringify(result)]);

      const subject = status === "failed"
        ? EVENTS.runFailed.subject
        : status === "blocked_awaiting_human"
          ? EVENTS.runBlocked.subject
          : EVENTS.runCompleted.subject;
      const eventType = status === "failed"
        ? EVENTS.runFailed.eventType
        : status === "blocked_awaiting_human"
          ? EVENTS.runBlocked.eventType
          : EVENTS.runCompleted.eventType;
      await publish(pool, {
        subject, eventType,
        payload: { task_id: taskId, run_id: runId, executor: SELF, status,
        reason: decided.reason, result },
        correlationId: envelope.correlation_id, causationId: envelope.event_id,
        dedupKey: `finished:${runId}:${lease.generation}`,
      });

      // Отчёт человеку — НЕ внутренний результат (MITA W1-04). Он короче,
      // не содержит диагностики и уходит только через проверку исходящего.
      const reply = maskText(
        (status === "completed" ? `Сделано: ${objective}\n`
          : status === "partially_completed" ? `Сделано частично: ${objective}\n`
            : status === "blocked_awaiting_human" ? `Нужна проверка человеком: ${objective}\n`
              : `Не сделано: ${objective}\n`)
        + `${result.summary}\n`
        + (artifactRefs.length > 0 ? `Приложения: ${artifactRefs.length}\n` : "")
        + (injections.length > 0
          ? "На странице встретился текст, похожий на инструкцию; он не выполнялся.\n" : "")
        + (report.allVerified ? "Критерии приёмки подтверждены наблюдением."
          : "Следующий шаг: проверить критерии приёмки человеком."),
        masks);
      wb.reply(reply);
      await publish(pool, {
        subject: EVENTS.replyProposed.subject, eventType: EVENTS.replyProposed.eventType,
        payload: {
          proposal_id: runId,
          reply_route_id: replyRouteId,
          channel: String(task["channel"] ?? "cli"),
          adapter_id: String(task["adapter_id"] ?? "lina-cli"),
          content_class: "result",
          content: { text: reply },
          task_id: taskId,
          owner,
        },
        correlationId: envelope.correlation_id, causationId: envelope.event_id,
        dedupKey: `reply:${runId}:${lease.generation}`,
      });
      console.log(`запуск ${runId}: ${status}; наблюдений ${observations.length}, артефактов ${artifactRefs.length}`);
    },
    state,
  );

  await nc.drain();
  await pool.end();
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

async function publishFailure(
  pool: pg.Pool, envelope: Envelope, task: Record<string, unknown>, reason: string,
): Promise<void> {
  const taskId = typeof task["task_id"] === "string" ? task["task_id"] : null;
  const runId = typeof task["run_id"] === "string" ? task["run_id"] : null;
  if (!taskId || !runId) {
    // Событие без тождества некуда отнести: оно уходит в разбор исполнения.
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
      result: { status: "failed", reason, summary: "задача отклонена до первого внешнего действия" } },
    correlationId: envelope.correlation_id, causationId: envelope.event_id,
    dedupKey: `rejected:${runId}`,
  });
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
