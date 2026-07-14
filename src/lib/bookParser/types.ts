import type { NavigationKind } from "../../types/navigation.ts";

export type BookFormat = "epub" | "pdf";

export const FAILURE_BUCKETS = [
  "Crash",
  "No / unusable text",
  "Bad paragraph IDs",
  "Weak / missing / nonsense chapters",
  "Cover missing",
  "Images missing / blank / badly placed",
  "Timeout / extreme slowness",
  "Other",
] as const;

export type FailureBucket = (typeof FAILURE_BUCKETS)[number];

export interface Paragraph {
  id: number;
  text: string;
  /** Anonymous narrative transition immediately before this real paragraph. */
  sceneBreakBefore?: SceneBreakSource;
}

export type SceneBreakSource = "text-ornament" | "horizontal-rule" | "css-separator" | "whitespace";

export interface Chapter {
  title: string;
  startParagraphId: number;
  kind?: NavigationKind;
  level?: number;
}

export interface BookImage {
  afterParagraphId: number;
  alt: string;
  src: string;
  mediaType?: string;
}

export interface Cover {
  src: string;
  mediaType?: string;
}

export interface BookMetadata {
  title: string;
  authors: string[];
  language?: string;
  identifier?: string;
}

export interface BookTotals {
  words: number;
  paragraphs: number;
  chapters: number;
  images: number;
  sceneBreaks: number;
}

export interface ParserDiagnostic {
  bucket: FailureBucket;
  severity: "warning" | "failure";
  message: string;
  /** Stable machine code for import soft/hard classification. */
  code?: string;
  details?: Record<string, string | number | boolean>;
}

export interface ParserTimings {
  totalMs: number;
  openMs?: number;
  structureMs?: number;
  contentMs?: number;
}

export interface ParsedBook {
  schemaVersion: 2;
  format: BookFormat;
  metadata: BookMetadata;
  paragraphs: Paragraph[];
  chapters: Chapter[];
  images: BookImage[];
  cover: Cover | null;
  totals: BookTotals;
  diagnostics: ParserDiagnostic[];
  timings: ParserTimings;
}

export interface ParseOptions {
  /** The original uploaded bytes. Keeping parsing byte-based makes this portable to Android and web. */
  sourceBytes: Uint8Array;
  /** Original filename is only used as a metadata fallback. */
  sourceName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onPhaseChange?: (phase: ParsePhase) => void | Promise<void>;
}

export type ParsePhase = "extracting_metadata" | "extracting_text" | "building_chapters";

export interface ParseInternals {
  sourceDocumentCount?: number;
  textPageCount?: number;
  totalPageCount?: number;
  declaredImageCount?: number;
  extractedImageCount?: number;
}

export interface ParserOutput {
  book: ParsedBook;
  internals: ParseInternals;
}

export interface EvaluationRecord {
  id: string;
  sourcePath: string;
  sourceUrl?: string;
  sourceName?: string;
  format: BookFormat;
  title: string;
  pass: boolean;
  elapsedMs: number;
  diagnostics: ParserDiagnostic[];
  outputPath?: string;
  previewPath?: string;
}

export interface EvaluationSummary {
  schemaVersion: 1;
  startedAt: string;
  completedAt: string;
  corpusPath: string;
  resultPath: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  byFormat: Record<BookFormat, { total: number; passed: number; failed: number }>;
  /** Books with any diagnostic in the bucket (warning or failure). */
  bucketCounts: Record<FailureBucket, number>;
  failureBucketCounts: Record<FailureBucket, number>;
  warningBucketCounts: Record<FailureBucket, number>;
  records: EvaluationRecord[];
}
