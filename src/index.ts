import { transformJSX, AnalyzerCache } from "sinwan-compiler";
import { injectComponentHmr } from "./compiler/hmr";
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
  /** Enable template hoisting (default: true) */
  hoist?: boolean;
  /** Emit explicit compiler-driven binding descriptors (Phase 2, default: false). */
  explicitBindings?: boolean;
  /** Path to the reactive-props metadata file produced by `sinwan analyze`. */
  analyze?: string;
  /**
   * Enable incremental in-memory cross-file analysis for dev/HMR. When true,
   * the plugin analyzes each transformed file and passes the current metadata
   * to the transform without requiring a separate `sinwan analyze` step.
   */
  cache?: SinwanCacheOptions;
  /**
   * Enable plugin-free Fast Refresh — inject per-component HMR boundaries in
   * the dev server so editing a component updates that file in place (Vite
   * reports the real filename) while preserving state. Default: true.
   * Only active in `vite serve`; never affects production builds.
   */
  fastRefresh?: boolean;
}

const DEFAULT_SINWAN_OPTIONS: Required<
  Pick<SinwanOptions, "hoist" | "explicitBindings" | "fastRefresh" | "analyze">
> = {
  hoist: true,
  explicitBindings: false,
  fastRefresh: true,
  analyze: undefined as any,
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

  // Whether we are running the dev server (`vite serve`). Fast Refresh
  // injection only happens here; production builds are never touched.
  let isServe = false;
  let projectRoot: string | undefined;

  // Optional incremental cross-file analyzer for dev/HMR.
  let cache: AnalyzerCache | null = null;

  return {
    name: "sinwan",
    enforce: "pre",

    configResolved(config: any) {
      isServe = config?.command === "serve";
      projectRoot = config?.root;

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

    transform(code: string, id: string) {
      let result: { code: string; map?: any } | null = null;
      if (/\.[tj]sx$/.test(id)) {
        if (cache) {
          cache.update(id, code);
        }
        result = transformJSX(code, id, {
          hoist: opts.hoist,
          explicitBindings: opts.explicitBindings,
          analyze: opts.analyze,
          analyzeMetadata: cache ? cache.reactiveProps : undefined,
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
