import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import NormalReaderToolbar from "./NormalReaderToolbar";

const handlers = {
  onBack: () => undefined,
  onChapterAction: () => undefined,
  onSettings: () => undefined,
};

function render(state: "edge" | "expanded" | "hidden", progressPercent: number | null = 4): string {
  return renderToStaticMarkup(
    <NormalReaderToolbar
      state={state}
      chapterTitle="Letter 3"
      progressPercent={progressPercent}
      progressGradient={{ from: "#111", via: "#222", to: "#333" }}
      {...handlers}
    />
  );
}

describe("NormalReaderToolbar", () => {
  it("keeps the chapter and progress visible in the focused edge state", () => {
    const html = render("edge");

    expect(html).toContain('data-state="edge"');
    expect(html).toContain("Letter 3");
    expect(html).toContain("4%");
    expect(html).toContain('aria-label="Expand reader controls"');
    expect(html).toContain('data-presentation="quiet"');
    expect(html).toContain('data-visible="true"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("exposes navigation controls only in the expanded state", () => {
    const html = render("expanded");

    expect(html).toContain('data-state="expanded"');
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('aria-label="Open chapter navigation"');
    expect(html).toContain('data-presentation="centered"');
    expect(html).toContain('data-chrome="flat"');
    expect(html).toContain("left-1/2");
    expect(html).not.toContain("chapter-menu-indicator");
    expect(html).not.toContain("bg-neutral-800/70");
    expect(html).toContain('data-visible="false"');
    expect(html).toContain("opacity-0");
    expect(html).not.toContain('tabindex="-1"');
  });

  it("can hide the toolbar for an active TTS session", () => {
    const html = render("hidden", null);

    expect(html).toContain('data-state="hidden"');
    expect(html).toContain("h-0");
    expect(html).not.toContain("4%");
  });
});
