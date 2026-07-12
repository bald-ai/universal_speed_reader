import type { NavigationKind } from "@/types/navigation";

type NavigationSeparatorProps = {
  kind: NavigationKind;
};

export default function NavigationSeparator({ kind }: NavigationSeparatorProps) {
  if (kind === "frontmatter" || kind === "backmatter") {
    return (
      <div
        role="separator"
        aria-label={kind === "frontmatter" ? "Front matter boundary" : "Back matter boundary"}
        data-testid={`navigation-separator-${kind}`}
        className="flex items-center justify-center py-10"
      >
        <div aria-hidden="true" className="h-px w-20 bg-neutral-600/45" />
      </div>
    );
  }

  if (kind === "scene") {
    return (
      <div role="separator" aria-label="Named scene boundary" data-testid="navigation-separator-scene" className="flex items-center justify-center py-10">
        <div aria-hidden="true" className="flex items-center gap-2 text-neutral-500/75">
          <span className="h-px w-14 bg-current opacity-35" />
          <span className="text-xs">◇</span>
          <span className="h-px w-14 bg-current opacity-35" />
        </div>
      </div>
    );
  }

  if (kind === "section") {
    return (
      <div role="separator" aria-label="Section boundary" data-testid="navigation-separator-section" className="flex items-center justify-center py-12">
        <div aria-hidden="true" className="h-px w-28 bg-[linear-gradient(90deg,transparent,rgba(120,120,120,0.7),transparent)]" />
      </div>
    );
  }

  const isPart = kind === "part";
  return (
    <div
      role="separator"
      aria-label={`${isPart ? "Part" : "Chapter"} boundary`}
      data-testid={isPart ? "navigation-separator-part" : "chapter-separator"}
      className={`relative flex items-center justify-center ${isPart ? "py-24" : "py-16"}`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_0%,rgba(26,26,42,0.10)_30%,rgba(26,26,42,0.18)_50%,rgba(26,26,42,0.10)_70%,transparent_100%)]" />
      <div aria-hidden="true" className="relative flex flex-col items-center gap-3">
        <div className={`${isPart ? "w-36" : "w-24"} h-px bg-[linear-gradient(90deg,transparent,rgba(120,120,120,0.85),transparent)]`} />
        <div className="flex gap-2">
          <div className="h-2 w-2 rotate-45 bg-neutral-500/80" />
          {isPart ? <div className="h-2 w-2 rotate-45 bg-neutral-500/80" /> : null}
        </div>
        <div className={`${isPart ? "w-36" : "w-24"} h-px bg-[linear-gradient(90deg,transparent,rgba(120,120,120,0.85),transparent)]`} />
      </div>
    </div>
  );
}
