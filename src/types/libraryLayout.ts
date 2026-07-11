export type LibraryFolder = {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  parentId: string | null;
  order: number;
};

export type BookPlacement = {
  bookId: string;
  parentId: string | null;
  order: number;
};

export type LibraryLayout = {
  folders: LibraryFolder[];
  placements: BookPlacement[];
};

export type LibraryLayoutItemId =
  | { kind: "folder"; id: string }
  | { kind: "book"; id: string };
