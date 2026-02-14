export type Mode = "normal" | "speed";

export type TtsHighlightStyle = "word" | "sentence" | "dim-rest" | "underline" | "karaoke" | "phrase";

export type Position = {
  paragraphId: number;
  wordIndex: number;
};