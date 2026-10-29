// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../../../apps/teacher/src/main/store.js";
import { verifyCertificate } from "../../../apps/teacher/src/main/pin.js";
import { certificate } from "../../helpers/certificates.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("C-U 本地持久化与证书边界", () => {
  it("SQLite 重启保留待确认意图与未 ACK 日志，按 origin 隔离", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyez-store-unit-"));
    directories.push(directory);
    const file = join(directory, "library.sqlite");
    const first = new LocalStore(file);
    await first.init();
    const clientId = await first.clientId();
    expect(await first.clientId()).toBe(clientId);
    await first.set("connection", "integration");
    const requestId = randomUUID();
    await first.saveIntent({
      requestId,
      origin: "https://127.0.0.1:8443",
      method: "POST",
      path: "/api/v1/devices",
      body: { requestId, code: "ROOM-1" },
      createdAt: Date.now(),
      state: "pending",
    });
    const logId = randomUUID();
    await first.append({
      logId,
      source: "main",
      level: "warn",
      atMs: Date.now() - 1000,
      appVersion: "0.1.0",
      code: "DISCONNECTED",
    });
    expect((await first.metrics()).pendingCommands).toBe(1);
    await first.close();

    const reopened = new LocalStore(file);
    await reopened.init();
    expect(await reopened.clientId()).toBe(clientId);
    expect(await reopened.get("connection")).toBe("integration");
    expect(await reopened.pending("https://127.0.0.1:8443")).toHaveLength(1);
    expect(await reopened.pending("https://127.0.0.1:9443")).toHaveLength(0);
    expect((await reopened.logBatch()).map((log) => log.logId)).toEqual([
      logId,
    ]);
    await reopened.ack([randomUUID()]);
    expect(await reopened.logBatch()).toHaveLength(1);
    await reopened.ack([logId]);
    expect(await reopened.logBatch()).toHaveLength(0);
    await reopened.close();
    const bytes = await readFile(file);
    expect(bytes.includes(Buffer.from("uidHex"))).toBe(false);
  });

  it("禁止卡号、学生标识、密码和刷卡请求进入提交意图", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyez-store-boundary-"));
    directories.push(directory);
    const store = new LocalStore(join(directory, "library.sqlite"));
    await store.init();
    const base = {
      requestId: randomUUID(),
      origin: "https://127.0.0.1:8443",
      method: "POST",
      path: "/api/v1/devices",
      body: {},
      createdAt: Date.now(),
      state: "pending",
    };
    for (const field of ["card", "uidHex", "studentId", "password", "token"])
      await expect(
        store.saveIntent({ ...base, body: { nested: { [field]: "private" } } }),
      ).rejects.toThrow("PERSISTENCE_BOUNDARY_VIOLATION");
    await expect(
      store.saveIntent({ ...base, path: "/api/v1/scan-previews" }),
    ).rejects.toThrow("PERSISTENCE_BOUNDARY_VIOLATION");
    expect(await store.pending(base.origin)).toHaveLength(0);
    await expect(
      store.write(async () => {
        throw Error("disk failed");
      }),
    ).rejects.toThrow("LOCAL_STORAGE_FAILED");
    expect((await store.metrics()).storage).toBe("failed");
    await store.set("recovered", "yes");
    expect((await store.metrics()).storage).not.toBe("failed");
    await store.close();
  });

  it("pin 同时检查证书指纹、有效期、IP SAN 与目标 IP", () => {
    const valid = certificate();
    const connection = { ip: "127.0.0.1", port: 8443, pin: valid.pin };
    expect(verifyCertificate(valid.cert, connection.ip, connection)).toBe(true);
    expect(verifyCertificate(valid.cert, "127.0.0.2", connection)).toBe(false);
    expect(
      verifyCertificate(valid.cert, connection.ip, {
        ...connection,
        pin: "00".repeat(32),
      }),
    ).toBe(false);
    expect(verifyCertificate(valid.cert, connection.ip, connection, 0)).toBe(
      false,
    );
    expect(
      verifyCertificate(
        certificate("127.0.0.2").cert,
        connection.ip,
        connection,
      ),
    ).toBe(false);
    const wrongSan = certificate("127.0.0.2");
    expect(
      verifyCertificate(wrongSan.cert, connection.ip, {
        ...connection,
        pin: wrongSan.pin,
      }),
    ).toBe(false);
    const expired = certificate("127.0.0.1", true);
    expect(
      verifyCertificate(expired.cert, connection.ip, {
        ...connection,
        pin: expired.pin,
      }),
    ).toBe(false);
  });
});
