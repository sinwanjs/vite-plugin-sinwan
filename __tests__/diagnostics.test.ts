import { describe, expect, it, spyOn } from "bun:test";
import type { SinwanDiagnostic } from "sinwan-compiler";
import { sinwan } from "../src/index";

const SOURCE = `import { cc } from "sinwan";
import { Gate } from "./gate";
export const App = cc(() => <Gate content={() => 1} />);
`;

interface Warning {
  message: string;
  id: string;
  loc: { file: string; line: number; column: number };
}

describe("compiler diagnostics in the vite plugin", () => {
  it("reports through this.warn with a 0-based column", () => {
    const warnings: Warning[] = [];
    const plugin = sinwan({ cache: false, dev: true, fastRefresh: false });
    plugin.transform.call(
      { warn: (warning: Warning) => warnings.push(warning) },
      SOURCE,
      "/app/src/App.tsx",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toStartWith("SW101: <Gate content=");
    expect(warnings[0]!.message).toContain("give it a parameter");
    expect(warnings[0]!.id).toBe("/app/src/App.tsx");
    expect(warnings[0]!.loc).toEqual({
      file: "/app/src/App.tsx",
      line: 3,
      column: 43,
    });
  });

  it("prints when there is no plugin context", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plugin = sinwan({ cache: false, dev: true, fastRefresh: false });
      plugin.transform.call(undefined, SOURCE, "/app/src/App.tsx");
      expect(String(warn.mock.calls[0]?.[0])).toStartWith(
        "[Sinwan] /app/src/App.tsx:3:44 SW101:",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("hands diagnostics to onDiagnostic and skips node_modules", () => {
    const found: SinwanDiagnostic[] = [];
    const plugin = sinwan({
      cache: false,
      dev: true,
      fastRefresh: false,
      onDiagnostic: (diagnostic) => found.push(diagnostic),
    });
    plugin.transform(SOURCE, "/app/src/App.tsx");
    plugin.transform(SOURCE, "/app/node_modules/lib/App.tsx");
    expect(found).toMatchObject([{ code: "SW101", line: 3, column: 44 }]);
  });

  it("stays quiet in production", () => {
    const found: SinwanDiagnostic[] = [];
    const plugin = sinwan({
      cache: false,
      dev: false,
      onDiagnostic: (diagnostic) => found.push(diagnostic),
    });
    plugin.transform(SOURCE, "/app/src/App.tsx");
    expect(found).toEqual([]);
  });
});
