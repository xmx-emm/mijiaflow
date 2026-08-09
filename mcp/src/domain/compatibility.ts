import { Agent, fetch, type Headers } from "undici";
import { MijiaFlowError } from "../errors.js";
import {
  createPinnedLookup,
  revalidateTarget,
  validateLanTarget,
  type ValidatedTarget,
} from "../security/lan-target.js";

export const SUPPORTED_FRONTEND_VERSION = "v1.6.1";
export const SUPPORTED_PROTOCOL_VERSION = "2.0.0";

export type CompatibilityMode = "read-write" | "read-only";

export interface ProbeResult {
  baseUrl: string;
  websocketUrl: string;
  frontendVersion: string | null;
  protocolVersion: string | null;
  buildTag: string | null;
  mode: CompatibilityMode;
  capabilities: string[];
  writeDisabledReasons: string[];
}

export interface ProbeWithTarget {
  probe: ProbeResult;
  target: ValidatedTarget;
}

function websocketUrl(url: URL): string {
  const result = new URL("centrallinkws/", url);
  result.protocol = result.protocol === "https:" ? "wss:" : "ws:";
  return result.toString();
}

interface TextResponse {
  body: string;
  headers: Headers;
  ok: boolean;
  status: number;
}

async function fetchPinnedText(
  target: ValidatedTarget,
  url: URL,
  redirect: "error" | "manual",
): Promise<TextResponse> {
  const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(target) } });
  try {
    const response = await fetch(url, {
      dispatcher,
      redirect,
      signal: AbortSignal.timeout(8_000),
    });
    return {
      body: await response.text(),
      headers: response.headers,
      ok: response.ok,
      status: response.status,
    };
  } finally {
    await dispatcher.close();
  }
}

async function detectFrontendVersion(html: string, target: ValidatedTarget): Promise<string | null> {
  const direct = html.match(/\bv\d+\.\d+\.\d+\b/);
  if (direct) {
    return direct[0];
  }
  const scriptPath = html.match(/(?:src=["'])([^"']*ai-config-v5[^"']*\.js)/)?.[1];
  if (!scriptPath) {
    return null;
  }
  const scriptUrl = new URL(scriptPath.startsWith("//") ? `https:${scriptPath}` : scriptPath, target.url);
  const sameGateway = scriptUrl.origin === target.url.origin;
  const allowedRemote = sameGateway || scriptUrl.hostname.endsWith(".mi-img.com");
  if (!allowedRemote || (!sameGateway && scriptUrl.protocol !== "https:")) {
    return null;
  }
  try {
    const response = sameGateway
      ? await fetchPinnedText(target, scriptUrl, "error")
      : await (async (): Promise<TextResponse> => {
          const remote = await fetch(scriptUrl, { redirect: "error", signal: AbortSignal.timeout(8_000) });
          return {
            body: await remote.text(),
            headers: remote.headers,
            ok: remote.ok,
            status: remote.status,
          };
        })();
    if (!response.ok) {
      return null;
    }
    return response.body.match(/["']KZ["']\s*:\s*["'](v\d+\.\d+\.\d+)["']/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function probeGateway(baseUrl: string): Promise<ProbeWithTarget> {
  const target = await validateLanTarget(baseUrl);
  let response: TextResponse;
  try {
    response = await fetchPinnedText(target, target.url, "manual");
  } catch {
    throw new MijiaFlowError("Gateway page could not be reached", "TARGET_UNREACHABLE");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new MijiaFlowError("Gateway redirects are not accepted", "TARGET_REDIRECTED");
  }
  if (!response.ok) {
    throw new MijiaFlowError(`Gateway probe returned HTTP ${response.status}`, "TARGET_UNREACHABLE");
  }
  const html = response.body;
  await revalidateTarget(target);
  const protocolVersion = response.headers.get("x-mijia-geek-version");
  const frontendVersion = await detectFrontendVersion(html, target);
  const buildTag = html.match(/<html[^>]*data-tag=["']([^"']+)["']/i)?.[1] ?? null;
  const reasons: string[] = [];
  if (frontendVersion !== SUPPORTED_FRONTEND_VERSION) {
    reasons.push(`frontend ${frontendVersion ?? "unknown"} is not ${SUPPORTED_FRONTEND_VERSION}`);
  }
  if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    reasons.push(`protocol ${protocolVersion ?? "unknown"} is not ${SUPPORTED_PROTOCOL_VERSION}`);
  }
  const mode: CompatibilityMode = reasons.length === 0 ? "read-write" : "read-only";
  return {
    target,
    probe: {
      baseUrl: target.url.toString(),
      websocketUrl: websocketUrl(target.url),
      frontendVersion,
      protocolVersion,
      buildTag,
      mode,
      capabilities:
        mode === "read-write"
          ? ["read", "local-backup", "cloud-backup", "transactional-write", "rollback"]
          : ["read", "local-backup"],
      writeDisabledReasons: reasons,
    },
  };
}
