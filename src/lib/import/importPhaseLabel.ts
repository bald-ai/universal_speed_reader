import type { ImportSnapshotStatus } from "@/lib/import/bookImportService";

export function importPhaseLabel(status: ImportSnapshotStatus): string {
  switch (status) {
    case "queued":
      return "Waiting in queue";
    case "validating":
      // Coarse label: mid-parse phases are no longer persisted; session card stays on this.
      return "Processing";
    case "extracting_metadata":
      return "Extracting metadata";
    case "extracting_text":
      return "Extracting text";
    case "building_chapters":
      return "Building chapters";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return "Processing";
  }
}

export function isActiveImportStatus(status: ImportSnapshotStatus): boolean {
  return (
    status === "queued" ||
    status === "validating" ||
    status === "extracting_metadata" ||
    status === "extracting_text" ||
    status === "building_chapters"
  );
}
