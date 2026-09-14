import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { sinwan } from "../src/index";

describe("sinwan vite plugin", () => {
  it("forwards opt-in derived locals to the linked compiler in dev and production", () => {
    const input = `export function App() {
      const open = state.value > 0;
      return <div title={open}>{open}</div>;
    }`;
    for (const derivedLocals of [false, true]) {
      for (const command of ["serve", "build"]) {
        const plugin = sinwan({
          cache: false,
          dev: false,
          hoist: false,
          derivedLocals,
        });
        plugin.configResolved({
          command,
          mode: command === "build" ? "production" : "development",
        });
        const result = plugin.transform(input, "App.tsx");
        expect(
          result?.code.includes("const open = () => state.value > 0;"),
        ).toBe(derivedLocals);
        expect(result?.code.includes("title={() => open()}")).toBe(
          derivedLocals,
        );
        expect(result?.code.includes("import.meta.hot")).toBe(
          command === "serve",
        );
      }
    }
  });

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

const SPREAD_JSX =
  "const Card = (props) => <div {...props}><p>Hello</p></div>;";

function collectWarns(run: () => void): string[] {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0]));
  };
  try {
    run();
    return warns;
  } finally {
    console.warn = originalWarn;
  }
}

describe("compiler dev warnings", () => {
  it("does not warn about skipped hoists when dev is false", () => {
    const plugin = sinwan({ cache: false, dev: false });
    const warns = collectWarns(() => {
      plugin.transform(SPREAD_JSX, "Card.tsx");
    });
    expect(
      warns.some((line) => line.includes("template hoisting skipped")),
    ).toBe(false);
  });

  it("warns about skipped hoists when dev is true", () => {
    const plugin = sinwan({ cache: false, dev: true });
    const warns = collectWarns(() => {
      plugin.transform(SPREAD_JSX, "Card.tsx");
    });
    expect(
      warns.some((line) => line.includes("template hoisting skipped")),
    ).toBe(true);
  });

  it("uses Vite production mode after configResolved unless dev is set", () => {
    const plugin = sinwan({ cache: false });
    plugin.configResolved({
      command: "build",
      mode: "production",
      root: "/app",
    });
    const warns = collectWarns(() => {
      plugin.transform(SPREAD_JSX, "Card.tsx");
    });
    expect(
      warns.some((line) => line.includes("template hoisting skipped")),
    ).toBe(false);
  });

  it("uses Vite development mode after configResolved unless dev is set", () => {
    const plugin = sinwan({ cache: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const warns = collectWarns(() => {
      plugin.transform(SPREAD_JSX, "Card.tsx");
    });
    expect(
      warns.some((line) => line.includes("template hoisting skipped")),
    ).toBe(true);
  });

  it("keeps an explicit dev option after configResolved production mode", () => {
    const plugin = sinwan({ cache: false, dev: true });
    plugin.configResolved({
      command: "build",
      mode: "production",
      root: "/app",
    });
    const warns = collectWarns(() => {
      plugin.transform(SPREAD_JSX, "Card.tsx");
    });
    expect(
      warns.some((line) => line.includes("template hoisting skipped")),
    ).toBe(true);
  });

  it("defaults to quiet when NODE_ENV is production before configResolved", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const plugin = sinwan({ cache: false });
      const warns = collectWarns(() => {
        plugin.transform(SPREAD_JSX, "Card.tsx");
      });
      expect(
        warns.some((line) => line.includes("template hoisting skipped")),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });

  it("does not override captured env when config.mode is not a string", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const plugin = sinwan({ cache: false });
      plugin.configResolved({ command: "serve", root: "/app" });
      const warns = collectWarns(() => {
        plugin.transform(SPREAD_JSX, "Card.tsx");
      });
      expect(
        warns.some((line) => line.includes("template hoisting skipped")),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });
});

describe("vite transform, cache, and Fast Refresh", () => {
  it("returns null for non-jsx files", () => {
    const plugin = sinwan({ cache: false, fastRefresh: false });
    expect(plugin.transform("const x = 1;", "file.ts")).toBeNull();
  });

  it("transforms jsx and updates cache when bunfig exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(import.meta.dir, ".tmp-"));
    const bunfig = path.join(tmpDir, "bunfig.toml");
    fs.writeFileSync(bunfig, "[install]\n");
    try {
      const plugin = sinwan({
        cache: {
          root: tmpDir,
          tsConfigPath: path.join(tmpDir, "tsconfig.json"),
          cachePath: path.join(tmpDir, "cache.json"),
          bunfigPath: bunfig,
          workspaces: tmpDir,
        },
        fastRefresh: false,
        dev: false,
      });
      plugin.configResolved({
        command: "build",
        mode: "production",
        root: tmpDir,
      });
      const result = plugin.transform(
        "export function Hello() { return <div>hi</div>; }",
        path.join(tmpDir, "Hello.tsx"),
      );
      expect(result?.code).toContain("_$createTemplate");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("uses projectRoot when cache is a boolean", () => {
    const plugin = sinwan({ cache: true, fastRefresh: false, dev: false });
    plugin.configResolved({
      command: "build",
      mode: "production",
      root: process.cwd(),
    });
    const result = plugin.transform(
      "const App = () => <div>ok</div>;",
      "App.tsx",
    );
    expect(result?.code).toBeDefined();
  });

  it("falls back to cwd when cache is a boolean and root is omitted", () => {
    const plugin = sinwan({ cache: true, fastRefresh: false, dev: false });
    plugin.configResolved({ command: "build", mode: "production" });
    const result = plugin.transform(
      "const App = () => <div>ok</div>;",
      "App.tsx",
    );
    expect(result?.code).toBeDefined();
  });

  it("uses cache object defaults without root or bunfigPath", () => {
    const plugin = sinwan({
      cache: {},
      fastRefresh: false,
      dev: false,
    });
    plugin.configResolved({
      command: "build",
      mode: "production",
      root: "/app",
    });
    const result = plugin.transform(
      "const App = () => <div>ok</div>;",
      "App.jsx",
    );
    expect(result?.code).toBeDefined();
  });

  it("uses cwd when a cache object has no root and config has no root", () => {
    const plugin = sinwan({
      cache: {},
      fastRefresh: false,
      dev: false,
    });
    plugin.configResolved({ command: "build", mode: "production" });
    const result = plugin.transform(
      "const App = () => <div>ok</div>;",
      "App.tsx",
    );
    expect(result?.code).toBeDefined();
  });

  it("injects Fast Refresh in serve for an exported component", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const result = plugin.transform(
      "export function Hello() { return <div>hi</div>; }",
      "/app/src/Hello.tsx",
    );
    expect(result?.code).toContain("$$sinwanReplace");
  });

  it("injects Fast Refresh using original source when the id has a query", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const result = plugin.transform(
      "export function Hello() { return <div>hi</div>; }",
      "/app/src/Hello.tsx?t=1",
    );
    expect(result?.code).toContain("$$sinwanReplace");
  });

  it("skips Fast Refresh for node_modules", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const result = plugin.transform(
      "export function Hello() { return <div>hi</div>; }",
      "/app/node_modules/lib/Hello.tsx",
    );
    expect(result?.code ?? "").not.toContain("$$sinwanReplace");
  });

  it("skips Fast Refresh for virtual modules", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const result = plugin.transform(
      "export function Hello() { return <div>hi</div>; }",
      "\0virtual/Hello.tsx",
    );
    expect(result?.code ?? "").not.toContain("$$sinwanReplace");
  });

  it("skips Fast Refresh when the module exports no component", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const result = plugin.transform("const x = 1;", "/app/src/util.tsx");
    expect(result?.code ?? "").not.toContain("$$sinwanReplace");
  });

  it("does not inject Fast Refresh during build", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "build",
      mode: "production",
      root: "/app",
    });
    const result = plugin.transform(
      "export function Hello() { return <div>hi</div>; }",
      "/app/src/Hello.tsx",
    );
    expect(result?.code ?? "").not.toContain("$$sinwanReplace");
  });

  it("does not inject Fast Refresh when disabled", () => {
    const plugin = sinwan({ cache: false, fastRefresh: false, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const result = plugin.transform(
      "export function Hello() { return <div>hi</div>; }",
      "/app/src/Hello.tsx",
    );
    expect(result?.code ?? "").not.toContain("$$sinwanReplace");
  });

  it("does not double-inject Fast Refresh", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const alreadyWired =
      "export function Hello() { return <div>hi</div>; }\nconst $$sinwanReplace = 1;";
    const result = plugin.transform(alreadyWired, "/app/src/Hello.tsx");
    expect(result?.code).not.toContain("import.meta.hot.accept");
  });

  it("skips Fast Refresh when the refresh helper is already present", () => {
    const plugin = sinwan({ cache: false, fastRefresh: true, dev: false });
    plugin.configResolved({
      command: "serve",
      mode: "development",
      root: "/app",
    });
    const alreadyWired =
      "export function Hello() { return <div>hi</div>; }\nconst __$sinwanRefresh = 1;";
    const result = plugin.transform(alreadyWired, "/app/src/Hello.tsx");
    expect(result?.code).not.toContain("import.meta.hot.accept");
  });
});

const COMPILER_RANGE = ">=0.4.0 <1.0.0";

describe("sinwan-compiler dependency range", () => {
  it("accepts any 0.x compiler without a plugin republish", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["sinwan-compiler"]).toBe(COMPILER_RANGE);
  });
});
