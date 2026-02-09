import type { MoodFolder } from "@/types/book";

// MOCK DATA — remove when real upload is implemented.
// Mood folders are a UX concept; this is temporary local data to drive the UI.

export const MOCK_MOOD_FOLDERS: MoodFolder[] = [
  // 1) Tired (Lightest): all Romance + real bundled book ("test")
  {
    id: "mood-tired",
    label: "Tired",
    color: "rose",
    bookIds: [
      "test",
      "mock-romance-moonlight-over-camden",
      "mock-romance-the-notebook",
      "mock-romance-outlander",
      "mock-romance-me-before-you",
      "mock-romance-the-time-travelers-wife",
    ],
    isMock: true,
  },

  // 2) Chill (Light): all Casual Nonfiction
  {
    id: "mood-chill",
    label: "Chill",
    color: "emerald",
    bookIds: [
      "mock-casual-nonfiction-atomic-habits",
      "mock-casual-nonfiction-freakonomics",
      "mock-casual-nonfiction-thinking-fast-and-slow",
      "mock-casual-nonfiction-the-tipping-point",
      "mock-casual-nonfiction-quiet",
    ],
    isMock: true,
  },

  // 3) Magical (Medium): all Fantasy
  {
    id: "mood-magical",
    label: "Magical",
    color: "fuchsia",
    bookIds: [
      "mock-fantasy-the-hobbit",
      "mock-fantasy-a-game-of-thrones",
      "mock-fantasy-the-name-of-the-wind",
      "mock-fantasy-mistborn",
      "mock-fantasy-the-way-of-kings",
    ],
    isMock: true,
  },

  // 4) Curious (Hardest): all Science
  {
    id: "mood-curious",
    label: "Curious",
    color: "sky",
    bookIds: [
      "mock-science-a-brief-history-of-time",
      "mock-science-cosmos",
      "mock-science-the-selfish-gene",
      "mock-science-sapiens",
      "mock-science-the-gene",
    ],
    isMock: true,
  },
];

