import { lookup } from "node:dns/promises";
import type { RequestOptions } from "node:http";
import { isIP } from "node:net";
import { MijiaFlowError } from "../errors.js";

type PinnedLookup = NonNullable<RequestOptions["lookup"]>;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = -1, b = -1] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("::ffff:") && isPrivateIpv4(normalized.slice(7))
  );
}

export function isLanAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPrivateIpv4(address) : family === 6 ? isPrivateIpv6(address) : false;
}

export interface ValidatedTarget {
  url: URL;
  addresses: string[];
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function lookupError(hostname: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException & { hostname?: string };
  error.code = "ENOTFOUND";
  error.hostname = hostname;
  return error;
}

export function createPinnedLookup(target: ValidatedTarget): PinnedLookup {
  const expectedHostname = normalizedHostname(target.url.hostname);
  const entries = target.addresses.map((address) => ({ address, family: isIP(address) }));
  if (entries.length === 0 || entries.some((entry) => entry.family !== 4 && entry.family !== 6)) {
    throw new MijiaFlowError("Validated gateway target has no usable IP address", "INVALID_TARGET");
  }

  return (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== expectedHostname) {
      callback(lookupError(hostname, "Pinned lookup rejected an unexpected hostname"), "", 0);
      return;
    }
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
    const selected = requestedFamily === 0
      ? [...entries]
      : entries.filter((entry) => entry.family === requestedFamily);
    if (selected.length === 0) {
      callback(lookupError(hostname, "Pinned lookup has no address in the requested family"), "", 0);
      return;
    }
    if (options.order === "ipv4first") {
      selected.sort((left, right) => left.family - right.family);
    } else if (options.order === "ipv6first") {
      selected.sort((left, right) => right.family - left.family);
    }
    if (options.all) {
      callback(null, selected);
      return;
    }
    const first = selected[0]!;
    callback(null, first.address, first.family);
  };
}

export async function validateLanTarget(baseUrl: string): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new MijiaFlowError("baseUrl is not a valid URL", "INVALID_TARGET");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MijiaFlowError("baseUrl must use HTTP or HTTPS", "INVALID_TARGET");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MijiaFlowError("baseUrl cannot contain credentials, a query, or a fragment", "INVALID_TARGET");
  }
  const hostname = normalizedHostname(url.hostname);
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      throw new MijiaFlowError("Gateway hostname could not be resolved", "TARGET_UNREACHABLE");
    }
  }
  if (addresses.length === 0 || addresses.some((address) => !isLanAddress(address))) {
    throw new MijiaFlowError("Gateway target must resolve only to private or link-local addresses", "TARGET_NOT_LAN");
  }
  url.pathname = url.pathname.replace(/[^/]*$/, "");
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return { url, addresses: [...new Set(addresses)].sort() };
}

export async function revalidateTarget(target: ValidatedTarget): Promise<void> {
  const latest = await validateLanTarget(target.url.toString());
  if (latest.addresses.join(",") !== target.addresses.join(",")) {
    throw new MijiaFlowError("Gateway DNS resolution changed during the session", "DNS_REBINDING_DETECTED");
  }
}
