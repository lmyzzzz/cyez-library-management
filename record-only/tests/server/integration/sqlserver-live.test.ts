import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import sql from "mssql";
import { sqlServerProviderSchema } from "@record/protocol";
import { SqlServerCampusProvider } from "../../../apps/server/src/provider-sqlserver.js";

describe.skipIf(!process.env.TEST_SQLSERVER_CONFIG)(
  "真实 SQL Server / TLS / 三列权限",
  () => {
    it("从仅授权三列的账号读取中文资料，拒绝重复、空姓名和错误 TLS", async () => {
      const config = sqlServerProviderSchema.parse(
        JSON.parse(await readFile(process.env.TEST_SQLSERVER_CONFIG!, "utf8")),
      );
      const provider = new SqlServerCampusProvider(config, 3000);
      const signal = new AbortController().signal;
      await provider.probe();
      const scan = (uidHex: string) =>
        provider.lookup({ issuer: "integration", uidHex }, signal);
      await expect(scan("00000001")).resolves.toEqual({
        name: "测试学生",
        className: "Ⅰ（1班）",
        schoolNumber: "",
      });
      await expect(scan("00000002")).rejects.toMatchObject({
        code: "PROFILE_MISMATCH",
      });
      await expect(scan("00000003")).rejects.toMatchObject({
        code: "PROFILE_MISMATCH",
      });
      await expect(scan("ffffffff")).rejects.toMatchObject({
        code: "STUDENT_NOT_ALLOWED",
      });
      await expect(
        new SqlServerCampusProvider(
          { ...config, uidEncoding: "hex8" },
          3000,
        ).lookup({ issuer: "integration", uidHex: "00000004" }, signal),
      ).resolves.toMatchObject({ name: "十六进制" });
      await expect(
        new SqlServerCampusProvider({ ...config, caPem: "" }, 3000).probe(),
      ).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_INVALID" });
      const pool = await new sql.ConnectionPool({
        server: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: "Concard",
        options: {
          encrypt: true,
          trustServerCertificate: false,
          cryptoCredentialsDetails: { ca: config.caPem },
        },
      }).connect();
      try {
        // Test fixture only: verify the adapter succeeded without permissions on forbidden columns.
        await expect(
          pool
            .request()
            .query(
              "SELECT TOP (0) [账号], [证件号], [身份证号] FROM dbo.v_ViewCardInfo",
            ),
        ).rejects.toMatchObject({ code: "EREQUEST" });
      } finally {
        await pool.close();
      }
    });
  },
);
