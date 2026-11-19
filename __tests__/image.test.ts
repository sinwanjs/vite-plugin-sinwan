import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { deflateSync } from "zlib";
import { build, createServer, preview } from "vite";
import * as compilerImage from "sinwan-compiler/image";

import { IMAGE_FILE_ID_PREFIX, IMAGE_ID_PREFIX, sinwan } from "../src/index";
import {
  cacheFileMiddleware,
  handlerMiddleware,
  resolveImageId,
  toFetchRequest,
  type Middleware,
  type NodeRequest,
  type NodeResponse,
} from "../src/images";

const ROOT = path.join(import.meta.dir, "..");

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, Bun.hash.crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

/** A decodable RGB PNG gradient. */
function gradientPng(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (1 + width * 3) + 1 + x * 3;
      raw[at] = (x * 255) / width;
      raw[at + 1] = (y * 255) / height;
      raw[at + 2] = 128;
    }
  }
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

const APP_TSX = `import { Img } from "sinwan/image";
import logo from "./assets/logo.png";
export const Page = () => (
  <main>
    <Img src="./assets/hero.png" alt="Hero" width={300} placeholder="blur" />
    <Img src="/banner.png" alt="" sizes="100vw" format="jpeg" quality={60} />
    <Img src={logo} alt="Logo" width={64} />
  </main>
);
Reflect.set(globalThis, "page", Page);
`;

/** Just enough of `sinwan` for compiled output to resolve and bundle. */
const SINWAN_STUB = `export const Img = (props) => props;
export const cc = (fn) => fn;
export const _$createTemplate = (template, values) => ({ template, values });
export const jsx = (type, props) => ({ type, props });
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol("Fragment");
export const unwrap = (value) => value;
`;

let app: string;
const config = (extra: Record<string, unknown> = {}) => ({
  root: app,
  configFile: false as const,
  logLevel: "silent" as const,
  plugins: [sinwan({ cache: false, fastRefresh: false })],
  build: { outDir: path.join(app, "dist"), emptyOutDir: true },
  ...extra,
});

beforeAll(() => {
  app = fs.mkdtempSync(path.join(import.meta.dir, ".tmp-vite-image-"));
  fs.mkdirSync(path.join(app, "src", "assets"), { recursive: true });
  fs.mkdirSync(path.join(app, "public"), { recursive: true });
  fs.mkdirSync(path.join(app, "node_modules", "sinwan"), { recursive: true });
  fs.writeFileSync(path.join(app, "src", "assets", "hero.png"), gradientPng(1200, 600));
  fs.writeFileSync(path.join(app, "src", "assets", "logo.png"), gradientPng(256, 256));
  fs.writeFileSync(path.join(app, "public", "banner.png"), gradientPng(1000, 250));
  fs.writeFileSync(path.join(app, "src", "App.tsx"), APP_TSX);
  fs.writeFileSync(path.join(app, "index.html"), `<!doctype html><div id="root"></div><script type="module" src="/src/App.tsx"></script>`);
  const subpaths = ["image", "component", "renderer/web", "jsx-runtime", "jsx-dev-runtime", "reactivity"];
  fs.writeFileSync(
    path.join(app, "node_modules", "sinwan", "package.json"),
    JSON.stringify({ name: "sinwan", type: "module", exports: Object.fromEntries(subpaths.map((sub) => [`./${sub}`, "./stub.js"])) }),
  );
  fs.writeFileSync(path.join(app, "node_modules", "sinwan", "stub.js"), SINWAN_STUB);
});

afterAll(() => {
  fs.rmSync(app, { recursive: true, force: true });
});

