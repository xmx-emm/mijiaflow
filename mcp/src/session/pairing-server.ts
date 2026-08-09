import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MijiaFlowError } from "../errors.js";

const MAX_BODY_BYTES = 1_024;
const DEFAULT_RESULT_TTL_MS = 60_000;
const PAIRING_FORM_SCRIPT = `(() => {
  const form = document.getElementById("pairing-form");
  const input = document.getElementById("passcode");
  const slots = Array.from(document.querySelectorAll("[data-slot]"));
  const keys = Array.from(document.querySelectorAll("[data-digit]"));
  const deleteKey = document.querySelector("[data-delete]");
  let value = "";
  let submitting = false;

  const render = () => {
    slots.forEach((slot, index) => {
      slot.textContent = value[index] || "";
      slot.classList.toggle("active", !submitting && index === value.length);
      slot.classList.toggle("filled", index < value.length);
    });
    input.value = value;
  };

  const disableKeys = () => {
    [...keys, deleteKey].forEach((key) => { if (key) key.disabled = true; });
  };

  const submitWhenComplete = () => {
    if (value.length !== 6 || submitting) return;
    submitting = true;
    render();
    disableKeys();
    window.setTimeout(() => form.requestSubmit(), 120);
  };

  const append = (digit) => {
    if (submitting || value.length >= 6) return;
    value += digit;
    render();
    submitWhenComplete();
  };

  const remove = () => {
    if (submitting || value.length === 0) return;
    value = value.slice(0, -1);
    render();
  };

  keys.forEach((key) => key.addEventListener("click", () => append(key.dataset.digit)));
  deleteKey.addEventListener("click", remove);
  document.addEventListener("keydown", (event) => {
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      append(event.key);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      remove();
    } else if (event.key === "Enter" && event.target?.tagName !== "BUTTON") {
      event.preventDefault();
      submitWhenComplete();
    }
  });
  document.addEventListener("paste", (event) => {
    const pasted = event.clipboardData?.getData("text").trim() || "";
    if (!/^\d{6}$/.test(pasted) || submitting) return;
    event.preventDefault();
    value = pasted;
    render();
    submitWhenComplete();
  });
  form.addEventListener("submit", (event) => {
    if (value.length !== 6) {
      event.preventDefault();
      return;
    }
    submitting = true;
    render();
    disableKeys();
  });
  render();
})();`;
const PAIRING_FORM_SCRIPT_HASH = createHash("sha256").update(PAIRING_FORM_SCRIPT).digest("base64");

