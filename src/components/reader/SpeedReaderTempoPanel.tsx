import { motion } from "framer-motion";
import {
  DEFAULT_SPEED_READER_TEMPO,
  INITIAL_SPEED_READER_RAMP_WORDS,
  INITIAL_SPEED_READER_SLOWDOWN_PERCENT,
  LONG_WORD_ASSIST_MIN_LENGTH,
  LONG_WORD_ASSIST_REFERENCE_LENGTH,
  normalizeSpeedReaderTempo,
  SPEED_READER_TEMPO_LIMITS,
  type SpeedReaderTempoSettings,
} from "@/lib/reader/speedReaderTempo";

type SpeedReaderTempoPanelProps = {
  baseWpm: number;
  tempo: SpeedReaderTempoSettings;
  onChange: (next: SpeedReaderTempoSettings) => void;
};

type TempoSliderProps = {
  label: string;
  helper: string;
  valueLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  testId: string;
  onChange: (value: number) => void;
};

function TempoSlider(props: TempoSliderProps) {
  const { label, helper, valueLabel, value, min, max, step, testId, onChange } = props;

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-950/60 p-3.5">
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-neutral-100">{label}</div>
          <p className="mt-1 text-[11px] leading-5 text-neutral-500">{helper}</p>
        </div>
        <motion.span
          key={`${label}-${value}`}
          initial={{ scale: 1.12, color: "#c4b5fd" }}
          animate={{ scale: 1, color: "#c4b5fd" }}
          className="shrink-0 rounded-full border border-violet-400/20 bg-violet-500/10 px-2 py-1 text-[11px] font-semibold text-violet-300"
        >
          {valueLabel}
        </motion.span>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full h-2 cursor-pointer appearance-none rounded-lg bg-neutral-800
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:h-4
          [&::-webkit-slider-thumb]:w-4
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-violet-500
          [&::-webkit-slider-thumb]:shadow-lg
          [&::-webkit-slider-thumb]:shadow-violet-500/30
          [&::-webkit-slider-thumb]:transition-transform
          [&::-webkit-slider-thumb]:hover:scale-110
          [&::-moz-range-thumb]:h-4
          [&::-moz-range-thumb]:w-4
          [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0
          [&::-moz-range-thumb]:bg-violet-500"
      />
    </div>
  );
}

