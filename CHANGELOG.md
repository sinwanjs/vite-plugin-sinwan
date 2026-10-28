# Changelog

All notable changes to **vite-plugin-sinwan** are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com) and vite-plugin-sinwan adheres to [Semantic Versioning](https://semver.org).

## [1.0.1] — Vite dependency scan

### Fixed

- **Dependency scan in JavaScript apps**: Vite's dependency scan ignores `oxc.jsx.importSource` and `jsconfig.json`, so every clean `vite` start in a `.jsx` app failed with `Failed to run dependency scan … react/jsx-dev-runtime` and skipped pre-bundling. The plugin now sets the Sinwan JSX import source for both Oxc and `optimizeDeps.rolldownOptions` (Vite 8).
- **Full reload on the first dev visit**: compiled templates import `sinwan/renderer/web`, which the scan never sees, so Vite found it on the first request and reloaded the page. The plugin now adds it to `optimizeDeps.include`.

Library builds (`peerExternal: true`) are unchanged.

## [1.0.0] — Compiler 1.0

vite-plugin-sinwan 1.0.0 requires **sinwan-compiler 1.0.0**. The plugin still calls `transformJSX` and does not bundle the compiler. Generated code follows the 1.0 compiler: hoist helpers import `sinwan/renderer/web`, and `createStore` / `createMutable` are recognized from `sinway`.

### Changed

- **`sinwan-compiler` dependency**: `>=1.0.0 <2.0.0`. The previous range stopped before 1.0.0.

## [0.2.8] — @sinwan-pure Resolver Forwarding

vite-plugin-sinwan 0.2.8 forwards the analyzer cache `resolve` callback to the compiler as `resolveImport`, enabling `@sinwan-pure` JSDoc annotation scanning across all import types (relative, bare specifiers, scoped packages, subpaths). Pair with **sinwan-compiler 0.4.0**.

### Added

- **`resolveImport` forwarding (`src/index.ts`)**: When the analyzer cache is enabled (`cache: true`, the default), the plugin forwards `cache.resolve` to the compiler as the `resolveImport` option. This allows the compiler to resolve imports using the plugin's module resolver, which handles workspace packages, tsconfig paths, and Vite module resolution. The compiler uses this resolver to find `@sinwan-pure`-annotated source files for purity scanning.

### Internal

- Documentation updated in `README.md` — references the `@sinwan-pure` JSDoc contract in `sinwan-compiler/docs/transform.md`.
- `bun run build` clean.

---

## [0.2.7] — Derived Locals

vite-plugin-sinwan 0.2.7 forwards the `derivedLocals` option to the compiler. Pair with **sinwan-compiler 0.3.2**.

### Added

- **`derivedLocals` option**: When `true`, the compiler promotes eligible derived `const` initializers to zero-arity getters.
