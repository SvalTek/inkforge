export function resolveProjectPath(raw: string, from: string): string {
  const stack = (raw.startsWith("/") ? [] : from.split("/").slice(0, -1)).concat(
    raw.replace(/^\//, "").split("/"),
  );
  const out: string[] = [];
  for (const part of stack) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) throw Error(`Import escapes project root: ${raw}`);
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}
