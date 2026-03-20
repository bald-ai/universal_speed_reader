import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SpeedReadingWpmSetting from "./SpeedReadingWpmSetting";

describe("SpeedReadingWpmSetting", () => {
  it("renders the settings slider with 5 WPM increments", () => {
    const html = renderToStaticMarkup(
      <SpeedReadingWpmSetting wpm={255} onChange={() => {}} />
    );

    expect(html).toContain('type="range"');
    expect(html).toContain('min="100"');
    expect(html).toContain('max="600"');
    expect(html).toContain('step="5"');
    expect(html).toContain('value="255"');
    expect(html).toContain("255 WPM");
  });
});
