import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ChapterMenu from "./ChapterMenu";

describe("ChapterMenu hierarchy", () => {
  it("labels and indents parts, chapters, sections, and named scenes", () => {
    const html = renderToStaticMarkup(
      <ChapterMenu
        isOpen
        chapters={[
          { index: 0, title: "Part One", startParagraphId: 1, kind: "part", level: 1 },
          { index: 1, title: "Chapter One", startParagraphId: 2, kind: "chapter", level: 2 },
          { index: 2, title: "A smaller section", startParagraphId: 3, kind: "section", level: 3 },
          { index: 3, title: "SCENE I", startParagraphId: 4, kind: "scene", level: 4 },
        ]}
        currentChapterIndex={3}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );

    expect(html).toContain("Book navigation");
    expect(html).toContain("Part");
    expect(html).toContain("Chapter");
    expect(html).toContain("Section");
    expect(html).toContain("Scene");
    expect(html).toContain("padding-left:72px");
  });
});
