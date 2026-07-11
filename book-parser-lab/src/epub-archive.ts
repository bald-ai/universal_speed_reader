import { posix } from "node:path";

import { unzipSync } from "fflate";

import { decodeSafeUriComponent } from "./text.ts";
import { EpubParseError } from "./epub-shared.ts";

interface ArchiveEntryInfo {
  name: string;
  uncompressedSize: number;
}

export interface ParsedReference {
  path: string | null;
  fragment: string | null;
  dataUrl: string | null;
}

/** ZIP reader that inflates only requested markup/SVG entries, never raster assets. */
export class SelectiveZipArchive {
  readonly entries = new Map<string, ArchiveEntryInfo>();
  private readonly lowerCaseNames = new Map<string, string>();
  private readonly decodedNames = new Map<string, string>();
  private readonly cache = new Map<string, Uint8Array>();

  constructor(private readonly bytes: Uint8Array) {
    const initial = unzipSync(bytes, {
      filter: (entry) => {
        const name = normalizeArchivePath(entry.name);
        if (name.length === 0 || name.endsWith("/")) return false;
        if (!this.entries.has(name)) {
          this.entries.set(name, { name, uncompressedSize: entry.originalSize });
          this.lowerCaseNames.set(name.toLocaleLowerCase(), name);
          this.decodedNames.set(
            normalizeArchivePath(decodeSafeUriComponent(name)).toLocaleLowerCase(),
            name,
          );
        }
        const lower = name.toLocaleLowerCase();
        return lower === "meta-inf/container.xml" || lower === "mimetype";
      },
    });
    for (const [name, value] of Object.entries(initial)) {
      this.cache.set(normalizeArchivePath(name), value);
    }
  }

  resolve(path: string): string | null {
    const normalized = normalizeArchivePath(path);
    if (this.entries.has(normalized)) return normalized;
    const lower = normalized.toLocaleLowerCase();
    return this.lowerCaseNames.get(lower) ?? this.decodedNames.get(lower) ?? null;
  }

  read(path: string, maximumBytes: number): Uint8Array {
    const resolved = this.resolve(path);
    if (resolved === null) {
      throw new EpubParseError("Crash", `ZIP entry is missing: ${path}`);
    }
    const info = this.entries.get(resolved);
    if (info !== undefined && info.uncompressedSize > maximumBytes) {
      throw new EpubParseError(
        "Timeout / extreme slowness",
        `ZIP entry is unreasonably large: ${resolved} (${info.uncompressedSize} bytes)`,
      );
    }
    const cached = this.cache.get(resolved);
    if (cached !== undefined) return cached;
    this.readMany([resolved], maximumBytes);
    const extracted = this.cache.get(resolved);
    if (extracted === undefined) {
      throw new EpubParseError("Crash", `Unable to decompress ZIP entry: ${resolved}`);
    }
    return extracted;
  }

  readMany(paths: Iterable<string>, maximumTotalBytes: number): void {
    const wanted = new Set<string>();
    let totalBytes = 0;
    for (const path of paths) {
      const resolved = this.resolve(path);
      if (resolved === null || this.cache.has(resolved)) continue;
      totalBytes += this.entries.get(resolved)?.uncompressedSize ?? 0;
      if (totalBytes > maximumTotalBytes) {
        throw new EpubParseError(
          "Timeout / extreme slowness",
          `EPUB text resources exceed the ${maximumTotalBytes}-byte safety limit`,
        );
      }
      wanted.add(resolved);
    }
    if (wanted.size === 0) return;

    const extracted = unzipSync(this.bytes, {
      filter: (entry) => wanted.has(normalizeArchivePath(entry.name)),
    });
    for (const [name, value] of Object.entries(extracted)) {
      this.cache.set(normalizeArchivePath(name), value);
    }
  }
}

export function parseReference(basePath: string, rawReference: string): ParsedReference {
  const value = rawReference.trim().replace(/^['"]|['"]$/gu, "");
  if (/^data:image\//iu.test(value)) {
    return { path: null, fragment: null, dataUrl: value };
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith("//")) {
    return { path: null, fragment: null, dataUrl: null };
  }
  const hashIndex = value.indexOf("#");
  const pathAndQuery = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawFragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
  const queryIndex = pathAndQuery.indexOf("?");
  const rawPath = queryIndex >= 0 ? pathAndQuery.slice(0, queryIndex) : pathAndQuery;
  const decodedPath = decodeSafeUriComponent(rawPath).replaceAll("\\", "/");
  const baseDirectory = posix.dirname(normalizeArchivePath(basePath));
  const joined = decodedPath.length === 0
    ? normalizeArchivePath(basePath)
    : normalizeArchivePath(
        decodedPath.startsWith("/")
          ? decodedPath.slice(1)
          : posix.join(baseDirectory === "." ? "" : baseDirectory, decodedPath),
      );
  if (joined.startsWith("../") || joined === "..") {
    return { path: null, fragment: null, dataUrl: null };
  }
  return {
    path: joined,
    fragment: rawFragment ? decodeSafeUriComponent(rawFragment) : null,
    dataUrl: null,
  };
}

export function normalizeArchivePath(value: string): string {
  const replaced = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = posix.normalize(replaced);
  return normalized === "." ? "" : normalized.normalize("NFC");
}

export function decodeMarkup(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  const probe = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const declared = /encoding\s*=\s*["']([^"']+)["']/iu.exec(probe)?.[1];
  if (declared && !/^utf-?8$/iu.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // A bad declaration should not make otherwise valid UTF-8 unreadable.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function checkDeadline(deadline: number, configuredTimeoutMs: number): void {
  if (performance.now() <= deadline) return;
  throw new EpubParseError(
    "Timeout / extreme slowness",
    `EPUB parsing exceeded ${Math.round(configuredTimeoutMs)} ms`,
  );
}
