import { describe, expect, it } from "bun:test";
import { deleteRawEpub, loadRawEpub, storeRawEpub, type RawEpubRecord } from "@/lib/import/rawEpubStore";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeRecord(bookId: string, text: string, storedAt: number): RawEpubRecord {
  return {
    bookId,
    fileName: `${bookId}.epub`,
    mimeType: "application/epub+zip",
    sizeBytes: text.length,
    bytes: encoder.encode(text),
    storedAt,
  };
}

describe("rawEpubStore", () => {
  it("keeps all in-memory records when indexedDB is unavailable", async () => {
    const prefix = `raw-no-idb-${Date.now()}`;
    const records = [
      makeRecord(`${prefix}-1`, "alpha", 1),
      makeRecord(`${prefix}-2`, "beta", 2),
      makeRecord(`${prefix}-3`, "gamma", 3),
    ];

    for (const record of records) {
      await storeRawEpub(record);
    }

    const loaded = await Promise.all(records.map((record) => loadRawEpub(record.bookId)));
    expect(loaded.every((entry) => entry !== null)).toBe(true);
    expect(decoder.decode(loaded[0]?.bytes)).toBe("alpha");
    expect(decoder.decode(loaded[1]?.bytes)).toBe("beta");
    expect(decoder.decode(loaded[2]?.bytes)).toBe("gamma");
  });

  it("returns cloned bytes so caller mutation does not leak into stored value", async () => {
    const bookId = `raw-clone-${Date.now()}`;
    await storeRawEpub(makeRecord(bookId, "immutable", Date.now()));

    const firstLoad = await loadRawEpub(bookId);
    expect(firstLoad).not.toBeNull();
    if (!firstLoad) return;

    firstLoad.bytes[0] = 0;
    const secondLoad = await loadRawEpub(bookId);
    expect(secondLoad).not.toBeNull();
    expect(decoder.decode(secondLoad?.bytes)).toBe("immutable");
  });

  it("removes stored records when deleteRawEpub is called", async () => {
    const bookId = `raw-delete-${Date.now()}`;
    await storeRawEpub(makeRecord(bookId, "to-delete", Date.now()));
    expect(await loadRawEpub(bookId)).not.toBeNull();

    await deleteRawEpub(bookId);

    expect(await loadRawEpub(bookId)).toBeNull();
  });
});
