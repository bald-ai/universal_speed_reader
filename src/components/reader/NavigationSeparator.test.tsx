import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import NavigationSeparator from "./NavigationSeparator";

describe("NavigationSeparator", () => {
  it("renders distinct accessible semantics for chapters, parts, sections, and named scenes", () => {
    const chapter = renderToStaticMarkup(<NavigationSeparator kind="chapter" />);
    const part = renderToStaticMarkup(<NavigationSeparator kind="part" />);
    const section = renderToStaticMarkup(<NavigationSeparator kind="section" />);
    const scene = renderToStaticMarkup(<NavigationSeparator kind="scene" />);
    const frontmatter = renderToStaticMarkup(<NavigationSeparator kind="frontmatter" />);

    expect(chapter).toContain('aria-label="Chapter boundary"');
    expect(part).toContain('aria-label="Part boundary"');
    expect(section).toContain('aria-label="Section boundary"');
    expect(scene).toContain('aria-label="Named scene boundary"');
    expect(scene).toContain("◇");
    expect(scene).not.toContain("⁂");
    expect(frontmatter).toContain('aria-label="Front matter boundary"');
  });
});
