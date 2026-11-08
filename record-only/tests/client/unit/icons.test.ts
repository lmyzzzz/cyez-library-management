import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "apps/teacher/src/renderer");
const files = readdirSync(dir).filter((file) => /\.(ts|tsx)$/.test(file));
/** Unicode emoji or glyphs that must not stand in for an icon. */
const unicodeIcon =
  /[\p{Extended_Pictographic}\u2713\u2714\u2717\u2718\u2715\u00d7\u2192\u2190\u2191\u2193]/u;

describe("图标规范", () => {
  it("渲染层不使用 Unicode emoji 或字符充当图标", () => {
    const offenders = files.filter((file) =>
      unicodeIcon.test(readFileSync(join(dir, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("图标库固定为 lucide-react", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "apps/teacher/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    expect(manifest.devDependencies?.["lucide-react"]).toBe("1.64.0");
  });
});
