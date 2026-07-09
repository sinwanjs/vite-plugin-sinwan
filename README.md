# vite-plugin-sinwan

Official Vite plugin for the Sinwan UI framework. Provides JSX compilation.

## Installation

```bash
bun add -d vite-plugin-sinwan
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { sinwan } from "vite-plugin-sinwan";

export default defineConfig({
  plugins: [sinwan()],
});
```

## `sinwan(options?)`

Single plugin that handles JSX compilation.

### Options

| Option  | Type      | Default | Description                                   |
| ------- | --------- | ------- | --------------------------------------------- |
| `hoist` | `boolean` | `true`  | Enable template hoisting in the JSX transform |

### Simple usage patterns

```ts
// JSX transform only (default)
sinwan();
```

## How it works

### JSX compilation

Runs with `enforce: "pre"` so it executes before any other transform.

- Static DOM elements are hoisted to module-level template objects.
- Dynamic expressions are replaced with `_$createTemplate` calls.
- Component calls (capitalised tags) are left untouched for the runtime.

## Type-check & test

```bash
# Type-check the plugin source
npx tsc --noEmit

# Run the test suite
bun test
```
