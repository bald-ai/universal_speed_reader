import { describe, expect, it } from "bun:test";
import {
  CoverValidationError,
  MAX_COVER_FILE_BYTES,
  getCoverValidationErrorMessage,
  validateAndReadCoverFile,
} from "@/lib/library/coverUploadValidation";

const readAsDataUrl = async () => "data:image/png;base64,AAAA";

describe("coverUploadValidation", () => {
  it("accepts valid jpeg/png/webp inputs when image dimensions are large enough", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.jpg", { type: "image/jpeg" });
    const result = await validateAndReadCoverFile(file, {
      readAsDataUrl,
      decodeImage: async () => ({ width: 400, height: 600 }),
    });
    expect(result.dataUrl).toContain("data:image/");
    expect(result.width).toBe(400);
    expect(result.height).toBe(600);
  });

  it("accepts extension fallback when mime type is incorrect", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.webp", { type: "text/plain" });
    const result = await validateAndReadCoverFile(file, {
      readAsDataUrl,
      decodeImage: async () => ({ width: 200, height: 300 }),
    });
    expect(result.width).toBe(200);
  });

  it("rejects unsupported formats with expected message mapping", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.gif", { type: "image/gif" });
    await expect(
      validateAndReadCoverFile(file, {
        readAsDataUrl,
        decodeImage: async () => ({ width: 200, height: 300 }),
      })
    ).rejects.toMatchObject({
      code: "unsupported_format",
      message: getCoverValidationErrorMessage("unsupported_format"),
    } as Partial<CoverValidationError>);
  });

  it("rejects oversized files", async () => {
    const file = new File(
      [new Uint8Array(MAX_COVER_FILE_BYTES + 1)],
      "cover.jpg",
      { type: "image/jpeg" }
    );
    await expect(
      validateAndReadCoverFile(file, {
        readAsDataUrl,
        decodeImage: async () => ({ width: 200, height: 300 }),
      })
    ).rejects.toMatchObject({
      code: "file_too_large",
      message: getCoverValidationErrorMessage("file_too_large"),
    } as Partial<CoverValidationError>);
  });

  it("rejects zero-byte files", async () => {
    const file = new File([], "empty.png", { type: "image/png" });
    await expect(
      validateAndReadCoverFile(file, {
        readAsDataUrl,
        decodeImage: async () => ({ width: 200, height: 300 }),
      })
    ).rejects.toMatchObject({
      code: "file_empty",
      message: getCoverValidationErrorMessage("file_empty"),
    } as Partial<CoverValidationError>);
  });

  it("rejects decode failures", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.jpg", { type: "image/jpeg" });
    await expect(
      validateAndReadCoverFile(file, {
        readAsDataUrl,
        decodeImage: async () => {
          throw new Error("boom");
        },
      })
    ).rejects.toMatchObject({
      code: "decode_failed",
      message: getCoverValidationErrorMessage("decode_failed"),
    } as Partial<CoverValidationError>);
  });

  it("rejects images with small dimensions", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.jpg", { type: "image/jpeg" });
    await expect(
      validateAndReadCoverFile(file, {
        readAsDataUrl,
        decodeImage: async () => ({ width: 100, height: 159 }),
      })
    ).rejects.toMatchObject({
      code: "dimensions_too_small",
      message: getCoverValidationErrorMessage("dimensions_too_small"),
    } as Partial<CoverValidationError>);
  });
});
