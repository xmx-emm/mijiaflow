import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MijiaFlowError } from "../errors.js";

const MAX_BODY_BYTES = 1_024;
const PAIRING_TTL_MS = 15 * 60_000;
const WORKBENCH_SCRIPT = `(() => {
  const root = document.getElementById("workbench");
  const stateUrl = root.dataset.state;
  const session = document.getElementById("session");
  const operation = document.getElementById("operation");
  const diff = document.getElementById("diff");
  const updated = document.getElementById("updated");
  const badge = document.getElementById("badge");
  const pendingPanel = document.getElementById("pending");
  const pendingSummary = document.getElementById("pending-summary");
  const pendingPhrase = document.getElementById("pending-phrase");
  const pendingExpires = document.getElementById("pending-expires");
  const pendingDiff = document.getElementById("pending-diff");
  const labels = { none: "无会话", "awaiting-passcode": "等待登录码", authenticating: "认证中", ready: "已连接", failed: "连接失败", running: "进行中", succeeded: "已完成", failedOp: "失败" };
  const sessionText = (value) => ({ none: "尚未开始", "awaiting-passcode": "等待在本机输入登录码", authenticating: "正在建立安全连接", ready: "安全会话已就绪", failed: "会话已结束，请回到 AI 客户端重新开始" }[value] || "会话状态未知");
  const render = (data) => {
    const s = data.session || { state: "none" };
    const op = data.operation;
    session.textContent = sessionText(s.state) + (s.mode ? " · " + (s.mode === "read-write" ? "可写" : "只读") : "");
    badge.textContent = labels[s.state] || s.state;
    badge.dataset.state = s.state;
    if (op) {
      operation.hidden = false;
      operation.textContent = (op.summary || op.stage) + " · " + (op.state === "running" ? labels.running : op.state === "succeeded" ? labels.succeeded : labels.failedOp);
      if (op.errorCode) operation.textContent += "（" + op.errorCode + "）";
      diff.hidden = !op.diff?.length;
      diff.textContent = op.diff?.length ? JSON.stringify(op.diff, null, 2) : "";
    } else {
      operation.hidden = true;
      diff.hidden = true;
    }
    const pending = data.pendingPlan;
    if (pending) {
      pendingPanel.hidden = false;
      pendingSummary.textContent = pending.summary + "（对象 " + pending.objectKey + "）";
      pendingPhrase.textContent = pending.confirmation;
      const expired = pending.expiresAt && Date.now() > Date.parse(pending.expiresAt);
      pendingExpires.textContent = (pending.expiresAt ? new Date(pending.expiresAt).toLocaleTimeString() : "--") + (expired ? "（已过期，请重新生成计划）" : "");
      pendingDiff.hidden = !pending.diff?.length;
      pendingDiff.textContent = pending.diff?.length ? JSON.stringify(pending.diff, null, 2) : "";
    } else {
      pendingPanel.hidden = true;
    }
    updated.textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : "刚刚";
  };
  const poll = async () => {
    try {
      const response = await fetch(stateUrl, { cache: "no-store", credentials: "same-origin" });
      if (response.ok) render(await response.json());
    } catch {}
    window.setTimeout(poll, 1200);
  };
  poll();
})();`;
const PAIRING_SCRIPT = `(() => {
  const form = document.getElementById("pairing-form");
  const input = document.getElementById("passcode");
  const slots = Array.from(document.querySelectorAll("[data-slot]"));
  const keys = Array.from(document.querySelectorAll("[data-digit]"));
  const deleteKey = document.querySelector("[data-delete]");
  let value = "";
  let submitting = false;
  const render = () => { slots.forEach((slot, index) => { slot.textContent = value[index] || ""; slot.classList.toggle("active", !submitting && index === value.length); slot.classList.toggle("filled", index < value.length); }); input.value = value; };
  const submitWhenComplete = () => { if (value.length !== 6 || submitting) return; submitting = true; render(); [...keys, deleteKey].forEach((key) => { if (key) key.disabled = true; }); window.setTimeout(() => form.requestSubmit(), 120); };
  keys.forEach((key) => key.addEventListener("click", () => { if (!submitting && value.length < 6) { value += key.dataset.digit; render(); submitWhenComplete(); } }));
  deleteKey.addEventListener("click", () => { if (!submitting) { value = value.slice(0, -1); render(); } });
  document.addEventListener("keydown", (event) => { if (/^[0-9]$/.test(event.key)) { event.preventDefault(); if (!submitting && value.length < 6) { value += event.key; render(); submitWhenComplete(); } } else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); if (!submitting) { value = value.slice(0, -1); render(); } } });
  form.addEventListener("submit", (event) => { if (value.length !== 6) event.preventDefault(); });
  render();
})();`;