export default function SpeedReaderTempoPanel(props: SpeedReaderTempoPanelProps) {
  const { baseWpm, tempo, onChange } = props;

  const updateTempo = (partial: Partial<SpeedReaderTempoSettings>) => {
    onChange(
      normalizeSpeedReaderTempo({
        ...tempo,
        ...partial,
      })
    );
  };

  const startupPreviewWpm = Math.max(
    1,
    Math.round(baseWpm * (1 - INITIAL_SPEED_READER_SLOWDOWN_PERCENT / 100))
  );
  const chapterPreviewWpm = Math.max(
    1,
    Math.round(baseWpm * (1 - tempo.chapterStartSlowdownPercent / 100))
  );
  const shortWordPreviewMs = Math.round(
    (tempo.longWordDelayMsAtTenLetters * LONG_WORD_ASSIST_MIN_LENGTH) / LONG_WORD_ASSIST_REFERENCE_LENGTH
  );
  const longWordPreviewMs = Math.round(
    (tempo.longWordDelayMsAtTenLetters * 14) / LONG_WORD_ASSIST_REFERENCE_LENGTH
  );

  return (
    <section className="rounded-[24px] border border-violet-500/20 bg-[radial-gradient(circle_at_top,rgba(139,92,246,0.16),transparent_55%),linear-gradient(180deg,rgba(23,23,23,0.98),rgba(10,10,10,0.98))] p-4 shadow-[0_16px_50px_rgba(0,0,0,0.35)]">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold tracking-tight text-neutral-100">Speed reader tempo</div>
          <p className="mt-1 max-w-[26rem] text-[11px] leading-5 text-neutral-400">
            Shape punctuation and structural pauses without changing your base WPM.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange(DEFAULT_SPEED_READER_TEMPO)}
          className="shrink-0 rounded-full border border-neutral-700 bg-neutral-900/70 px-3 py-1.5 text-[11px] font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
        >
          Reset
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Comma</div>
          <div className="mt-1 text-sm font-semibold text-neutral-100">{tempo.commaBreakMs} ms</div>
        </div>
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Semicolon</div>
          <div className="mt-1 text-sm font-semibold text-neutral-100">{tempo.semicolonBreakMs} ms</div>
        </div>
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Sentence</div>
          <div className="mt-1 text-sm font-semibold text-neutral-100">{tempo.sentenceBreakMs} ms</div>
        </div>
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Paragraph</div>
          <div className="mt-1 text-sm font-semibold text-neutral-100">{tempo.paragraphBreakMs} ms</div>
        </div>
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Chapter</div>
          <div className="mt-1 text-sm font-semibold text-neutral-100">{tempo.chapterBreakMs} ms</div>
        </div>
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Long Word</div>
          <div className="mt-1 text-sm font-semibold text-neutral-100">
            {tempo.longWordDelayMsAtTenLetters} ms
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-3.5">
          <div className="mb-3">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Punctuation</div>
            <p className="mt-1 text-[11px] leading-5 text-neutral-500">
              Smaller pauses that shape the cadence inside a paragraph.
            </p>
          </div>

          <div className="space-y-3">
            <TempoSlider
              label="Comma break"
              helper="A quick pause after a comma."
              valueLabel={`${tempo.commaBreakMs} ms`}
              value={tempo.commaBreakMs}
              min={SPEED_READER_TEMPO_LIMITS.commaBreakMs.min}
              max={SPEED_READER_TEMPO_LIMITS.commaBreakMs.max}
              step={SPEED_READER_TEMPO_LIMITS.commaBreakMs.step}
              testId="speed-reader-comma-break"
              onChange={(value) => updateTempo({ commaBreakMs: value })}
            />

            <TempoSlider
              label="Semicolon break"
              helper="A slightly deliberate pause after a semicolon."
              valueLabel={`${tempo.semicolonBreakMs} ms`}
              value={tempo.semicolonBreakMs}
              min={SPEED_READER_TEMPO_LIMITS.semicolonBreakMs.min}
              max={SPEED_READER_TEMPO_LIMITS.semicolonBreakMs.max}
              step={SPEED_READER_TEMPO_LIMITS.semicolonBreakMs.step}
              testId="speed-reader-semicolon-break"
              onChange={(value) => updateTempo({ semicolonBreakMs: value })}
            />

            <TempoSlider
              label="Sentence break"
              helper="A subtle breath after words ending a sentence."
              valueLabel={`${tempo.sentenceBreakMs} ms`}
              value={tempo.sentenceBreakMs}
              min={SPEED_READER_TEMPO_LIMITS.sentenceBreakMs.min}
              max={SPEED_READER_TEMPO_LIMITS.sentenceBreakMs.max}
              step={SPEED_READER_TEMPO_LIMITS.sentenceBreakMs.step}
              testId="speed-reader-sentence-break"
              onChange={(value) => updateTempo({ sentenceBreakMs: value })}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-3.5">
          <div className="mb-3">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Structure</div>
            <p className="mt-1 text-[11px] leading-5 text-neutral-500">
              Larger pauses that mark paragraph and chapter boundaries.
            </p>
          </div>

          <div className="space-y-3">
            <TempoSlider
              label="Paragraph break"
              helper="A larger pause when the next word starts a new paragraph."
              valueLabel={`${tempo.paragraphBreakMs} ms`}
              value={tempo.paragraphBreakMs}
              min={SPEED_READER_TEMPO_LIMITS.paragraphBreakMs.min}
              max={SPEED_READER_TEMPO_LIMITS.paragraphBreakMs.max}
              step={SPEED_READER_TEMPO_LIMITS.paragraphBreakMs.step}
              testId="speed-reader-paragraph-break"
              onChange={(value) => updateTempo({ paragraphBreakMs: value })}
            />

            <TempoSlider
              label="Chapter break"
              helper="The noticeable pause before a new chapter begins."
              valueLabel={`${tempo.chapterBreakMs} ms`}
              value={tempo.chapterBreakMs}
              min={SPEED_READER_TEMPO_LIMITS.chapterBreakMs.min}
              max={SPEED_READER_TEMPO_LIMITS.chapterBreakMs.max}
              step={SPEED_READER_TEMPO_LIMITS.chapterBreakMs.step}
              testId="speed-reader-chapter-break"
              onChange={(value) => updateTempo({ chapterBreakMs: value })}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-500/[0.05] p-3.5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-neutral-100">Long-word assist</div>
              <p className="mt-1 text-[11px] leading-5 text-neutral-500">
                A low-priority hold for visually dense words. It only applies when no punctuation or structure pause wins.
              </p>
            </div>
            <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200">
              {tempo.longWordDelayMsAtTenLetters} ms at 10 letters
            </div>
          </div>

          <div className="mb-3 grid grid-cols-3 gap-2">
            <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">{LONG_WORD_ASSIST_MIN_LENGTH} Letters</div>
              <div className="mt-1 text-sm font-semibold text-neutral-100">{shortWordPreviewMs} ms</div>
            </div>
            <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">10 Letters</div>
              <div className="mt-1 text-sm font-semibold text-neutral-100">{tempo.longWordDelayMsAtTenLetters} ms</div>
            </div>
            <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">14 Letters</div>
              <div className="mt-1 text-sm font-semibold text-neutral-100">{longWordPreviewMs} ms</div>
            </div>
          </div>

          <TempoSlider
            label="Assist strength"
            helper={`Scales linearly by letter count from ${LONG_WORD_ASSIST_MIN_LENGTH} letters upward, with no cap for longer words.`}
            valueLabel={`${tempo.longWordDelayMsAtTenLetters} ms`}
            value={tempo.longWordDelayMsAtTenLetters}
            min={SPEED_READER_TEMPO_LIMITS.longWordDelayMsAtTenLetters.min}
            max={SPEED_READER_TEMPO_LIMITS.longWordDelayMsAtTenLetters.max}
            step={SPEED_READER_TEMPO_LIMITS.longWordDelayMsAtTenLetters.step}
            testId="speed-reader-long-word-assist"
            onChange={(value) => updateTempo({ longWordDelayMsAtTenLetters: value })}
          />
        </div>

        <div className="rounded-2xl border border-amber-400/15 bg-amber-500/[0.05] p-3.5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-neutral-100">Chapter entry ramp</div>
              <p className="mt-1 text-[11px] leading-5 text-neutral-500">
                New chapters start slightly slower, then glide back to your base speed.
              </p>
            </div>
            <div className="rounded-full border border-amber-300/20 bg-amber-400/10 px-2.5 py-1 text-[11px] font-semibold text-amber-200">
              {chapterPreviewWpm} to {baseWpm} WPM
            </div>
          </div>

          <div className="space-y-3">
            <TempoSlider
              label="Chapter slowdown"
              helper={`Startup still begins slower at about ${startupPreviewWpm} WPM; this chapter ramp is intentionally lighter.`}
              valueLabel={`${tempo.chapterStartSlowdownPercent}%`}
              value={tempo.chapterStartSlowdownPercent}
              min={SPEED_READER_TEMPO_LIMITS.chapterStartSlowdownPercent.min}
              max={SPEED_READER_TEMPO_LIMITS.chapterStartSlowdownPercent.max}
              step={SPEED_READER_TEMPO_LIMITS.chapterStartSlowdownPercent.step}
              testId="speed-reader-chapter-slowdown"
              onChange={(value) => updateTempo({ chapterStartSlowdownPercent: value })}
            />

            <TempoSlider
              label="Ramp length"
              helper={`How many words it takes to return to full speed after a chapter break. Startup still uses ${INITIAL_SPEED_READER_RAMP_WORDS} words.`}
              valueLabel={`${tempo.chapterRampWords} words`}
              value={tempo.chapterRampWords}
              min={SPEED_READER_TEMPO_LIMITS.chapterRampWords.min}
              max={SPEED_READER_TEMPO_LIMITS.chapterRampWords.max}
              step={SPEED_READER_TEMPO_LIMITS.chapterRampWords.step}
              testId="speed-reader-chapter-ramp-words"
              onChange={(value) => updateTempo({ chapterRampWords: value })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
