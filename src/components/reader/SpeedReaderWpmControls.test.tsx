import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SpeedReaderWpmControls from "./SpeedReaderWpmControls";

describe("SpeedReaderWpmControls", () => {
  it("shows fixed WPM controls while playing", () => {
    const html = renderToStaticMarkup(
      <SpeedReaderWpmControls
        wpm={260}
        isPaused={false}
        onDecrease={() => {}}
        onIncrease={() => {}}
        onPause={() => {}}
        onResume={() => {}}
      />
    );

    expect(html).toContain('data-testid="speed-reader-wpm-down"');
    expect(html).toContain('data-testid="speed-reader-wpm-up"');
    expect(html).toContain("Pause speed reader");
    expect(html).toContain(">260<");
    expect(html).not.toContain("Resume speed reader");
  });

  it("keeps the same WPM controls visible while paused", () => {
    const html = renderToStaticMarkup(
      <SpeedReaderWpmControls
        wpm={260}
        isPaused
        onDecrease={() => {}}
        onIncrease={() => {}}
        onPause={() => {}}
        onResume={() => {}}
      />
    );

    expect(html).toContain('data-testid="speed-reader-wpm-down"');
    expect(html).toContain('data-testid="speed-reader-wpm-up"');
    expect(html).toContain("Resume speed reader");
    expect(html).not.toContain(">Read<");
    expect(html).toContain(">260<");
    expect(html).not.toContain("Pause speed reader");
  });
});
