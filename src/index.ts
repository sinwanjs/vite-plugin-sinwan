import {
  transformJSX,
  AnalyzerCache,
  BunOnlyImageError,
  IMAGE_QUERY_PATTERN,
  formatDiagnostic,
  type DiagnosticHandler,
  type SinwanDiagnostic,
} from "sinwan-compiler";
import { hasBunImage, resolveImageConfig, type ImageConfig } from "sinwan-compiler/image";
import { injectComponentHmr } from "./compiler/hmr";
import {
  loadImage,
  mountDevImages,
  mountPreviewImages,
  resolveImageImport,
  type ImagePluginContext,
  type MiddlewareServer,
  type SinwanViteImageOptions,
} from "./images";

export {
  DEV_IMAGE_SEGMENT,
  IMAGE_FILE_ID_PREFIX,
  IMAGE_ID_PREFIX,
  type SinwanViteImageOptions,
} from "./images";
import * as fs from "fs";
import * as path from "path";

export type SinwanCacheOptions =
  | boolean
  | {
      root?: string;
      tsConfigPath?: string;
      /** Path to a JSON cache file for persisting the analyzer state. */
      cachePath?: string;
      /** Path to bunfig.toml for Bun alias resolution. */
      bunfigPath?: string;
      /** Workspace file or package paths for cross-package analysis. */
      workspaces?: import("sinwan-compiler").WorkspacesConfig;
    };

export interface SinwanOptions {
  derivedLocals?: boolean;
  /** Enable template hoisting (default: true) */
  hoist?: boolean;
  /** Emit explicit compiler-driven binding descriptors (default: true). */
  explicitBindings?: boolean;
  /** Path to the reactive-props metadata file produced by `sinwan analyze`. */
  analyze?: string;
  /**
   * Enable incremental in-memory cross-file analysis for dev/HMR. When true,
   * the plugin analyzes each transformed file and passes the current metadata
   * to the transform without requiring a separate `sinwan analyze` step.
   * Default: true (in-memory only; set to `false` to disable, or pass an object
   * to configure root/paths and persistent cache).
   */
  cache?: SinwanCacheOptions;
  /**
   * Enable plugin-free Fast Refresh — inject per-component HMR boundaries in
   * the dev server so editing a component updates that file in place (Vite
   * reports the real filename) while preserving state. Default: true.
   * Only active in `vite serve`; never affects production builds.
   */
  fastRefresh?: boolean;
  /**
   * Warn when template hoisting is skipped (spreads, enhancer tags, …).
   * Default: Vite `config.mode !== "production"` after `configResolved`,
   * otherwise `process.env.NODE_ENV !== "production"` when `sinwan()` runs.
   */
  dev?: boolean;
  /**
   * Library/publish builds: keep `sinwan` / `sinwan/*` as Rollup externals.
   * Default false (apps): `resolve.dedupe` so linked packages share the app runtime.
   */
  peerExternal?: boolean;
  /**
   * `<Img>` (`sinwan/image`) when Vite runs on Bun (`bunx --bun vite`):
   * `publicDir` (default: Vite's), `cacheDir` (default `.sinwan/images`),
   * sizes, quality, remote sources and `handlerPath` (default
   * `/_sinwan/image`) of the on-demand handler mounted in dev and preview.
   * On Node, any `<Img>` fails with a `bunx --bun vite` hint.
   */
  images?: SinwanViteImageOptions;
  /**
   * Receives compiler diagnostics (`SW1xx`) for your source files; files under
   * `node_modules` are skipped. The lint rules run only with `dev`. Default:
   * Vite's `this.warn` with the file and location.
   */
  onDiagnostic?: DiagnosticHandler;
}

/** The part of Vite's transform context the plugin uses to report warnings. */
interface WarnContext {
  warn: (warning: {
    message: string;
    id: string;
    loc: { file: string; line: number; column: number };
  }) => void;
}

