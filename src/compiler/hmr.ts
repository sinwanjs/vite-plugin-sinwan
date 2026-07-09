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
 * Detection is intentionally conservative: only top-level exports whose name
 * starts with an uppercase letter (the component naming convention) are
 * registered. The runtime safely ignores anything that is not used as a
 * component, so over-matching is harmless.
 */

import { parse } from "@babel/parser";

interface ExportedComponent {
  /** Local binding name in the module (referenced in the accept callback). */
  local: string;
  /** Export key on the module namespace ("default" for the default export). */
  key: string;
}

function isComponentName(name: string | undefined): name is string {
  return !!name && name[0] === name[0]!.toUpperCase() && /^[A-Z]/.test(name);
}

/**
 * Collect top-level exported component bindings from a module.
 */
function collectExportedComponents(
  code: string,
  filename: string,
): ExportedComponent[] {
  let ast: any;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      sourceFilename: filename,
    });
  } catch {
    return [];
  }

  const found: ExportedComponent[] = [];
  const seen = new Set<string>();
  const add = (local: string, key: string) => {
    const sig = `${local}::${key}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    found.push({ local, key });
  };

  for (const node of ast.program.body as any[]) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const decl = node.declaration;
        if (
          decl.type === "FunctionDeclaration" &&
          decl.id &&
          isComponentName(decl.id.name)
        ) {
          add(decl.id.name, decl.id.name);
        } else if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations) {
            if (d.id?.type === "Identifier" && isComponentName(d.id.name)) {
              add(d.id.name, d.id.name);
            }
          }
        }
      } else if (node.specifiers && !node.source) {
        // export { A, B as C }
        for (const spec of node.specifiers) {
          if (
            spec.type === "ExportSpecifier" &&
            spec.local?.type === "Identifier" &&
            spec.exported?.type === "Identifier" &&
            isComponentName(spec.exported.name)
          ) {
            add(spec.local.name, spec.exported.name);
          }
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (decl.type === "Identifier") {
        add(decl.name, "default");
      } else if (decl.type === "FunctionDeclaration" && decl.id) {
        add(decl.id.name, "default");
      }
    }
  }

  return found;
}

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

import { $$sinwanReplace as __$sinwanReplace, $$sinwanRefresh as __$sinwanRefresh } from "sinwan/react-client";
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
