import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import BookCard from "./BookCard";

describe("library TTS regression guards", () => {
  it("renders a single primary action in BookCard with no TTS button", () => {
    const html = renderToStaticMarkup(
      <BookCard
        title="Sample"
        author="Author"
        genre="Science"
        description="Desc"
        progress={12}
        onRead={() => {}}
      />
    );

    expect((html.match(/<button/g) ?? []).length).toBe(1);
    expect(html).toContain(">Read<");
    expect(html.toLowerCase()).not.toContain(">tts<");
  });

  it("keeps Home page free of native TTS availability wiring", async () => {
    const homeSource = await Bun.file(new URL("../../pages/Home.tsx", import.meta.url)).text();

    expect(homeSource).not.toContain("isNativeTtsAvailable");
    expect(homeSource).not.toContain("ttsAvailable");
    expect(homeSource).not.toContain("tts={{");
  });
});
