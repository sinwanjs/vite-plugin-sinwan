/**
 * `<Img>` for Vite started on Bun (`bunx --bun vite`). Images are optimized by
 * `sinwan-compiler/image` with Bun's native `Bun.Image`; Vite only resolves,
 * emits and serves the results. Vite on Node is refused (no fallback encoder).
 *
 * - `?sinwan-img=` imports load as image asset modules (the compiler's
 *   generator), which import their optimized files as `sinwan-img-file:<path>`.
 * - Build: those files are emitted with `this.emitFile`, so Vite hashes them
 *   and applies `base` / `assetsDir`.
 * - Dev: they are served from the content-addressed cache at
 *   `<base>@sinwan-img/<file>` (immutable), not through Vite's static server,
 *   which does not reliably serve the dot directory `.sinwan/`.
 * - Dev and preview mount the on-demand handler for runtime sources.
 */
import { readFile } from "fs/promises";
import * as path from "path";

import { IMAGE_QUERY_PATTERN } from "sinwan-compiler";
import {
  DEFAULT_IMAGE_PATH,
  FORMAT_MIME,
  IMAGE_FILE_PATTERN,
  createImageHandler,
  loadImageModule,
  type ImageConfig,
  type ImageHandler,
} from "sinwan-compiler/image";

/** `<Img>` settings for the Vite plugin. */
export type SinwanViteImageOptions = Partial<ImageConfig> & {
  /** Route of the on-demand handler in dev and preview (default `/_sinwan/image`). */
  handlerPath?: string;
};

/** Virtual id of an image asset module (`\0sinwan-img:<abs path>?sinwan-img=…`). */
export const IMAGE_ID_PREFIX = "\0sinwan-img:";
/** Virtual id of one optimized file (`\0sinwan-img-file:<abs path>`). */
export const IMAGE_FILE_ID_PREFIX = "\0sinwan-img-file:";
/** Dev URL segment of optimized files. */
export const DEV_IMAGE_SEGMENT = "@sinwan-img/";

/** Cache file names are content hashes; nothing else is ever served. */
const CACHE_FILE = /\/@sinwan-img\/([0-9a-f]{32}\.(webp|avif|jpg|png))$/;
const MIME_BY_EXTENSION: Record<string, string> = {
  webp: FORMAT_MIME.webp,
  avif: FORMAT_MIME.avif,
  jpg: FORMAT_MIME.jpeg,
  png: FORMAT_MIME.png,
};

/** The parts of Rollup/Vite's plugin context the image hooks use. */
export interface ImagePluginContext {
  resolve(source: string, importer?: string, options?: { skipSelf?: boolean }): Promise<{ id: string } | null>;
  addWatchFile(id: string): void;
  emitFile(file: { type: "asset"; name: string; source: Uint8Array }): string;
}

/** Node's `IncomingMessage` as connect passes it. */
export interface NodeRequest {
  url?: string;
  originalUrl?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Node's `ServerResponse`, the parts we write. */
export interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: Uint8Array): void;
}

export type NextFunction = (error?: unknown) => void;
export type Middleware = (request: NodeRequest, response: NodeResponse, next: NextFunction) => void;

/** `server.middlewares` of a Vite dev or preview server. */
export interface MiddlewareServer {
  middlewares: { use(middleware: Middleware): void };
}

/**
 * Absolute id (query kept) for an `<Img>` asset import: `/x.jpg` is in the
 * public directory, `./x.jpg` is next to the importer, anything else goes
 * through Vite's resolver (aliases, packages).
 */
export async function resolveImageId(
  context: Pick<ImagePluginContext, "resolve">,
  specifier: string,
  importer: string | undefined,
  config: Pick<ImageConfig, "publicDir" | "root">,
): Promise<string> {
  const index = specifier.search(IMAGE_QUERY_PATTERN);
  const file = specifier.slice(0, index);
  const query = specifier.slice(index);
  let absolute: string;
  if (file.startsWith("/")) {
    absolute = path.join(config.publicDir, file);
  } else if (file.startsWith("./") || file.startsWith("../")) {
    absolute = path.resolve(importer ? path.dirname(importer) : config.root, file);
  } else {
    const resolved = await context.resolve(file, importer, { skipSelf: true });
    if (!resolved) throw new Error(`[sinwan/image] <Img> could not resolve "${file}"${importer ? ` from ${importer}` : ""}.`);
    absolute = resolved.id.split("?")[0] ?? resolved.id;
  }
  return `${IMAGE_ID_PREFIX}${absolute}${query}`;
}

