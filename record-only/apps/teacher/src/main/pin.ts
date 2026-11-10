import { X509Certificate, createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizePin, ApiError } from "@record/protocol";
import type { Connection } from "../shared/bridge.js";
export function connectionOrigin(config: Connection) {
  if (!isIP(config.ip)) throw new ApiError("IP_INVALID");
  normalizePin(config.pin);
  return new URL(
    `https://${config.ip.includes(":") ? "[" + config.ip + "]" : config.ip}:${config.port}`,
  ).origin;
}
export function verifyCertificate(
  pem: string,
  hostname: string,
  config: Connection,
  now = Date.now(),
): boolean {
  try {
    const certificate = new X509Certificate(pem);
    // Electron reports IPv6 URL hostnames with brackets ("[::1]"); the pinned
    // connection stores the bare address ("::1").
    const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
    return (
      host === config.ip &&
      createHash("sha256").update(certificate.raw).digest("hex") ===
        normalizePin(config.pin) &&
      now >= Date.parse(certificate.validFrom) &&
      now <= Date.parse(certificate.validTo) &&
      certificate.checkIP(config.ip) !== undefined
    );
  } catch {
    return false;
  }
}
