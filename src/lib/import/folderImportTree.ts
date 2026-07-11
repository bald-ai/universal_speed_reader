export type FolderImportSourceFile = {
  name: string;
  size: number;
  relativePath?: string;
};

export type FolderImportBookNode = {
  kind: "book";
  id: string;
  name: string;
  size: number;
  sourceIndex: number;
  relativePath: string;
  folderPath: string[];
};

export type FolderImportFolderNode = {
  kind: "folder";
  id: string;
  label: string;
  path: string[];
  children: FolderImportTreeNode[];
};

export type FolderImportTreeNode = FolderImportFolderNode | FolderImportBookNode;

export type FolderImportPreview = {
  root: FolderImportFolderNode;
  bookCount: number;
  totalBytes: number;
};

function normalizeSegment(segment: string): string {
  return segment.trim().replace(/\s+/g, " ");
}

function splitRelativePath(path: string | undefined, fallbackName: string): string[] {
  const rawSegments = (path?.trim() ? path : fallbackName)
    .split(/[\\/]+/)
    .map(normalizeSegment)
    .filter(Boolean);
  return rawSegments.length > 0 ? rawSegments : [fallbackName];
}

function folderIdForPath(path: string[]): string {
  return path.length === 0 ? "folder:root" : `folder:${path.join("/")}`;
}

function bookIdForFile(sourceIndex: number, relativePath: string): string {
  return `book:${sourceIndex}:${relativePath}`;
}

function sortTreeChildren(children: FolderImportTreeNode[]): FolderImportTreeNode[] {
  return children
    .map((child) =>
      child.kind === "folder"
        ? { ...child, children: sortTreeChildren(child.children) }
        : child
    )
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return ("label" in a ? a.label : a.name).localeCompare("label" in b ? b.label : b.name);
    });
}

export function buildFolderImportPreview(
  files: FolderImportSourceFile[],
  rootLabel: string
): FolderImportPreview {
  const normalizedRootLabel = rootLabel.trim() || "Imported folder";
  const root: FolderImportFolderNode = {
    kind: "folder",
    id: folderIdForPath([]),
    label: normalizedRootLabel,
    path: [],
    children: [],
  };
  const foldersByPath = new Map<string, FolderImportFolderNode>([[root.id, root]]);
  let totalBytes = 0;

  files.forEach((file, sourceIndex) => {
    const segments = splitRelativePath(file.relativePath, file.name);
    const fileName = segments[segments.length - 1] || file.name;
    const folderSegments = segments.slice(0, -1);
    let parent = root;

    folderSegments.forEach((segment, segmentIndex) => {
      const path = folderSegments.slice(0, segmentIndex + 1);
      const id = folderIdForPath(path);
      const existing = foldersByPath.get(id);
      if (existing) {
        parent = existing;
        return;
      }

      const nextFolder: FolderImportFolderNode = {
        kind: "folder",
        id,
        label: segment,
        path,
        children: [],
      };
      foldersByPath.set(id, nextFolder);
      parent.children.push(nextFolder);
      parent = nextFolder;
    });

    const relativePath = [...folderSegments, fileName].join("/");
    const book: FolderImportBookNode = {
      kind: "book",
      id: bookIdForFile(sourceIndex, relativePath),
      name: fileName,
      size: Math.max(0, file.size),
      sourceIndex,
      relativePath,
      folderPath: folderSegments,
    };
    totalBytes += book.size;
    parent.children.push(book);
  });

  return {
    root: { ...root, children: sortTreeChildren(root.children) },
    bookCount: files.length,
    totalBytes,
  };
}

export function flattenFolderImportBooks(root: FolderImportFolderNode): FolderImportBookNode[] {
  const books: FolderImportBookNode[] = [];
  const visit = (node: FolderImportTreeNode) => {
    if (node.kind === "book") {
      books.push(node);
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
  return books;
}

export function countBooksInFolderImportTree(root: FolderImportFolderNode): number {
  return flattenFolderImportBooks(root).length;
}

export function sumBytesInFolderImportTree(root: FolderImportFolderNode): number {
  return flattenFolderImportBooks(root).reduce((sum, book) => sum + book.size, 0);
}
