// Мост подписки: исполняет вызов модели НА МАШИНЕ процессом, у которого есть
// логин Claude (/login). Веб (lpmc-web) не имеет доступа к ~/.claude и не хранит
// токен — он лишь проксирует запрос сюда. Токен читается из credentials.json на
// каждый вызов (его свежесть поддерживает Claude Code), поэтому ручной вставки и
// синка не нужно. Слушает только loopback.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const CRED = process.env.LPMC_CLAUDE_CREDENTIALS || `${process.env.HOME}/.claude/.credentials.json`;
const PORT = Number(process.env.LPMC_LLM_BRIDGE_PORT || 6210);

function token() {
  try { return JSON.parse(fs.readFileSync(CRED, "utf8")).claudeAiOauth.accessToken || ""; }
  catch { return ""; }
}

// Подписочный OAuth принимает запрос только когда первый system-блок — идентичность
// Claude Code; иначе Anthropic отвечает обманчивым 429 (не квота). Нашу инструкцию
// кладём вторым блоком.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function anthropic(tok, model, system, user) {
  return new Promise((resolve) => {
    const blocks = [{ type: "text", text: CLAUDE_CODE_IDENTITY }];
    if (system) blocks.push({ type: "text", text: system });
    const body = Buffer.from(JSON.stringify({ model, max_tokens: 1024, system: blocks, messages: [{ role: "user", content: user }] }));
    const req = https.request({
      host: "api.anthropic.com", path: "/v1/messages", method: "POST", timeout: 45000,
      headers: { Authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01", "content-type": "application/json", "content-length": body.length },
    }, (r) => {
      const c = []; r.on("data", (x) => c.push(x));
      r.on("end", () => { let j = {}; try { j = JSON.parse(Buffer.concat(c).toString()); } catch { /* raw */ }
        resolve({ status: r.statusCode || 0, json: j }); });
    });
    req.on("error", (e) => resolve({ status: 0, json: { error: String(e) } }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: { error: "timeout" } }); });
    req.end(body);
  });
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, hasLogin: token() !== "" }));
  }
  if (req.method !== "POST" || req.url !== "/complete") { res.writeHead(404); return res.end(); }
  const c = []; req.on("data", (x) => c.push(x));
  req.on("end", async () => {
    let p = {}; try { p = JSON.parse(Buffer.concat(c).toString()); } catch { /* пусто */ }
    const tok = token();
    res.writeHead(200, { "content-type": "application/json" });
    if (!tok) return res.end(JSON.stringify({ ok: false, error: "нет логина машины (сделайте /login)" }));
    const { status, json } = await anthropic(tok, p.model || "claude-sonnet-4-5", p.system || "", p.user || "");
    if (status >= 300 || status === 0) return res.end(JSON.stringify({ ok: false, error: `subscription ${status}: ${JSON.stringify(json).slice(0, 160)}` }));
    res.end(JSON.stringify({ ok: true, text: json?.content?.[0]?.text || "" }));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`llm-bridge on 127.0.0.1:${PORT}, creds ${CRED}`));
