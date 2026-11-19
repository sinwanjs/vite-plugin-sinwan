# vite-plugin-sinwan

Vite plugin for [Sinwan](https://sinwanjs.com) — JSX transformation with template hoisting, reactive expression wrapping, and plugin-free Fast Refresh powered by `sinwan-compiler`.

## Install

```sh
bun add -d vite-plugin-sinwan
```

## Compiler updates

The plugin depends on `sinwan-compiler` `>=1.0.0 <2.0.0` and does not bundle it. A new 1.x compiler is picked up by `bun update sinwan-compiler`. Publish a new plugin when its own API changes, or when the compiler reaches 2.0.

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { sinwan } from "vite-plugin-sinwan";

export default defineConfig({
  plugins: [sinwan()],
});
```

## Options

```ts
sinwan({
  // Enable template hoisting (default: true)
  hoist: true,
  // Warn when hoisting is skipped (default: Vite mode !== "production")
  dev: true,
  // Emit explicit binding descriptors (default: false)
  explicitBindings: false,
  // Path to reactive-props metadata from `sinwan analyze`
  analyze: "./.sinwan/props.json",
  // Incremental cross-file analysis for dev/HMR
  cache: {
    root: process.cwd(),
    tsConfigPath: "./tsconfig.json",
    cachePath: "./.sinwan/cache.json",
    bunfigPath: "./bunfig.toml",
  },
  // Plugin-free Fast Refresh (default: true, dev server only)
  fastRefresh: true,
  // Library/publish builds: keep sinwan/* as Rollup externals
  peerExternal: false,
});
```

| Option             | Type                            | Default                      | Description                                           |
| ------------------ | ------------------------------- | ---------------------------- | ----------------------------------------------------- |
| `hoist`            | `boolean`                       | `true`                       | Hoist static DOM to module-level templates            |
| `dev`              | `boolean`                       | Vite `mode !== "production"` | Warn when template hoisting is skipped                |
| `explicitBindings` | `boolean`                       | `false`                      | Emit compiler-driven binding descriptors              |
| `analyze`          | `string`                        | `undefined`                  | Path to reactive-props metadata from `sinwan analyze` |
| `cache`            | `boolean \| SinwanCacheOptions` | `false`                      | Enable incremental in-memory cross-file analysis      |
| `fastRefresh`      | `boolean`                       | `true`                       | Inject per-component HMR boundaries (dev server only) |
| `peerExternal`     | `boolean`                       | `false`                      | Library builds: leave `sinwan/*` as Rollup externals  |

Enable `sinwan({ derivedLocals: true })` to promote eligible reactive `const` derivations inside component setup. This defaults to `false`; use compiler and runtime builds containing derived-local promotion and getter-attribute hydration support. `/* sinwan-snapshot */` preserves an intentional one-shot read. In development, the compiler diagnoses eligible JSX snapshots and setup `if` reads. Imported functions annotated with `/** @sinwan-pure */` JSDoc are also promoted; see the [`@sinwan-pure` JSDoc contract](../sinwan-compiler/docs/transform.md#sinwan-pure-jsdoc-contract) in the compiler docs.

## Images (`<Img>`): run Vite on Bun

`<Img>` (`sinwan/image`) is optimized by Bun's native `Bun.Image`, with no fallback library. Vite can use it when **Vite itself runs on Bun**:

```json
{
  "scripts": {
    "dev": "bunx --bun vite",
    "build": "bunx --bun vite build",
    "preview": "bunx --bun vite preview"
  }
}
```

On Bun, the plugin:

- **Build**: optimizes static `<Img>` sources and emits them as hashed assets (`assets/<name>-<hash>.webp`, following `base` and `assetsDir`). The compiled `srcset` points at them.
- **Dev**: serves optimized files from the cache at `/@sinwan-img/<hash>.<ext>` (immutable). Editing a source image re-optimizes it.
- **Runtime images**: in dev and in `vite preview`, mounts the on-demand handler for runtime sources (`<Img src={url} width={…} />`) at `/_sinwan/image`.

Unchanged images are never processed again (`.sinwan/images/`).

```ts
sinwan({
  images: {
    publicDir: "public",            // default: Vite's publicDir; src="/x.jpg"
    cacheDir: ".sinwan/images",
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    quality: 75,
    remotePatterns: [{ protocol: "https", hostname: "cdn.example.com" }],
    handlerPath: "/_sinwan/image",  // on-demand handler in dev and preview
  },
});
```

A static `vite build` output contains every build-time image. Runtime sources also need the handler in production, which a Bun server provides: `createImageHandler` from `sinwan-compiler/image` as a `Bun.serve` route.

Plain `vite` on Node cannot run `Bun.Image`. Any `<Img>` then fails with `BunOnlyImageError`, which names the file and asks you to start Vite with `bunx --bun vite`.

## How it works

- Runs with `enforce: "pre"` so it executes before any other transform
- Static DOM elements are hoisted to module-level template objects
- Dynamic expressions are wrapped in zero-arity functions for fine-grained reactivity
- Component calls (capitalised tags) are left for the runtime
- Fast Refresh injects per-component HMR boundaries in `vite serve` — no extra plugin needed

## License

MIT © Mohammed Ben Cheikh
