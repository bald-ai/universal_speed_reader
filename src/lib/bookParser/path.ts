/** Small POSIX-only path helpers so the parser runs in browsers and Capacitor. */
export function basename(path: string, extension = ""): string {
  const normalized = path.replace(/\\/gu, "/");
  const lastSegment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return extension.length > 0 && lastSegment.toLowerCase().endsWith(extension.toLowerCase())
    ? lastSegment.slice(0, -extension.length)
    : lastSegment;
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

export function dirname(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : index === 0 ? "/" : normalized.slice(0, index);
}

export function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.replace(/\\/gu, "/").split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

export function joinPosixPath(...paths: string[]): string {
  return normalizePosixPath(paths.filter((path) => path.length > 0).join("/"));
}