function page(body: string, script = ""): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-store">
  <title>MijiaFlow / 米家流</title>
  <style>
    :root {
      color-scheme: light;
      font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      background: #f2f4fb;
      color: #151515;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 280px; min-height: 100vh; min-height: 100svh; background: #f2f4fb; }
    main {
      width: 100%;
      min-height: 100vh;
      min-height: 100svh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      text-align: center;
    }
    main > h1 { margin: 0 0 14px; font-size: 30px; line-height: 1.25; letter-spacing: 0; }
    main > p { max-width: 520px; margin: 0; color: #5f6675; font-size: 16px; line-height: 1.7; }
    .login-shell { width: 100%; }
    .login-shell h1 { margin: 0; font-size: 32px; line-height: 1.25; font-weight: 700; letter-spacing: 0; }
    .subtitle { margin: 18px 0 0; color: #5d6574; font-size: 17px; line-height: 1.5; }
    .login-form { width: min(76vw, 752px); margin: 0 auto; }
    .code-input {
      position: fixed;
      left: -10000px;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    .code-display {
      min-height: 48px;
      margin: 36px 0 36px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 24px;
    }
    .digit-slot {
      position: relative;
      width: 30px;
      height: 44px;
      color: #22252b;
      font-size: 30px;
      font-variant-numeric: tabular-nums;
      line-height: 38px;
    }
    .digit-slot.active::after {
      content: "";
      position: absolute;
      left: 4px;
      right: 4px;
      bottom: 0;
      height: 2px;
      border-radius: 1px;
      background: #9fc9e9;
    }
    .keypad { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .key {
      min-width: 0;
      height: 68px;
      border: 0;
      border-radius: 11px;
      background: #ffffff;
      color: #24262b;
      font: inherit;
      font-size: 22px;
      font-weight: 400;
      letter-spacing: 0;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(39, 45, 64, 0.04);
      transition: background-color 120ms ease, transform 120ms ease;
    }
    .key:hover { background: #fafbff; }
    .key:active { background: #e8edf7; transform: scale(0.985); }
    .key:focus-visible { outline: 3px solid rgba(80, 154, 214, 0.32); outline-offset: 2px; }
    .key:disabled { cursor: default; opacity: 0.62; transform: none; }
    .key-zero { grid-column: 2; }
    .key-delete { grid-column: 3; background: transparent; box-shadow: none; }
    .key-delete:hover { background: rgba(255, 255, 255, 0.42); }
    .privacy-note { margin: 46px auto 0; color: #626a79; font-size: 13px; line-height: 1.65; }
    .privacy-note span { display: block; }
    @media (max-width: 640px) {
      main { padding: 34px 16px; }
      .login-shell h1 { font-size: 27px; }
      .subtitle { margin-top: 14px; font-size: 15px; }
      .login-form { width: 100%; }
      .code-display { margin: 30px 0; gap: 16px; }
      .digit-slot { width: 26px; height: 40px; font-size: 27px; line-height: 34px; }
      .keypad { gap: 10px; }
      .key { height: 58px; border-radius: 9px; font-size: 20px; }
      .privacy-note { margin-top: 34px; font-size: 12px; }
    }
    @media (prefers-reduced-motion: reduce) { .key { transition: none; } }
  </style>
</head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body>
</html>`;
}

function form(action: string): string {
  return page(`<section class="login-shell" aria-labelledby="login-title">
  <h1 id="login-title">MijiaFlow / 米家流</h1>
  <p class="subtitle" id="login-help">输入米家自动化极客版 6 位数字登录码</p>
  <form class="login-form" id="pairing-form" method="post" action="${action}" autocomplete="off">
    <input class="code-input" id="passcode" name="passcode" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" aria-label="6 位数字登录码" aria-describedby="login-help" tabindex="-1" required>
    <div class="code-display" role="status" aria-label="登录码输入进度">
      <span class="digit-slot" data-slot="0"></span>
      <span class="digit-slot" data-slot="1"></span>
      <span class="digit-slot" data-slot="2"></span>
      <span class="digit-slot" data-slot="3"></span>
      <span class="digit-slot" data-slot="4"></span>
      <span class="digit-slot" data-slot="5"></span>
    </div>
    <div class="keypad" role="group" aria-label="数字键盘">
      <button class="key" type="button" data-digit="1">1</button>
      <button class="key" type="button" data-digit="2">2</button>
      <button class="key" type="button" data-digit="3">3</button>
      <button class="key" type="button" data-digit="4">4</button>
      <button class="key" type="button" data-digit="5">5</button>
      <button class="key" type="button" data-digit="6">6</button>
      <button class="key" type="button" data-digit="7">7</button>
      <button class="key" type="button" data-digit="8">8</button>
      <button class="key" type="button" data-digit="9">9</button>
      <button class="key key-zero" type="button" data-digit="0">0</button>
      <button class="key key-delete" type="button" data-delete>删除</button>
    </div>
  </form>
  <p class="privacy-note"><span>登录码仅用于本次本机会话，不会写入日志或仓库</span><span>提交后如需重试，请在 Codex 中重新开始会话</span></p>
</section>`, PAIRING_FORM_SCRIPT);
}

function respond(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${PAIRING_FORM_SCRIPT_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  response.end(html);
}

function hasValidPostSource(request: IncomingMessage, port: number): boolean {
  const expectedHost = `127.0.0.1:${port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const origin = request.headers.origin;
  if (origin === expectedOrigin) return true;
  if (origin !== undefined && origin !== "null") return false;

  // Sandboxed WebViews can use an opaque origin. The exact loopback Host plus
  // the unguessable, single-use URL token still binds the submission locally.
  return request.headers.host === expectedHost;
}

function authenticationFailurePage(error: unknown): string {
  const code = error instanceof MijiaFlowError ? error.code : "";
  if (code === "GATEWAY_REJECTED") {
    return page("<h1>网关拒绝了登录码</h1><p>请重新获取并确认米家中枢极客版登录码。</p>");
  }
  if (code === "HANDSHAKE_TIMEOUT") {
    return page("<h1>认证超时</h1><p>请确认网关在线后在 Codex 中重新开始会话。</p>");
  }
  if ([
    "AUTHENTICATION_FAILED",
    "INVALID_FRAME",
    "INVALID_HANDSHAKE",
    "INVALID_PAKE_POINT",
    "INVALID_PAKE_PROOF",
    "PAKE_FAILED",
  ].includes(code)) {
    return page("<h1>协议校验失败</h1><p>请返回 Codex 查看兼容性诊断。</p>");
  }
  if (code === "CONNECTION_FAILED" || code === "SESSION_CLOSED") {
    return page("<h1>网关连接已中断</h1><p>请检查局域网连接后在 Codex 中重新开始会话。</p>");
  }
  return page("<h1>连接失败</h1><p>请在 Codex 中重新开始会话并检查登录码。</p>");
}

export interface PairingInfo {
  pairingUrl: string;
  expiresAt: string;
}

export class PairingServer {
  readonly #token = randomBytes(32).toString("base64url");
  readonly #expiresAt: number;
  readonly #authenticate: (passcode: string) => Promise<void>;
  readonly #onFailure: () => void;
  readonly #resultTtlMs: number;
  #server: Server | undefined;
  #consumed = false;
  #port: number | undefined;
  #expiryTimer: NodeJS.Timeout | undefined;
  #resultTimer: NodeJS.Timeout | undefined;
  #result: { status: number; html: string } | undefined;
  #failureNotified = false;

  constructor(
    authenticate: (passcode: string) => Promise<void>,
    onFailure: () => void = () => undefined,
    ttlMs = 15 * 60_000,
    resultTtlMs = DEFAULT_RESULT_TTL_MS,
  ) {
    this.#authenticate = authenticate;
    this.#onFailure = onFailure;
    this.#expiresAt = Date.now() + ttlMs;
    this.#resultTtlMs = resultTtlMs;
  }

  async start(): Promise<PairingInfo> {
    if (this.#server) {
      throw new MijiaFlowError("Pairing server is already running", "INVALID_SESSION_STATE");
    }
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      this.close();
      throw new MijiaFlowError("Could not allocate a loopback pairing port", "PAIRING_SERVER_FAILED");
    }
    this.#port = address.port;
    this.#expiryTimer = setTimeout(() => {
      this.close();
      this.#notifyFailure();
    }, Math.max(0, this.#expiresAt - Date.now()));
    const pairingUrl = `http://127.0.0.1:${this.#port}/pair/${this.#token}`;
    return { pairingUrl, expiresAt: new Date(this.#expiresAt).toISOString() };
  }

  close(): void {
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    if (this.#resultTimer) {
      clearTimeout(this.#resultTimer);
      this.#resultTimer = undefined;
    }
    this.#server?.close();
    this.#server = undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = `/pair/${this.#token}`;
    if (Date.now() >= this.#expiresAt || request.url !== pathname) {
      respond(response, 410, page("<h1>配对链接已失效</h1><p>请在 Codex 中重新开始会话。</p>"));
      return;
    }
    if (this.#consumed) {
      if (request.method === "GET" && this.#result) {
        respond(response, this.#result.status, this.#result.html);
        return;
      }
      respond(response, 410, page("<h1>配对链接已失效</h1><p>请在 Codex 中重新开始会话。</p>"));
      return;
    }
    if (request.method === "GET") {
      respond(response, 200, form(pathname));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "GET, POST", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (!hasValidPostSource(request, this.#port!)) {
      respond(response, 403, page("<h1>请求来源无效</h1><p>请仅使用原配对页面提交登录码。</p>"));
      return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0];
    if (contentType !== "application/x-www-form-urlencoded") {
      respond(response, 415, page("<h1>请求格式无效</h1>"));
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_BODY_BYTES) {
        respond(response, 413, page("<h1>请求过大</h1>"));
        return;
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    const passcode = new URLSearchParams(body.toString("utf8")).get("passcode");
    body.fill(0);
    if (!passcode || !/^\d{6}$/.test(passcode)) {
      respond(response, 400, form(pathname));
      return;
    }
    this.#consumed = true;
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    this.#result = {
      status: 202,
      html: page("<h1>正在连接</h1><p>请保持此页面打开，MijiaFlow 正在与网关建立安全会话。</p>"),
    };
    try {
      await this.#authenticate(passcode);
      this.#result = {
        status: 200,
        html: page("<h1>连接已建立</h1><p>可以关闭此页面并返回 Codex。</p>"),
      };
      respond(response, this.#result.status, this.#result.html);
      this.#retainResult();
    } catch (error) {
      this.#result = { status: 401, html: authenticationFailurePage(error) };
      respond(response, this.#result.status, this.#result.html);
      this.#retainResult(() => this.#notifyFailure());
    }
  }

  #retainResult(afterClose?: () => void): void {
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    this.#resultTimer = setTimeout(() => {
      this.#resultTimer = undefined;
      this.close();
      afterClose?.();
    }, this.#resultTtlMs);
  }

  #notifyFailure(): void {
    if (this.#failureNotified) return;
    this.#failureNotified = true;
    this.#onFailure();
  }
}
