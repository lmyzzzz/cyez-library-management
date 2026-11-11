// Deterministic campus provider used ONLY by the full-chain integration stack.
//
// Mounted read-only into the API container by tests/full-chain/compose.full-chain.yaml.
// The production adapter belongs in runtime/adapters/ and is never this file.
//
// Behaviour is keyed by card UID so tests never need a control endpoint:
//   ffffffff  explicit rejection (STUDENT_NOT_ALLOWED, HTTP 403)
//   eeeeeeee  upstream outage (generic error -> PROVIDER_UNAVAILABLE, HTTP 503)
//   f0f0f0f0  first lookup succeeds, later lookups fail (cached profile must not
//             be used as a fallback for a new scan)
//   anything  success; the school-number counter increases on every lookup so a
//             repeated card scan visibly refreshes the cached profile.
//
// It only ever receives the transient card object; it never logs it.

async function loadApiError() {
  const candidates = [
    "/app/packages/protocol/dist/index.js",
    process.env.FULL_CHAIN_PROTOCOL_MODULE,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const module = await import(candidate);
      if (typeof module.ApiError === "function") return module.ApiError;
    } catch {
      // Try the next candidate; a missing module is reported as a bootstrap failure.
    }
  }
  throw new Error("FULL_CHAIN_PROVIDER_BOOTSTRAP_FAILED");
}

const ApiError = await loadApiError();
const lookups = new Map();

export async function createProvider() {
  return {
    async lookup(card, signal) {
      signal?.throwIfAborted();
      // The server forwards the card losslessly: exactly four lowercase hex bytes.
      if (!/^[0-9a-f]{8}$/.test(card.uidHex))
        throw new ApiError("STUDENT_NOT_ALLOWED", 403);
      if (card.uidHex === "ffffffff")
        throw new ApiError("STUDENT_NOT_ALLOWED", 403);
      if (card.uidHex === "eeeeeeee")
        throw new Error("FULL_CHAIN_PROVIDER_UNAVAILABLE");
      const count = (lookups.get(card.uidHex) ?? 0) + 1;
      if (card.uidHex === "f0f0f0f0" && count > 1)
        throw new Error("FULL_CHAIN_PROVIDER_REFRESH_UNAVAILABLE");
      lookups.set(card.uidHex, count);
      return {
        name: `集成学生${count}`,
        className: "集成测试班级",
        schoolNumber: `FC-${count}`,
      };
    },
  };
}