function hasWarn(context: object | undefined): context is WarnContext {
  return (
    context !== undefined &&
    "warn" in context &&
    typeof context.warn === "function"
  );
}

/** Report through Vite (0-based column), or print when there is no context. */
function warnThrough(
  context: object | undefined,
  diagnostic: SinwanDiagnostic,
): void {
  if (hasWarn(context)) {
    context.warn({
      message: `${diagnostic.code}: ${diagnostic.message}\n  ${diagnostic.hint}`,
      id: diagnostic.file,
      loc: {
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column - 1,
      },
    });
  } else {
    console.warn(formatDiagnostic(diagnostic));
  }
}

function ignoreDiagnostic(): void {}

/**
 * Bracket access so Bun.build cannot fold `process.env.NODE_ENV` into `true`
 * when this plugin itself is bundled.
 */
function defaultCompilerDev(): boolean {
  return process.env["NODE_ENV"] !== "production";
}

const SINWAN_PEER = /^sinwan(\/|$)/;

const JSX_IMPORT_SOURCE = "sinwan";

/**
 * Compiled templates import their DOM helpers from here. Vite's dependency
 * scan only sees source imports, so without pre-bundling it the first page
 * load discovers it late and triggers a full reload.
 */
const COMPILER_RUNTIME = "sinwan/renderer/web";

/** `<Img>`: refused when Vite runs on Node. */
const IMAGE_MODULE = "sinwan/image";

const DEFAULT_SINWAN_OPTIONS: Required<
  Pick<
    SinwanOptions,
    "hoist" | "explicitBindings" | "fastRefresh" | "cache" | "peerExternal"
  >
> = {
  hoist: true,
  explicitBindings: false,
  fastRefresh: true,
  cache: true,
  peerExternal: false,
};

/**
 * Unified Sinwan Vite plugin.
 *
 * Handles JSX compilation (with optional template hoisting).
 *
 * @example
 * ```ts
 * // JSX transform only (default)
 * sinwan()
 * ```
 */
