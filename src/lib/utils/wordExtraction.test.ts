import { describe, expect, it } from "bun:test";
import { tokenizeParagraph } from "./wordExtraction";

describe("tokenizeParagraph", () => {
  it("splits words by mixed whitespace", () => {
    expect(tokenizeParagraph("alpha   beta\tgamma\ndelta")).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  it("strips surrounding single and double quotes", () => {
    expect(tokenizeParagraph(`"hello" 'world' ""quoted"" ''test''`)).toEqual([
      "hello",
      "world",
      "quoted",
      "test",
    ]);
  });

  it("keeps inner punctuation and apostrophes", () => {
    expect(tokenizeParagraph("can't end-to-end mother-in-law")).toEqual([
      "can't",
      "end-to-end",
      "mother-in-law",
    ]);
  });

  it("drops empty results after quote stripping", () => {
    expect(tokenizeParagraph(` ""   ''   "ok" `)).toEqual(["ok"]);
  });
});
