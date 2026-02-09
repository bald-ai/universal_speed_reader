export type MoodIcon = {
  key: string;
  emoji: string;
};

export const MOOD_ICONS: MoodIcon[] = [
  { key: "moon", emoji: "\uD83C\uDF19" },
  { key: "sun", emoji: "\u2600\uFE0F" },
  { key: "fire", emoji: "\uD83D\uDD25" },
  { key: "leaf", emoji: "\uD83C\uDF3F" },
  { key: "sparkles", emoji: "\u2728" },
  { key: "heart", emoji: "\u2764\uFE0F" },
  { key: "star", emoji: "\u2B50" },
  { key: "cloud", emoji: "\u2601\uFE0F" },
  { key: "bolt", emoji: "\u26A1" },
  { key: "snowflake", emoji: "\u2744\uFE0F" },
  { key: "coffee", emoji: "\u2615" },
  { key: "music", emoji: "\uD83C\uDFB5" },
  { key: "compass", emoji: "\uD83E\uDDED" },
  { key: "flower", emoji: "\uD83C\uDF38" },
  { key: "mountain", emoji: "\u26F0\uFE0F" },
  { key: "wave", emoji: "\uD83C\uDF0A" },
  { key: "candle", emoji: "\uD83D\uDD6F\uFE0F" },
  { key: "telescope", emoji: "\uD83D\uDD2D" },
  { key: "feather", emoji: "\uD83E\uDEB6" },
  { key: "ghost", emoji: "\uD83D\uDC7B" },
  { key: "rocket", emoji: "\uD83D\uDE80" },
  { key: "gem", emoji: "\uD83D\uDC8E" },
  { key: "crystal", emoji: "\uD83D\uDD2E" },
  { key: "rainbow", emoji: "\uD83C\uDF08" },
  { key: "butterfly", emoji: "\uD83E\uDD8B" },
];

export const getIconEmoji = (key: string | undefined): string | undefined => {
  if (!key) return undefined;
  return MOOD_ICONS.find((i) => i.key === key)?.emoji;
};
