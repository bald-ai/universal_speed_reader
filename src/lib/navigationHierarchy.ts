import type { NavigationKind } from "@/types/navigation";

/** Broad navigation levels remain distinct from anonymous scene-break anchors. */
export function classifyNavigationTitle(title: string): NavigationKind {
  const normalized = title.trim().toLocaleLowerCase();
  if (/^(?:contents|title page|copyright|dedication|preface|foreword|introduction)\b/u.test(normalized)) {
    return "frontmatter";
  }
  if (/^(?:notes|endnotes|bibliography|index|colophon|about the author)\b/u.test(normalized)) {
    return "backmatter";
  }
  if (/^(?:book|part|volume)\b/u.test(normalized)) return "part";
  if (/^scene\b/u.test(normalized)) return "scene";
  if (/^(?:section|appendix)\b/u.test(normalized)) return "section";
  return "chapter";
}

export function navigationPrecedence(kind: NavigationKind): number {
  return {
    frontmatter: 0,
    part: 1,
    chapter: 2,
    section: 3,
    scene: 4,
    backmatter: 5,
  }[kind];
}

export function navigationLevel(kind: NavigationKind): number {
  return {
    frontmatter: 1,
    part: 1,
    chapter: 2,
    section: 3,
    scene: 4,
    backmatter: 1,
  }[kind];
}

export function navigationKindLabel(kind: NavigationKind): string {
  return {
    frontmatter: "Front matter",
    part: "Part",
    chapter: "Chapter",
    section: "Section",
    scene: "Scene",
    backmatter: "Back matter",
  }[kind];
}