describe("<Img> with Vite on Bun: build", () => {
  test("emits hashed optimized assets and srcset; a second build does not encode again", async () => {
    await build(config());
    const assets = fs.readdirSync(path.join(app, "dist", "assets"));
    const webp = assets.filter((file) => file.endsWith(".webp"));
    const jpeg = assets.filter((file) => file.endsWith(".jpg"));
    expect(webp).toHaveLength(4);
    expect(jpeg.length).toBeGreaterThanOrEqual(3);
    for (const file of [...webp, ...jpeg]) expect(file).toMatch(/-[\w-]{8}\.(webp|jpg)$/);
    expect(assets.some((file) => file.endsWith(".png"))).toBe(false);
    const js = assets.find((file) => file.endsWith(".js"));
    const code = fs.readFileSync(path.join(app, "dist", "assets", js!), "utf8");
    expect(code).toContain(" 2x");
    expect(code).toContain(" 640w");
    expect(code).toContain("data:image/png;base64,");
    expect(code).toContain("/assets/");
    expect(code).not.toMatch(/["'`][^"'`\n]*sinwan-img/);
    const hero = await new Bun.Image(path.join(app, "dist", "assets", webp.sort()[0]!)).metadata();
    expect(hero.format).toBe("webp");

    const encodes = [spyOn(Bun.Image.prototype, "webp"), spyOn(Bun.Image.prototype, "jpeg")];
    try {
      await build(config());
      expect(encodes.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    } finally {
      for (const spy of encodes) spy.mockRestore();
    }
  }, 60_000);

  test("vite preview serves the on-demand handler", async () => {
    const server = await preview(config({ preview: { port: 0, host: "127.0.0.1" } }));
    try {
      const base = server.resolvedUrls!.local[0]!;
      const image = await fetch(`${base}_sinwan/image?url=/banner.png&w=640`, { headers: { accept: "image/webp" } });
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/webp");
      expect((await fetch(`${base}index.html`)).status).toBe(200);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("<Img> with Vite on Bun: dev server", () => {
  test("serves optimized files from the cache and runtime images from the handler", async () => {
    const server = await createServer(config({ server: { port: 0, host: "127.0.0.1" } }));
    await server.listen();
    try {
      const base = server.resolvedUrls!.local[0]!;
      const app = await (await fetch(`${base}src/App.tsx`)).text();
      const moduleUrl = /["'](\/@id\/__x00__sinwan-img:[^"']+)["']/.exec(app)?.[1];
      expect(moduleUrl).toBeDefined();
      const assetModule = await (await fetch(new URL(moduleUrl!, base))).text();
      const fileUrl = /["'](\/@id\/__x00__sinwan-img-file:[^"']+)["']/.exec(assetModule)?.[1];
      expect(fileUrl).toBeDefined();
      const fileModule = await (await fetch(new URL(fileUrl!, base))).text();
      const imageUrl = /["'](\/@sinwan-img\/[0-9a-f]{32}\.webp)["']/.exec(fileModule)?.[1];
      expect(imageUrl).toBeDefined();
      const image = await fetch(new URL(imageUrl!, base));
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/webp");
      expect(image.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect((await new Bun.Image(new Uint8Array(await image.arrayBuffer())).metadata()).format).toBe("webp");

      expect((await fetch(`${base}@sinwan-img/not-a-hash.webp`)).status).toBe(404);
      expect((await fetch(`${base}@sinwan-img/${"0".repeat(32)}.webp`)).status).toBe(404);

      const runtime = await fetch(`${base}_sinwan/image?url=/banner.png&w=640`, { headers: { accept: "image/webp" } });
      expect(runtime.status).toBe(200);
      expect(runtime.headers.get("content-type")).toBe("image/webp");
      expect((await fetch(`${base}_sinwan/image?url=/banner.png&w=500`)).status).toBe(400);
      expect((await fetch(`${base}_sinwan/image?url=/banner.png&w=640`, { method: "HEAD" })).status).toBe(200);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("image hooks", () => {
  const context = () => {
    const watched: string[] = [];
    const emitted: Array<{ name: string; size: number }> = [];
    return {
      watched,
      emitted,
      resolve: async (source: string) => (source === "@/x.png" ? { id: "/abs/x.png?v=1" } : null),
      addWatchFile: (id: string) => {
        watched.push(id);
      },
      emitFile: (file: { name: string; source: Uint8Array }) => {
        emitted.push({ name: file.name, size: file.source.byteLength });
        return "ref1";
      },
    };
  };

  test("resolveId and load: virtual ids, watched sources, emitted files, dev URLs", async () => {
    const plugin = sinwan({ cache: false, images: { handlerPath: "/img" } });
    plugin.configResolved({ command: "build", mode: "production", root: app, base: "/app/", publicDir: path.join(app, "public") });
    const ctx = context();
    const importer = path.join(app, "src", "App.tsx");
    expect(await plugin.resolveId.call(ctx, "./a.png?sinwan-img=e30", importer)).toBe(`${IMAGE_ID_PREFIX}${path.join(app, "src", "a.png")}?sinwan-img=e30`);
    expect(await plugin.resolveId.call(ctx, "/b.png?sinwan-img=e30", importer)).toBe(`${IMAGE_ID_PREFIX}${path.join(app, "public", "b.png")}?sinwan-img=e30`);
    expect(await plugin.resolveId.call(ctx, "@/x.png?sinwan-img=e30", importer)).toBe(`${IMAGE_ID_PREFIX}/abs/x.png?sinwan-img=e30`);
    expect(await plugin.resolveId.call(ctx, "sinwan-img-file:/c/k.webp", importer)).toBe(`${IMAGE_FILE_ID_PREFIX}/c/k.webp`);
    expect(await plugin.resolveId.call(ctx, `${IMAGE_FILE_ID_PREFIX}/c/k.webp`, importer)).toBeNull();
    expect(await plugin.resolveId.call(ctx, "sinwan/image", importer)).toBeNull();
    await expect(plugin.resolveId.call(ctx, "@/missing.png?sinwan-img=e30", importer)).rejects.toThrow('could not resolve "@/missing.png" from');

    const hero = path.join(app, "src", "assets", "hero.png");
    const module = await plugin.load.call(ctx, `${IMAGE_ID_PREFIX}${hero}?sinwan-img=${Buffer.from('{"width":100}').toString("base64url")}`);
    expect(ctx.watched).toEqual([hero]);
    const file = /"sinwan-img-file:([^"]+)"/.exec(module ?? "")?.[1];
    expect(file).toBeDefined();
    expect(await plugin.load.call(ctx, `${IMAGE_FILE_ID_PREFIX}${file}`)).toBe("export default import.meta.ROLLUP_FILE_URL_ref1;");
    expect(ctx.emitted[0]?.name).toBe(path.basename(file!));
    expect(await plugin.load.call(ctx, "/src/other.ts")).toBeNull();

    plugin.configResolved({ command: "serve", mode: "development", root: app, publicDir: "" });
    expect(await plugin.load.call(ctx, `${IMAGE_FILE_ID_PREFIX}${file}`)).toBe(`export default "/@sinwan-img/${path.basename(file!)}";`);
  });

  test("resolveImageId without an importer resolves relative paths from the root", async () => {
    const ctx = context();
    expect(await resolveImageId(ctx, "./a.png?sinwan-img=e30", undefined, { root: "/r", publicDir: "/r/public" })).toBe(`${IMAGE_ID_PREFIX}/r/a.png?sinwan-img=e30`);
    await expect(resolveImageId(ctx, "pkg/a.png?sinwan-img=e30", undefined, { root: "/r", publicDir: "/p" })).rejects.toThrow('could not resolve "pkg/a.png".');
  });

  test("dev and preview servers mount the image middlewares", () => {
    const mounted: Middleware[] = [];
    const server = { middlewares: { use: (middleware: Middleware) => mounted.push(middleware) } };
    const plugin = sinwan({ cache: false });
    plugin.configureServer(server);
    expect(mounted).toHaveLength(2);
    plugin.configurePreviewServer(server);
    expect(mounted).toHaveLength(3);
  });
});

describe("connect adapters", () => {
  const response = () => {
    const headers: Record<string, string> = {};
    let body: Uint8Array | undefined;
    let ended: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const res: NodeResponse & { headers: Record<string, string>; body: () => Uint8Array | undefined; done: Promise<void> } = {
      statusCode: 0,
      headers,
      body: () => body,
      done,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      end(data) {
        body = data;
        ended();
      },
    };
    return res;
  };

  test("toFetchRequest copies the method, URL and headers", () => {
    const request = toFetchRequest({ originalUrl: "/a?b=1", method: "HEAD", headers: { accept: "image/webp", "x-list": ["1", "2"], skip: undefined } });
    expect(request.method).toBe("HEAD");
    expect(new URL(request.url).pathname).toBe("/a");
    expect(request.headers.get("accept")).toBe("image/webp");
    expect(request.headers.get("x-list")).toBe("1, 2");
    expect(request.headers.has("skip")).toBe(false);
    const fallback = toFetchRequest({ headers: {} });
    expect(fallback.method).toBe("GET");
    expect(new URL(fallback.url).pathname).toBe("/");
  });

  test("handlerMiddleware answers its route, passes others on, reports errors", async () => {
    const ok = handlerMiddleware(async () => new Response("hi", { status: 201, headers: { "x-a": "b" } }), "/img");
    const res = response();
    ok({ url: "/img?url=x", headers: {} }, res, () => {});
    await res.done;
    expect(res.statusCode).toBe(201);
    expect(res.headers["x-a"]).toBe("b");
    expect(new TextDecoder().decode(res.body())).toBe("hi");

    let passed = false;
    ok({ url: "/other", headers: {} }, response(), () => {
      passed = true;
    });
    expect(passed).toBe(true);

    const failure = new Error("boom");
    const failing = handlerMiddleware(() => Promise.reject(failure), "/img");
    const reported = await new Promise<unknown>((resolve) => failing({ url: "/img", headers: {} }, response(), resolve));
    expect(reported).toBe(failure);
  });

  test("cacheFileMiddleware only serves content-hashed cache files", async () => {
    const dir = fs.mkdtempSync(path.join(import.meta.dir, ".tmp-cache-"));
    const name = `${"a".repeat(32)}.png`;
    fs.writeFileSync(path.join(dir, name), gradientPng(4, 4));
    try {
      const middleware = cacheFileMiddleware(dir);
      const res = response();
      middleware({ url: `/base/@sinwan-img/${name}`, headers: {} }, res, () => {});
      await res.done;
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      let passed = false;
      middleware({ url: "/src/App.tsx", headers: {} } satisfies NodeRequest, response(), () => {
        passed = true;
      });
      expect(passed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Vite on Node", () => {
  const IMG_SOURCE = `import { Img } from "sinwan/image";\nexport const A = () => <Img src="./a.jpg" alt="" />;`;

  test("without Bun.Image, <Img> is refused with a bunx --bun vite hint and nothing is mounted", async () => {
    const probe = spyOn(compilerImage, "hasBunImage").mockReturnValue(false);
    try {
      const plugin = sinwan({ cache: false });
      plugin.configResolved({ command: "build", mode: "production", root: app });
      expect(() => plugin.transform(IMG_SOURCE, "/app/src/A.tsx")).toThrow("while compiling with Vite on Node. Start Vite on Bun: `bunx --bun vite`");
      const ctx = { resolve: async () => null, addWatchFile() {}, emitFile: () => "" };
      expect(() => plugin.resolveId.call(ctx, "sinwan/image")).toThrow("Start Vite with `bunx --bun vite`");
      expect(() => plugin.resolveId.call(ctx, "./a.jpg?sinwan-img=e30")).toThrow('tried to resolve "./a.jpg?sinwan-img=e30"');
      expect(plugin.resolveId.call(ctx, "sinwan/component")).toBeNull();
      expect(plugin.load.call(ctx, `${IMAGE_ID_PREFIX}/x.png?sinwan-img=e30`)).toBeNull();
      const mounted: Middleware[] = [];
      const server = { middlewares: { use: (middleware: Middleware) => mounted.push(middleware) } };
      plugin.configureServer(server);
      plugin.configurePreviewServer(server);
      expect(mounted).toHaveLength(0);
    } finally {
      probe.mockRestore();
    }
  });

  test("a real Node process gets the same error from the built plugin", () => {
    const built = Bun.spawnSync(["bun", "run", "build.ts"], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
    expect(built.exitCode).toBe(0);
    const script = `
      const { sinwan } = await import(${JSON.stringify(path.join(ROOT, "dist", "index.js"))});
      const plugin = sinwan({ cache: false });
      plugin.configResolved({ command: "build", mode: "production", root: process.cwd() });
      try { plugin.transform(${JSON.stringify(IMG_SOURCE)}, "/app/src/A.tsx"); console.log("NO ERROR"); }
      catch (error) { console.log(error.name + ": " + error.message); }
    `;
    const node = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const output = node.stdout.toString();
    expect(output).toContain("BunOnlyImageError");
    expect(output).toContain("bunx --bun vite");
  }, 60_000);
});
