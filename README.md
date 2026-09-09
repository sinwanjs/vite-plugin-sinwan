# vite-plugin-sinwan

Vite plugin for [Sinwan](https://sinwanjs.com) — JSX transformation with template hoisting, reactive expression wrapping, and plugin-free Fast Refresh powered by `sinwan-compiler`.

## Install

```sh
bun add -d vite-plugin-sinwan
```

## Compiler updates

The plugin depends on `sinwan-compiler` with `>=0.2.5 <1.0.0` and does not bundle it. Publishing a new 0.x compiler does **not** require a plugin release.

- New installs resolve the newest compatible compiler automatically.
- Existing apps keep a lockfile pin until they run `bun update sinwan-compiler`.
- Republish this plugin only when the plugin API itself changes, or when `sinwan-compiler` reaches 1.0.

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
});
```

| Option             | Type                            | Default     | Description                                           |
| ------------------ | ------------------------------- | ----------- | ----------------------------------------------------- |
| `hoist`            | `boolean`                       | `true`      | Hoist static DOM to module-level templates            |
| `explicitBindings` | `boolean`                       | `false`     | Emit compiler-driven binding descriptors              |
| `analyze`          | `string`                        | `undefined` | Path to reactive-props metadata from `sinwan analyze` |
| `cache`            | `boolean \| SinwanCacheOptions` | `false`     | Enable incremental in-memory cross-file analysis      |
| `fastRefresh`      | `boolean`                       | `true`      | Inject per-component HMR boundaries (dev server only) |

## How it works

- Runs with `enforce: "pre"` so it executes before any other transform
- Static DOM elements are hoisted to module-level template objects
- Dynamic expressions are wrapped in zero-arity functions for fine-grained reactivity
- Component calls (capitalised tags) are left for the runtime
- Fast Refresh injects per-component HMR boundaries in `vite serve` — no extra plugin needed

## License

MIT © Mohammed Ben Cheikh
