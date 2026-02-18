export type TtsRegexRule = {
  id: string;
  pattern: string;
  replacement: string;
  enabled: boolean;
  caseInsensitive: boolean;
  createdAt: number;
  updatedAt: number;
};

export type TtsRegexMatchMode = "token" | "chunk";

export type TtsRegexStoreV1 = {
  version: 1;
  matchMode: TtsRegexMatchMode;
  globalRules: TtsRegexRule[];
  bookRulesById: Record<string, TtsRegexRule[]>;
};

export type TtsRegexScope = "global" | "book";

export type TtsRegexPreviewExample = {
  before: string;
  after: string;
};

export type TtsRegexPreviewStats = {
  totalMatches: number;
  affectedParagraphs: number;
  uniqueMatchedWords: number;
  examples: TtsRegexPreviewExample[];
  totalWords: number;
  matchPercentOfBookWords: number;
  highImpact: boolean;
};
