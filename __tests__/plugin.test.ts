import { describe, it, expect } from "bun:test";
import { sinwan } from "../src/index";

describe("sinwan vite plugin", () => {
  it("can be created with cache enabled", () => {
    const plugin = sinwan({ cache: true });
    expect(plugin.name).toBe("sinwan");
    expect(typeof plugin.configResolved).toBe("function");
    expect(typeof plugin.transform).toBe("function");
  });

  it("can be created with a custom cache root", () => {
    const plugin = sinwan({
      cache: { root: "/project", tsConfigPath: "/project/tsconfig.json" },
    });
    expect(plugin.name).toBe("sinwan");
  });
});
