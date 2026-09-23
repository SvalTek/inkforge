import { extname, join, normalize, sep } from "node:path";

export interface ServeOptions {
  root: string;
  port: number;
  hostname?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".lua": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function textHeaders(contentType: string): Headers {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  return headers;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: textHeaders("text/plain; charset=utf-8") });
}

function safeResolve(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relativePath = decoded.replace(/^[/\\]+/, "");
  const normalizedRoot = normalize(root);
  const resolved = normalize(join(normalizedRoot, relativePath));
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
    return null;
  }
  return resolved;
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function handleRequest(request: Request, root: string): Promise<Response> {
  const method = request.method;
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (method !== "GET" && method !== "HEAD") {
    log(method, pathname, 405);
    return textResponse("Method Not Allowed", 405);
  }

  let filePath = safeResolve(root, pathname);
  if (filePath === null) {
    log(method, pathname, 403);
    return textResponse("Forbidden", 403);
  }

  let info = await statOrNull(filePath);
  if (info?.isDirectory) {
    filePath = join(filePath, "index.html");
    info = await statOrNull(filePath);
  }

  if (info === null && extname(pathname) === "") {
    filePath = join(normalize(root), "index.html");
    info = await statOrNull(filePath);
  }

  if (info === null) {
    log(method, pathname, 404);
    return textResponse("Not Found", 404);
  }

  try {
    const body = await Deno.readFile(filePath);
    const headers = new Headers();
    headers.set("content-type", contentTypeFor(filePath));
    headers.set("cache-control", "no-store");
    headers.set("content-length", String(body.byteLength));
    log(method, pathname, 200);
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(body, { status: 200, headers });
  } catch (error) {
    log(method, pathname, 500);
    console.error(`Failed to read ${filePath}:`, error);
    return textResponse("Internal Server Error", 500);
  }
}

function log(method: string, pathname: string, status: number): void {
  console.log(`${method} ${pathname} -> ${status}`);
}

export function serveStatic(options: ServeOptions): { shutdown(): Promise<void>; port: number } {
  const root = normalize(options.root);
  const hostname = options.hostname ?? "127.0.0.1";
  const server: Deno.HttpServer = Deno.serve(
    {
      port: options.port,
      hostname,
      onListen: (addr) => {
        console.log(`Serving ${root} at http://${hostname}:${addr.port}/`);
      },
    },
    (request) => handleRequest(request, root),
  );

  const addr: Deno.Addr = server.addr;
  const port: number = "port" in addr ? addr.port : options.port;

  return {
    port,
    shutdown: () => server.shutdown(),
  };
}
