import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SpeedReaderTempoPanel from "./SpeedReaderTempoPanel";
import { DEFAULT_SPEED_READER_TEMPO } from "@/lib/reader/speedReaderTempo";

describe("SpeedReaderTempoPanel", () => {
  it("renders all tempo controls with their test ids and summary values", () => {
    const html = renderToStaticMarkup(
      <SpeedReaderTempoPanel
        baseWpm={300}
        tempo={DEFAULT_SPEED_READER_TEMPO}
        onChange={() => {}}
      />
    );

    expect(html).toContain("Speed reader tempo");
    expect(html).toContain('data-testid="speed-reader-comma-break"');
    expect(html).toContain('data-testid="speed-reader-semicolon-break"');
    expect(html).toContain('data-testid="speed-reader-sentence-break"');
    expect(html).toContain('data-testid="speed-reader-paragraph-break"');
    expect(html).toContain('data-testid="speed-reader-chapter-break"');
    expect(html).toContain('data-testid="speed-reader-long-word-assist"');
    expect(html).toContain('data-testid="speed-reader-chapter-slowdown"');
    expect(html).toContain('data-testid="speed-reader-chapter-ramp-words"');
    expect(html).toContain(">30 ms<");
    expect(html).toContain(">60 ms<");
    expect(html).toContain(">180 ms<");
    expect(html).toContain(">425 ms<");
    expect(html).toContain("20 ms at 10 letters");
    expect(html).toContain("255 to 300 WPM");
    expect(html).toContain("Reset");
  });

  it("renders custom tempo values and chapter ramp preview text", () => {
    const html = renderToStaticMarkup(
      <SpeedReaderTempoPanel
        baseWpm={360}
        tempo={{
          commaBreakMs: 40,
          semicolonBreakMs: 50,
          sentenceBreakMs: 90,
          paragraphBreakMs: 260,
          chapterBreakMs: 900,
          longWordDelayMsAtTenLetters: 35,
          chapterStartSlowdownPercent: 10,
          chapterRampWords: 12,
        }}
        onChange={() => {}}
      />
    );

    expect(html).toContain(">40 ms<");
    expect(html).toContain(">50 ms<");
    expect(html).toContain(">90 ms<");
    expect(html).toContain(">260 ms<");
    expect(html).toContain(">900 ms<");
    expect(html).toContain("35 ms at 10 letters");
    expect(html).toContain(">14 ms<");
    expect(html).toContain(">49 ms<");
    expect(html).toContain("324 to 360 WPM");
    expect(html).toContain(">12 words<");
    expect(html).toContain(">10%<");
  });
});
