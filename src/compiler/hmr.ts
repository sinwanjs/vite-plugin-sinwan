/**
 * Sinwan Fast Refresh — HMR boundary injection (DEV only).
 *
 * For each module that exports component(s), we append a self-accepting HMR
 * footer. On edit, the footer maps the module's old export(s) to the new
 * one(s) via `$$sinwanReplace` and triggers a root re-render via
 * `$$sinwanRefresh`. Because each component module becomes its own HMR
 * boundary, Vite reports the actual edited file (e.g. `hmr update /src/Foo.tsx`)
 * instead of falling back to the entry — and state is preserved by the
 * runtime's resolve-to-latest mechanism.
 *
 * Component detection is delegated to `sinwan-compiler`'s shared
 * `collectExportedComponents` utility so both Vite and Bun plugins use the
 * same logic without duplicating Babel parsing.
 */

import { collectExportedComponents } from "sinwan-compiler";

/**
 * Append a Fast Refresh HMR footer to a component module's source.
 * Returns the augmented code, or `null` when the module exports no components.
 */
export function injectComponentHmr(
  code: string,
  filename: string,
): string | null {
  const components = collectExportedComponents(code, filename);
  if (components.length === 0) return null;

  // Guard: if the module already wired HMR manually, do not double-inject.
  if (code.includes("$$sinwanReplace") || code.includes("__$sinwanRefresh")) {
    return null;
  }

  const replaces = components
    .map(({ local, key }) => `    __$sinwanReplace(${local}, __m.${key});`)
    .join("\n");

  const footer = `

import { $$sinwanReplace as __$sinwanReplace, $$sinwanRefresh as __$sinwanRefresh } from "sinwan/react";
if (import.meta.hot) {
  import.meta.hot.accept((__m) => {
    if (!__m) return;
${replaces}
    __$sinwanRefresh();
  });
}
`;

  return code + footer;
}