const STYLE = `:root{color-scheme:light;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#f3f6fa;color:#17212b}*{box-sizing:border-box}body{margin:0;min-width:280px;min-height:100vh;background:#f3f6fa}main{min-height:100vh;display:grid;place-items:center;padding:32px 18px}.login{width:min(560px,100%);text-align:center}.login h1{margin:0;font-size:clamp(26px,6vw,36px)}.login p{color:#607080;line-height:1.6}.login-form{margin:28px auto 0;width:min(420px,100%)}.code-input{position:fixed;left:-10000px;width:1px;height:1px;opacity:0}.code-display{display:flex;justify-content:center;gap:18px;margin:30px 0}.digit-slot{width:28px;height:42px;border-bottom:2px solid #c7d2dd;font-size:30px;line-height:38px}.digit-slot.active{border-color:#2878a9}.keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}.key{height:60px;border:0;border-radius:10px;background:#fff;font:inherit;font-size:21px;box-shadow:0 2px 7px #17324a12}.key-spacer{visibility:hidden;pointer-events:none;box-shadow:none;background:transparent}.key-delete{font-size:16px}.privacy{font-size:12px}.workbench{width:min(900px,100%)}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}.top h1{margin:0;font-size:clamp(24px,5vw,34px)}.top p{margin:7px 0 0;color:#617181}.badge{padding:7px 12px;border-radius:999px;background:#dce8ef;color:#1e5874;font-size:13px;white-space:nowrap}.badge[data-state=ready]{background:#d9f1e1;color:#17633a}.badge[data-state=failed]{background:#f8dddd;color:#8a2d2d}.panel{background:#fff;border:1px solid #dce5eb;border-radius:10px;padding:20px;box-shadow:0 4px 18px #19384c0d}.panel h2{margin:0 0 8px;font-size:17px}.panel p{margin:0;color:#4b5e6c;line-height:1.6}.meta{margin-top:16px;font-size:12px;color:#82919d}.operation{margin-top:14px;padding:12px 14px;border-left:3px solid #4d9bc0;background:#f5f9fb;color:#2d5267;line-height:1.5}.diff{margin:14px 0 0;max-height:42vh;overflow:auto;padding:14px;background:#16222c;color:#dbe8ee;border-radius:7px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}.panel+.panel{margin-top:16px}.pending{border-left:4px solid #d8a23a}.phrase-hint{margin:12px 0 0;color:#8a6a1f;font-size:13px;line-height:1.6}.phrase{display:inline-block;margin:8px 0 2px;padding:9px 16px;background:#17222c;color:#ffd479;border-radius:8px;font:600 16px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.05em;user-select:all;word-break:break-all}@media(max-width:560px){main{padding:22px 13px}.top{align-items:flex-start}.top h1{font-size:25px}.panel{padding:16px}.code-display{gap:13px}}`;

export interface PairingInfo { pairingUrl: string; workbenchUrl: string; expiresAt: string; }

