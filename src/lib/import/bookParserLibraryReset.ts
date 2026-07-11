import { clearRawBooks } from "@/lib/import/rawEpubStore";
import { saveLibraryLayout } from "@/lib/libraryLayoutStore";
import { saveMoods, saveRecent } from "@/lib/moodStore";
import { getBookRepository } from "@/lib/storage/appRepository";

const BOOK_PARSER_LIBRARY_RESET_KEY = "book_parser_library_reset.v1";

/**
 * Product-owner-approved one-time fresh start for the parser release. We clear
 * only book/library data and preserve reader preferences such as theme/speed.
 */
export async function applyBookParserLibraryReset(): Promise<void> {
  const repository = await getBookRepository();
  const alreadyApplied = await repository.getAppSetting<boolean>(BOOK_PARSER_LIBRARY_RESET_KEY);
  if (alreadyApplied === true) return;

  await repository.clearAllBooks();
  await clearRawBooks();
  await saveMoods([], { repository });
  await saveRecent({}, { repository });
  await saveLibraryLayout({ folders: [], placements: [] }, { repository });
  await repository.putAppSetting(BOOK_PARSER_LIBRARY_RESET_KEY, true);
}
