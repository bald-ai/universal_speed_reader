export const MAX_COVER_FILE_BYTES = 5 * 1024 * 1024;
export const MIN_COVER_WIDTH = 120;
export const MIN_COVER_HEIGHT = 160;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export type CoverValidationErrorCode =
  | "unsupported_format"
  | "file_too_large"
  | "file_empty"
  | "decode_failed"
  | "dimensions_too_small";

export class CoverValidationError extends Error {
  readonly code: CoverValidationErrorCode;

  constructor(code: CoverValidationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CoverValidationError";
  }
}

export type CoverValidationResult = {
  dataUrl: string;
  width: number;
  height: number;
};

type CoverValidationOptions = {
  decodeImage?: (blob: Blob) => Promise<{ width: number; height: number }>;
  readAsDataUrl?: (file: File) => Promise<string>;
};

function fileExtension(name: string): string {
  const normalized = name.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return normalized.slice(dotIndex);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoder is unavailable");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readFileAsDataUrl(file: File): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read selected file"));
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Failed to read selected file"));
          return;
        }
        resolve(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const base64 = bytesToBase64(bytes);
  return `data:${mimeType};base64,${base64}`;
}

async function decodeImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    const result = { width: bitmap.width, height: bitmap.height };
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
    return result;
  }

  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Image decoding is unavailable");
  }

  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const result = {
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      };
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to decode image"));
    };
    image.src = objectUrl;
  });
}

function isAllowedFormat(file: File): boolean {
  const mimeType = file.type.trim().toLowerCase();
  if (ALLOWED_MIME_TYPES.has(mimeType)) return true;
  return ALLOWED_EXTENSIONS.has(fileExtension(file.name));
}

function toCoverValidationError(error: unknown): CoverValidationError {
  if (error instanceof CoverValidationError) {
    return error;
  }
  return new CoverValidationError("decode_failed", "Could not read this image file.");
}

export function getCoverValidationErrorMessage(code: CoverValidationErrorCode): string {
  if (code === "unsupported_format") return "Use JPG, PNG, or WEBP.";
  if (code === "file_too_large") return "Cover must be 5MB or smaller.";
  if (code === "file_empty") return "Could not read this image file.";
  if (code === "decode_failed") return "Could not read this image file.";
  return "Image must be at least 120×160.";
}

export async function validateAndReadCoverFile(
  file: File,
  options?: CoverValidationOptions
): Promise<CoverValidationResult> {
  if (file.size <= 0) {
    throw new CoverValidationError("file_empty", getCoverValidationErrorMessage("file_empty"));
  }
  if (file.size > MAX_COVER_FILE_BYTES) {
    throw new CoverValidationError("file_too_large", getCoverValidationErrorMessage("file_too_large"));
  }
  if (!isAllowedFormat(file)) {
    throw new CoverValidationError("unsupported_format", getCoverValidationErrorMessage("unsupported_format"));
  }

  const readDataUrl = options?.readAsDataUrl ?? readFileAsDataUrl;
  const decode = options?.decodeImage ?? decodeImageDimensions;

  try {
    const [dataUrl, dimensions] = await Promise.all([readDataUrl(file), decode(file)]);
    if (dimensions.width < MIN_COVER_WIDTH || dimensions.height < MIN_COVER_HEIGHT) {
      throw new CoverValidationError(
        "dimensions_too_small",
        getCoverValidationErrorMessage("dimensions_too_small")
      );
    }
    return {
      dataUrl,
      width: dimensions.width,
      height: dimensions.height,
    };
  } catch (error) {
    throw toCoverValidationError(error);
  }
}
