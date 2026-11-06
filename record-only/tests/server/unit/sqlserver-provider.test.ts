import { describe, expect, it } from "vitest";
import { sqlServerProviderSchema } from "@record/protocol";
import {
  lookupQuery,
  uidForSqlServer,
} from "../../../apps/server/src/provider-sqlserver.js";

const config = {
  host: "school.example",
  port: 1433,
  username: "reader",
  password: "example-only",
  caPem: "",
  uidEncoding: "hex8" as const,
};

describe("SQL Server 固定视图查询", () => {
  it("只从固定视图按参数化 UID 查询最多两行", () => {
    expect(lookupQuery(2)).toBe(
      "SELECT TOP (2) [卡号] AS [card], [姓名] AS [name], [班级] AS [className] FROM [Concard].[dbo].[v_ViewCardInfo] WHERE [卡号] = @uid",
    );
    expect(lookupQuery(0)).toContain("SELECT TOP (0)");
    expect(lookupQuery(2)).not.toMatch(/账号|身份|证件|状态|学号|SELECT\s+\*/);
  });
  it("UID 保留 4 字节十六进制或转换为无符号十进制", () => {
    expect(uidForSqlServer("00000001", "hex8")).toBe("00000001");
    expect(uidForSqlServer("00000001", "decimal")).toBe("1");
    expect(uidForSqlServer("ffffffff", "decimal")).toBe("4294967295");
    expect(() => uidForSqlServer("1", "decimal")).toThrow();
  });
  it("不接受任何字段映射或其他未知设置", () => {
    expect(sqlServerProviderSchema.safeParse(config).success).toBe(true);
    expect(
      sqlServerProviderSchema.safeParse({
        ...config,
        tlsValidation: "trustServerCertificate",
      }).success,
    ).toBe(true);
    expect(
      sqlServerProviderSchema.safeParse({
        ...config,
        tlsValidation: "trustServerCertificate",
        caPem: "-----BEGIN CERTIFICATE-----\nunused\n-----END CERTIFICATE-----",
      }).success,
    ).toBe(false);
    expect(
      sqlServerProviderSchema.safeParse({
        ...config,
        tlsValidation: "disabled",
      }).success,
    ).toBe(false);
    expect(
      sqlServerProviderSchema.safeParse({
        ...config,
        cardColumn: "卡号]; DROP TABLE students;--",
      }).success,
    ).toBe(false);
    expect(
      sqlServerProviderSchema.safeParse({
        ...config,
        nameColumn: "卡号",
      }).success,
    ).toBe(false);
    expect(
      sqlServerProviderSchema.safeParse({
        ...config,
        endpoint: "https://elsewhere.invalid",
      }).success,
    ).toBe(false);
  });
});
