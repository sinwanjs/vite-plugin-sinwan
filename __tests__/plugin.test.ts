import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { sinwan } from "../src/index";

describe("sinwan vite plugin", () => {
  it("can be created with cache enabled", () => {
    const plugin = sinwan({ cache: true });
    expect(plugin.name).toBe("sinwan");
    expect(typeof plugin.configResolved).toBe("function");
    expect(typeof plugin.config).toBe("function");
    expect(typeof plugin.transform).toBe("function");
    expect(plugin.config()).toEqual({ resolve: { dedupe: ["sinwan"] } });
  });

  it("can be created with a custom cache root", () => {
    const plugin = sinwan({
      cache: { root: "/project", tsConfigPath: "/project/tsconfig.json" },
    });
    expect(plugin.name).toBe("sinwan");
  });

  it("enables explicit bindings and the incremental analyzer by default", () => {
    const plugin = sinwan();
    expect(plugin.name).toBe("sinwan");
    expect(typeof plugin.configResolved).toBe("function");
    expect(typeof plugin.transform).toBe("function");
  });

  it("allows disabling the cache and explicit bindings", () => {
    const plugin = sinwan({ cache: false, explicitBindings: false });
    expect(plugin.name).toBe("sinwan");
  });
});

const COMPILER_RANGE = ">=0.2.5 <1.0.0";

describe("sinwan-compiler dependency range", () => {
  it("accepts any 0.x compiler without a plugin republish", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["sinwan-compiler"]).toBe(COMPILER_RANGE);
    expect(pkg.peerDependencies["sinwan-compiler"]).toBe(COMPILER_RANGE);
  });
});