/** Resolves image imports to virtual ids; `null` for anything else. */
export async function resolveImageImport(
  context: Pick<ImagePluginContext, "resolve">,
  id: string,
  importer: string | undefined,
  config: Pick<ImageConfig, "publicDir" | "root">,
): Promise<string | null> {
  if (id.startsWith("\0")) return null;
  if (IMAGE_FILE_PATTERN.test(id)) return `\0${id}`;
  if (IMAGE_QUERY_PATTERN.test(id)) return resolveImageId(context, id, importer, config);
  return null;
}

/**
 * Loads an image virtual id: the asset module (watching its source), or one
 * optimized file — emitted as a hashed asset in builds, a cache URL in dev.
 */
export async function loadImage(
  context: Pick<ImagePluginContext, "addWatchFile" | "emitFile">,
  id: string,
  config: ImageConfig,
  dev: { serve: boolean; base: string },
): Promise<string | null> {
  if (id.startsWith(IMAGE_ID_PREFIX)) {
    const target = id.slice(IMAGE_ID_PREFIX.length);
    context.addWatchFile(target.slice(0, target.search(IMAGE_QUERY_PATTERN)));
    return loadImageModule(target, config);
  }
  if (id.startsWith(IMAGE_FILE_ID_PREFIX)) {
    const file = id.slice(IMAGE_FILE_ID_PREFIX.length);
    const name = path.basename(file);
    if (dev.serve) return `export default ${JSON.stringify(`${dev.base}${DEV_IMAGE_SEGMENT}${name}`)};`;
    const reference = context.emitFile({ type: "asset", name, source: new Uint8Array(await readFile(file)) });
    return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
  }
  return null;
}

function requestPath(request: NodeRequest): string {
  return new URL(request.originalUrl ?? request.url ?? "/", "http://localhost").pathname;
}

/** Serves `<base>@sinwan-img/<hash>.<ext>` from the image cache (dev). */
export function cacheFileMiddleware(cacheDir: string): Middleware {
  return (request, response, next) => {
    const pathname = requestPath(request);
    if (!pathname.includes(`/${DEV_IMAGE_SEGMENT}`)) return next();
    const match = CACHE_FILE.exec(pathname);
    const send404 = () => {
      response.statusCode = 404;
      response.end();
    };
    if (!match) return send404();
    const [, name = "", extension = ""] = match;
    readFile(path.join(cacheDir, name)).then(
      (bytes) => {
        response.statusCode = 200;
        response.setHeader("Content-Type", MIME_BY_EXTENSION[extension] ?? "application/octet-stream");
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        response.end(new Uint8Array(bytes));
      },
      () => send404(),
    );
  };
}

/** Converts a connect request into a fetch `Request`. */
export function toFetchRequest(request: NodeRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(new URL(request.originalUrl ?? request.url ?? "/", "http://localhost"), {
    method: request.method ?? "GET",
    headers,
  });
}

/** Writes a fetch `Response` to a connect response. */
export async function sendFetchResponse(response: NodeResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(new Uint8Array(await result.arrayBuffer()));
}

/** Mounts `handler` at `route` (exact path) as connect middleware. */
export function handlerMiddleware(handler: ImageHandler, route: string): Middleware {
  return (request, response, next) => {
    if (requestPath(request) !== route) return next();
    handler(toFetchRequest(request)).then((result) => sendFetchResponse(response, result)).catch(next);
  };
}

/** Adds the dev middlewares: cached optimized files and the on-demand handler. */
export function mountDevImages(server: MiddlewareServer, config: ImageConfig, handlerPath = DEFAULT_IMAGE_PATH): void {
  server.middlewares.use(cacheFileMiddleware(config.cacheDir));
  server.middlewares.use(handlerMiddleware(createImageHandler(config), handlerPath));
}

/** Adds the on-demand handler to `vite preview`. */
export function mountPreviewImages(server: MiddlewareServer, config: ImageConfig, handlerPath = DEFAULT_IMAGE_PATH): void {
  server.middlewares.use(handlerMiddleware(createImageHandler(config), handlerPath));
}
