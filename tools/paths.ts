import { dirname, join } from "node:path";

const toolsDir: string | undefined = import.meta.dirname;

if (typeof toolsDir !== "string" || toolsDir.length === 0) {
  throw new Error(
    "Unable to resolve the tools directory: import.meta.dirname is undefined. Run these tools with Deno 2.x or newer.",
  );
}

export const ROOT: string = dirname(toolsDir);
export const DIST: string = join(ROOT, "dist");
export const SRC: string = join(ROOT, "src");
export const STYLES: string = join(ROOT, "styles");
export const TEMPLATES: string = join(ROOT, "templates");
export const INDEX_HTML: string = join(ROOT, "index.html");
