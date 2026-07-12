import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SceneSeparator from "./SceneSeparator";

describe("SceneSeparator", () => {
  it("exposes one semantic transition while hiding decorative glyphs", () => {
    const html = renderToStaticMarkup(<SceneSeparator />);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Scene break"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("tabindex");
  });
});
