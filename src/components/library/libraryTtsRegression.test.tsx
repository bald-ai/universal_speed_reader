import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import BookCard from "./BookCard";

describe("library TTS regression guards", () => {
  it("renders read and edit actions in BookCard with no TTS button", () => {
    const html = renderToStaticMarkup(
      <BookCard
        title="Sample"
        author="Author"
        genre="Science"
        description="Desc"
        progress={12}
        onRead={() => {}}
        onEdit={() => {}}
      />
    );

    expect((html.match(/<button/g) ?? []).length).toBe(3);
    expect(html).toContain("Sample");
    expect(html).toContain("More actions");
    expect(html.toLowerCase()).not.toContain(">tts<");
  });

  it("keeps Home page free of native TTS availability wiring", async () => {
    const homeSource = await Bun.file(new URL("../../pages/Home.tsx", import.meta.url)).text();

    expect(homeSource).not.toContain("isNativeTtsAvailable");
    expect(homeSource).not.toContain("ttsAvailable");
    expect(homeSource).not.toContain("tts={{");
  });

  it("uses closed-book placeholder when missing cover and progress is at start", () => {
    const html = renderToStaticMarkup(
      <BookCard
        title="No Cover"
        author="Author"
        genre="Science"
        description="Desc"
        progress={0}
        onRead={() => {}}
      />
    );

    expect(html).toContain("/placeholders/closed-book.png");
  });

  it("uses open-book placeholder when missing cover and progress is above start", () => {
    const html = renderToStaticMarkup(
      <BookCard
        title="Started Book"
        author="Author"
        genre="Science"
        description="Desc"
        progress={37}
        onRead={() => {}}
      />
    );

    expect(html).toContain("/placeholders/open-book.png");
  });
});