function scriptHash(script: string): string { return createHash("sha256").update(script).digest("base64"); }
function page(body: string, script = ""): string { return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Cache-Control" content="no-store"><title>MijiaFlow / 米家流</title><style>${STYLE}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`; }
function headers(script = ""): Record<string, string> { return { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0", Pragma: "no-cache", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src ${script ? `'sha256-${scriptHash(script)}'` : "'none'"}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()" }; }
function respond(response: ServerResponse, status: number, html: string, script = ""): void { response.writeHead(status, headers(script)); response.end(html); }
function respondJson(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, max-age=0", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); }
function validSource(request: IncomingMessage, port: number): boolean { return request.headers.host === `127.0.0.1:${port}` && (!request.headers.origin || request.headers.origin === `http://127.0.0.1:${port}` || request.headers.origin === "null"); }

export interface PairingServerOptions {
  ttlMs?: number;
  getState?: () => unknown;
}

export class PairingServer {
  readonly #token = randomBytes(32).toString("base64url");
  readonly #expiresAt: number;
  readonly #authenticate: (passcode: string) => Promise<void>;
  readonly #onFailure: () => void;
  readonly #getState: () => unknown;
  #server: Server | undefined;
  #consumed = false;
  #port: number | undefined;
  #expiryTimer: NodeJS.Timeout | undefined;

  constructor(
    authenticate: (passcode: string) => Promise<void>,
    onFailure: () => void = () => undefined,
    options: PairingServerOptions = {},
  ) {
    this.#authenticate = authenticate;
    this.#onFailure = onFailure;
    this.#getState = options.getState ?? (() => ({}));
    this.#expiresAt = Date.now() + (options.ttlMs ?? PAIRING_TTL_MS);
  }
  async start(): Promise<PairingInfo> {
    this.#server = createServer((request, response) => { void this.#handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.#server!.once("error", reject); this.#server!.listen(0, "127.0.0.1", () => resolve()); });
    const address = this.#server.address(); if (!address || typeof address === "string") throw new MijiaFlowError("Could not allocate a loopback pairing port", "PAIRING_SERVER_FAILED");
    this.#port = address.port; this.#expiryTimer = setTimeout(() => { this.close(); this.#onFailure(); }, Math.max(0, this.#expiresAt - Date.now()));
    const pairingUrl = `http://127.0.0.1:${this.#port}/pair/${this.#token}`;
    return { pairingUrl, workbenchUrl: pairingUrl, expiresAt: new Date(this.#expiresAt).toISOString() };
  }
  close(): void { if (this.#expiryTimer) clearTimeout(this.#expiryTimer); this.#expiryTimer = undefined; this.#server?.close(); this.#server = undefined; }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const base = `/pair/${this.#token}`; const pathname = new URL(request.url || "/", `http://127.0.0.1:${this.#port || 0}`).pathname;
    if (pathname !== base && pathname !== `${base}/state`) { respond(response, 404, page("<section class=login><h1>页面不存在</h1></section>")); return; }
    if (!validSource(request, this.#port!)) { respond(response, 403, page("<section class=login><h1>请求来源无效</h1><p>请仅使用原配对页面。</p></section>")); return; }
    if (pathname === `${base}/state`) { if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }); response.end(); return; } respondJson(response, 200, this.#getState()); return; }
    if (Date.now() >= this.#expiresAt && !this.#consumed) { respond(response, 410, page("<section class=login><h1>配对链接已失效</h1><p>请回到 AI 客户端重新开始会话。</p></section>")); return; }
    if (request.method === "GET") { respond(response, 200, this.#consumed ? this.#workbench() : this.#form(), this.#consumed ? WORKBENCH_SCRIPT : PAIRING_SCRIPT); return; }
    if (request.method !== "POST" || this.#consumed) { response.writeHead(410, { "Cache-Control": "no-store" }); response.end(); return; }
    if (request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") { respond(response, 415, page("<section class=login><h1>请求格式无效</h1></section>")); return; }
    const chunks: Buffer[] = []; let length = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += buffer.length; if (length > MAX_BODY_BYTES) { respond(response, 413, page("<section class=login><h1>请求过大</h1></section>")); return; } chunks.push(buffer); }
    const body = Buffer.concat(chunks); const passcode = new URLSearchParams(body.toString("utf8")).get("passcode"); body.fill(0); if (!passcode || !/^\d{6}$/.test(passcode)) { respond(response, 400, this.#form(), PAIRING_SCRIPT); return; }
    this.#consumed = true; if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    try { await this.#authenticate(passcode); } catch { this.#onFailure(); response.writeHead(303, { Location: base, "Cache-Control": "no-store" }); response.end(); return; }
    response.writeHead(303, { Location: base, "Cache-Control": "no-store" }); response.end();
  }
  #form(): string { return page(`<section class="login"><h1>MijiaFlow / 米家流</h1><p>输入米家自动化极客版 6 位数字登录码</p><form class="login-form" id="pairing-form" method="post" action="/pair/${this.#token}" autocomplete="off"><input class="code-input" id="passcode" name="passcode" type="password" inputmode="numeric" maxlength="6" required><div class="code-display" aria-label="登录码输入进度"><span class="digit-slot" data-slot="0"></span><span class="digit-slot" data-slot="1"></span><span class="digit-slot" data-slot="2"></span><span class="digit-slot" data-slot="3"></span><span class="digit-slot" data-slot="4"></span><span class="digit-slot" data-slot="5"></span></div><div class="keypad"><button class="key" type="button" data-digit="1">1</button><button class="key" type="button" data-digit="2">2</button><button class="key" type="button" data-digit="3">3</button><button class="key" type="button" data-digit="4">4</button><button class="key" type="button" data-digit="5">5</button><button class="key" type="button" data-digit="6">6</button><button class="key" type="button" data-digit="7">7</button><button class="key" type="button" data-digit="8">8</button><button class="key" type="button" data-digit="9">9</button><span class="key key-spacer" aria-hidden="true"></span><button class="key" type="button" data-digit="0">0</button><button class="key key-delete" type="button" data-delete>删除</button></div></form><p class="privacy">登录码仅用于本次本机会话，不会写入日志或仓库</p></section>`, PAIRING_SCRIPT); }
  #workbench(): string { return page(`<section class="workbench" id="workbench" data-state="/pair/${this.#token}/state"><div class="top"><div><h1>MijiaFlow 工作台</h1><p>实时查看会话、读取、计划、备份和变更验证进度</p></div><span class="badge" id="badge">连接中</span></div><div class="panel"><h2>会话</h2><p id="session">正在读取状态...</p><div class="operation" id="operation" hidden></div><pre class="diff" id="diff" hidden></pre><div class="meta">最后更新 <span id="updated">--:--:--</span> · 本页面仅供查看，所有写入仍由 MCP 工具执行</div></div><div class="panel pending" id="pending" hidden><h2>待确认变更</h2><p id="pending-summary"></p><p class="phrase-hint">请核对下方差异；确认无误后，在对话中回复以下一次性短语（AI 不能替你输入）：</p><code class="phrase" id="pending-phrase"></code><div class="meta">计划过期 <span id="pending-expires">--:--:--</span></div><pre class="diff" id="pending-diff" hidden></pre></div></section>`, WORKBENCH_SCRIPT); }
}
