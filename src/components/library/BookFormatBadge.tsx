import type { BookSourceFormat } from "@/types/book";

type BookFormatBadgeProps = {
  format?: BookSourceFormat | null;
};

export default function BookFormatBadge({ format }: BookFormatBadgeProps) {
  if (!format) return null;

  return (
    <span className="shrink-0 rounded border border-neutral-700 bg-neutral-800/70 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-neutral-400">
      {format}
    </span>
  );
}
