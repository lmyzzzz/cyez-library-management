import type { Config } from "../../apps/server/src/config.js";
export const identity = {
  hashVersion: "v1",
  fixedSaltHex: "00112233445566778899aabbccddeeff",
  issuer: "integration",
  uidByteLengths: [4],
};
export function testConfig(databaseUrl: string, spoolDir: string): Config {
  return {
    environment: "integration",
    host: "127.0.0.1",
    port: 3000,
    databaseUrl,
    username: "teacher-test",
    password: "integration-password-only",
    identity,
    providerMode: "fake",
    profileContractConfirmed: false,
    providerTimeoutMs: 200,
    previewTtlMs: 120000,
    previewLimit: 10000,
    batchLimit: 2,
    sessionTtlMs: 3600000,
    spoolDir,
    capacity: {
      warningBytes: 1024,
      reserveBytes: 512,
      recoveryBytes: 2048,
      oldestWarnMs: 60000,
    },
  };
}
