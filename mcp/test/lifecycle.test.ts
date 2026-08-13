import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MijiaFlowError } from "../src/errors.js";
import { PairingServer } from "../src/session/pairing-server.js";
import { AsyncMutex } from "../src/util/async-mutex.js";

describe("session lifecycle primitives", () => {
  it("serializes lifecycle work and releases the lock after failure", async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.runExclusive(async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      throw new Error("expected");
    });
    const second = mutex.runExclusive(() => {
      events.push("second");
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("expected");
    await second;
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("notifies the owner when an unused pairing page expires", async () => {
    let failures = 0;
    const pairing = new PairingServer(async () => undefined, () => {
      failures += 1;
    }, { ttlMs: 20 });
    await pairing.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(failures).toBe(1);
    pairing.close();
  });

  it("accepts a same-origin browser form without Origin and rejects cross-site posts", async () => {
    let received = "";
    const pairing = new PairingServer(async (passcode) => {
      received = passcode;
    });
    const { pairingUrl } = await pairing.start();

    const initial = await fetch(pairingUrl);
    const initialBody = await initial.text();
    expect(initialBody).toContain("MijiaFlow / 米家流");
    expect(initialBody).toContain("输入米家自动化极客版 6 位数字登录码");
    expect(initialBody.match(/data-digit=/g)).toHaveLength(10);
    const inlineScript = initialBody.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(inlineScript).toBeDefined();
    const scriptHash = createHash("sha256").update(inlineScript!).digest("base64");
    expect(initial.headers.get("content-security-policy")).toContain(`script-src 'sha256-${scriptHash}'`);

    const rejected = await fetch(pairingUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://example.invalid",
      },
      body: "passcode=111111",
    });
    expect(rejected.status).toBe(403);
    expect(received).toBe("");

    const invalid = await fetch(pairingUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "passcode=abc123",
    });
    expect(invalid.status).toBe(400);
    expect(received).toBe("");

    const accepted = await fetch(pairingUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
      body: "passcode=123456",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.redirected).toBe(true);
    expect(await accepted.text()).toContain("MijiaFlow 工作台");
    expect(received).toBe("123456");

    const repeated = await fetch(pairingUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "passcode=123456",
    });
    expect(repeated.status).toBe(410);
    pairing.close();
  });

  it("lets an accepted submission finish when the unused-page TTL elapses", async () => {
    let failures = 0;
    const pairing = new PairingServer(
      async () => new Promise((resolve) => setTimeout(resolve, 600)),
      () => { failures += 1; },
      { ttlMs: 500 },
    );
    const { pairingUrl } = await pairing.start();
    const response = await fetch(pairingUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "passcode=123456",
    });
    expect(response.status).toBe(200);
    expect(failures).toBe(0);
    pairing.close();
  });

  it("redirects a rejected submission to the workbench without exposing authentication data", async () => {
    let failed = false;
    const pairing = new PairingServer(
      async () => {
        throw new MijiaFlowError("sensitive internal detail", "GATEWAY_REJECTED");
      },
      () => { failed = true; },
      { getState: () => ({ session: { state: failed ? "failed" : "awaiting-passcode" } }) },
    );
    const { pairingUrl } = await pairing.start();
    const response = await fetch(pairingUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "passcode=654321",
    });
    const body = await response.text();

    expect(failed).toBe(true);
    expect(response.status).toBe(200);
    expect(response.redirected).toBe(true);
    expect(body).toContain("MijiaFlow 工作台");
    expect(body).toContain('id="pending"');
    expect(body).toContain('id="pending-phrase"');
    expect(body).not.toContain("sensitive internal detail");
    expect(body).not.toContain("654321");

    const state = await fetch(`${pairingUrl}/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ session: { state: "failed" } });

    const crossSiteState = await fetch(`${pairingUrl}/state`, {
      headers: { origin: "https://example.invalid" },
    });
    expect(crossSiteState.status).toBe(403);
    pairing.close();
  });
});
