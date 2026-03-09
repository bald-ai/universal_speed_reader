const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;

type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function normalizeLookupPath(path: string): string {
  const sanitized = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  const rawParts = sanitized.split("/");
  const parts: string[] = [];

  for (const part of rawParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join("/").toLowerCase();
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function inflateRaw(bytes: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Unsupported format: this device cannot decompress EPUB archives");
  }
  const byteSlice = bytes.slice();
  const stream = new Blob([byteSlice]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value ?? new Uint8Array();
    total += chunk.byteLength;
    if (total > maxOutputBytes) {
      await reader.cancel("Entry exceeded uncompressed size limit");
      throw new Error("Corrupted/Unreadable EPUB: entry exceeds uncompressed size limit");
    }
    chunks.push(chunk);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createSubArray(source: Uint8Array, offset: number, length: number): Uint8Array {
  return source.subarray(offset, offset + length);
}

function findEndOfCentralDirectory(view: DataView, bytesLength: number): number {
  const minOffset = Math.max(0, bytesLength - 65557);
  for (let offset = bytesLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

export class ZipArchive {
  private readonly bytes: Uint8Array;
  private readonly entriesByKey: Map<string, ZipEntry>;
  private readonly entriesByName: Map<string, ZipEntry>;
  private readonly extractedBytesByEntry = new Map<string, number>();
  private totalExtractedBytes = 0;

  private constructor(bytes: Uint8Array, entries: ZipEntry[]) {
    this.bytes = bytes;
    this.entriesByKey = new Map<string, ZipEntry>();
    this.entriesByName = new Map<string, ZipEntry>();
    for (const entry of entries) {
      this.entriesByName.set(entry.name, entry);
      this.entriesByKey.set(normalizeLookupPath(entry.name), entry);
    }
  }

  static fromArrayBuffer(buffer: ArrayBuffer): ZipArchive {
    return ZipArchive.fromBytes(new Uint8Array(buffer));
  }

  static fromBytes(bytes: Uint8Array): ZipArchive {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findEndOfCentralDirectory(view, bytes.length);
    if (eocdOffset === -1) {
      throw new Error("Corrupted/Unreadable EPUB: missing end-of-central-directory");
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const centralDirOffset = view.getUint32(eocdOffset + 16, true);

    const entries: ZipEntry[] = [];
    let cursor = centralDirOffset;

    for (let i = 0; i < totalEntries; i += 1) {
      if (cursor + 46 > bytes.length) {
        throw new Error("Corrupted/Unreadable EPUB: invalid central directory bounds");
      }
      const signature = view.getUint32(cursor, true);
      if (signature !== CENTRAL_DIR_SIGNATURE) {
        throw new Error("Corrupted/Unreadable EPUB: invalid central directory header");
      }

      const compressionMethod = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const fileNameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localHeaderOffset = view.getUint32(cursor + 42, true);

      const fileNameOffset = cursor + 46;
      const fileNameBytes = createSubArray(bytes, fileNameOffset, fileNameLength);
      const name = decodeUtf8(fileNameBytes);

      entries.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });

      cursor += 46 + fileNameLength + extraLength + commentLength;
    }

    return new ZipArchive(bytes, entries);
  }

  has(path: string): boolean {
    return this.lookupEntry(path) !== null;
  }

  listEntries(): string[] {
    return [...this.entriesByName.keys()].sort();
  }

  async readEntryBytes(path: string): Promise<Uint8Array> {
    const entry = this.lookupEntry(path);
    if (!entry) {
      throw new Error(`Corrupted/Unreadable EPUB: missing entry ${path}`);
    }

    const localHeaderOffset = entry.localHeaderOffset;
    if (localHeaderOffset + 30 > this.bytes.length) {
      throw new Error(`Corrupted/Unreadable EPUB: invalid local header for ${entry.name}`);
    }

    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const signature = view.getUint32(localHeaderOffset, true);
    if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Corrupted/Unreadable EPUB: invalid local file header for ${entry.name}`);
    }

    const fileNameLength = view.getUint16(localHeaderOffset + 26, true);
    const extraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;

    if (dataOffset < 0 || dataEnd > this.bytes.length) {
      throw new Error(`Corrupted/Unreadable EPUB: invalid compressed data bounds for ${entry.name}`);
    }

    const compressedData = createSubArray(this.bytes, dataOffset, entry.compressedSize);
    const maxBytesForThisRead = this.getMaxBytesForEntryRead(entry.name);
    if (entry.uncompressedSize > maxBytesForThisRead) {
      throw new Error(`Corrupted/Unreadable EPUB: entry ${entry.name} exceeds uncompressed size limit`);
    }

    if (entry.compressionMethod === 0) {
      if (compressedData.byteLength > maxBytesForThisRead) {
        throw new Error(`Corrupted/Unreadable EPUB: entry ${entry.name} exceeds uncompressed size limit`);
      }
      this.commitExtractedSize(entry.name, compressedData.byteLength);
      return compressedData;
    }
    if (entry.compressionMethod === 8) {
      const inflated = await inflateRaw(compressedData, maxBytesForThisRead);
      if (
        entry.uncompressedSize > 0 &&
        inflated.byteLength !== entry.uncompressedSize
      ) {
        // Keep processing even when archive metadata is imperfect.
        this.commitExtractedSize(entry.name, inflated.byteLength);
        return inflated;
      }
      this.commitExtractedSize(entry.name, inflated.byteLength);
      return inflated;
    }

    throw new Error(`Corrupted/Unreadable EPUB: unsupported compression method ${entry.compressionMethod}`);
  }

  async readEntryText(path: string): Promise<string> {
    const data = await this.readEntryBytes(path);
    return decodeUtf8(data);
  }

  private lookupEntry(path: string): ZipEntry | null {
    const exact = this.entriesByName.get(path);
    if (exact) return exact;

    const normalized = normalizeLookupPath(path);
    const byKey = this.entriesByKey.get(normalized);
    if (byKey) return byKey;

    return null;
  }

  private getMaxBytesForEntryRead(entryName: string): number {
    const previousSize = this.extractedBytesByEntry.get(entryName) ?? 0;
    const remainingTotalBudget = MAX_TOTAL_UNCOMPRESSED_BYTES - this.totalExtractedBytes + previousSize;
    if (remainingTotalBudget <= 0) {
      throw new Error("Corrupted/Unreadable EPUB: archive exceeds uncompressed size limit");
    }
    return Math.min(MAX_ENTRY_UNCOMPRESSED_BYTES, remainingTotalBudget);
  }

  private commitExtractedSize(entryName: string, byteLength: number): void {
    if (byteLength > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(`Corrupted/Unreadable EPUB: entry ${entryName} exceeds uncompressed size limit`);
    }

    const previousSize = this.extractedBytesByEntry.get(entryName) ?? 0;
    const delta = byteLength - previousSize;
    if (delta <= 0) return;

    const nextTotal = this.totalExtractedBytes + delta;
    if (nextTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("Corrupted/Unreadable EPUB: archive exceeds uncompressed size limit");
    }

    this.totalExtractedBytes = nextTotal;
    this.extractedBytesByEntry.set(entryName, byteLength);
  }
}