export function sinwan(options: SinwanOptions = {}) {
  const opts = { ...DEFAULT_SINWAN_OPTIONS, ...options };
  const explicitDev = options.dev;
  let compilerDev = explicitDev ?? defaultCompilerDev();

  // Whether we are running the dev server (`vite serve`). Fast Refresh
  // injection only happens here; production builds are never touched.
  let isServe = false;
  let projectRoot: string | undefined;

  // Optional incremental cross-file analyzer for dev/HMR.
  let cache: AnalyzerCache | null = null;

  // <Img> runs only when Vite itself runs on Bun (`bunx --bun vite`).
  const imagesOnBun = hasBunImage();
  const { handlerPath, ...imageOptions } = options.images ?? {};
  let imageConfig: ImageConfig = resolveImageConfig(imageOptions);
  let base = "/";

  return {
    name: "sinwan",
    enforce: "pre" as const,

    /**
     * Same role as Vite's `resolve.dedupe` for React: linked `file:` / `link:`
     * packages that depend on `sinwan` must share the app's runtime.
     *
     * Apps also get the Sinwan JSX import source for Oxc and for the
     * dependency scan, which reads neither this plugin nor a `jsconfig.json`.
     */
    config() {
      if (opts.peerExternal) {
        return {
          build: {
            rollupOptions: {
              external: SINWAN_PEER,
            },
          },
        };
      }
      return {
        resolve: {
          dedupe: ["sinwan"],
        },
        oxc: {
          jsx: { importSource: JSX_IMPORT_SOURCE },
        },
        optimizeDeps: {
          include: [COMPILER_RUNTIME],
          rolldownOptions: {
            transform: { jsx: { importSource: JSX_IMPORT_SOURCE } },
          },
        },
      };
    },

    configResolved(config: any) {
      isServe = config?.command === "serve";
      projectRoot = config?.root;
      base = typeof config?.base === "string" ? config.base : "/";
      imageConfig = resolveImageConfig({
        root: projectRoot,
        ...(typeof config?.publicDir === "string" && config.publicDir !== "" ? { publicDir: config.publicDir } : {}),
        ...imageOptions,
      });
      if (explicitDev === undefined && typeof config?.mode === "string") {
        compilerDev = config.mode !== "production";
      }

      if (opts.cache) {
        const root =
          typeof opts.cache === "object"
            ? (opts.cache.root ?? projectRoot ?? process.cwd())
            : (projectRoot ?? process.cwd());
        const tsConfigPath =
          typeof opts.cache === "object" ? opts.cache.tsConfigPath : undefined;
        const cachePath =
          typeof opts.cache === "object" ? opts.cache.cachePath : undefined;
        const bunfigPath =
          typeof opts.cache === "object"
            ? (opts.cache.bunfigPath ?? path.join(root, "bunfig.toml"))
            : path.join(root, "bunfig.toml");
        const workspaces =
          typeof opts.cache === "object" ? opts.cache.workspaces : undefined;
        cache = new AnalyzerCache({
          root,
          tsConfigPath,
          cachePath,
          bunfigPath: fs.existsSync(bunfigPath) ? bunfigPath : undefined,
          workspaces,
        });
      }
    },

    /**
     * `<Img>` images: on Bun, `?sinwan-img=` and `sinwan-img-file:` imports
     * become virtual modules. On Node there is no `Bun.Image` and no fallback,
     * so importing `sinwan/image` or an `<Img>` asset fails here.
     */
    resolveId(this: ImagePluginContext, id: string, importer?: string) {
      if (!imagesOnBun) {
        if (id === IMAGE_MODULE || IMAGE_QUERY_PATTERN.test(id)) {
          throw new BunOnlyImageError(`Vite (running on Node) tried to resolve "${id}". Start Vite with \`bunx --bun vite\`.`);
        }
        return null;
      }
      return resolveImageImport(this, id, importer, imageConfig);
    },

    load(this: ImagePluginContext, id: string) {
      if (!imagesOnBun) return null;
      return loadImage(this, id, imageConfig, { serve: isServe, base });
    },

    configureServer(server: MiddlewareServer) {
      if (imagesOnBun) mountDevImages(server, imageConfig, handlerPath);
    },

    configurePreviewServer(server: MiddlewareServer) {
      if (imagesOnBun) mountPreviewImages(server, imageConfig, handlerPath);
    },

    transform(this: object | undefined, code: string, id: string) {
      let result: { code: string; map?: any } | null = null;
      if (/\.[tj]sx$/.test(id)) {
        if (cache) {
          cache.update(id, code);
        }
        result = transformJSX(code, id, {
          hoist: opts.hoist,
          derivedLocals: opts.derivedLocals,
          explicitBindings: opts.explicitBindings,
          dev: compilerDev,
          analyze: opts.analyze,
          analyzeMetadata: cache ? cache.reactiveProps : undefined,
          resolveImport: cache ? cache.resolve : undefined,
          images: { host: imagesOnBun ? "bun" : "vite" },
          onDiagnostic: id.includes("/node_modules/")
            ? ignoreDiagnostic
            : (opts.onDiagnostic ??
              ((diagnostic) => warnThrough(this, diagnostic))),
        });
      }

      // Fast Refresh: append per-component HMR boundaries in the dev server.
      // Skip dependencies and virtual/query modules.
      const idPath = id.split("?")[0];
      if (
        opts.fastRefresh &&
        isServe &&
        /\.[tj]sx$/.test(idPath) &&
        !id.includes("/node_modules/") &&
        !id.startsWith("\0")
      ) {
        const base = result ? result.code : code;
        const withHmr = injectComponentHmr(base, id);
        if (withHmr !== null) {
          // Footer is appended (imports are hoisted by ESM), so existing line
          // numbers — and thus the JSX source map — stay valid.
          return { code: withHmr, map: result ? result.map : null };
        }
      }

      return result;
    },
  };
}

export { transformJSX };
