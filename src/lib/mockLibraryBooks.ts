import type { LibraryBook } from "@/types/book";

// MOCK DATA — remove when real upload is implemented.
// These are placeholder books for the library page UI.

export const MOCK_LIBRARY_BOOKS: LibraryBook[] = [
  // MOCK DATA — remove when real upload is implemented.
  // Romance
  {
    id: "mock-romance-moonlight-over-camden",
    title: "Moonlight Over Camden",
    author: "Elena Hart",
    genre: "Romance",
    description:
      "A city architect and a small-town baker clash over a renovation that could change everything. They discover the plan they are fighting about might be exactly what brings them together.",
    isMock: true,
  },
  {
    id: "mock-romance-the-notebook",
    title: "The Notebook",
    author: "Nicholas Sparks",
    genre: "Romance",
    description:
      "A love story told across time, with memories that refuse to fade. It is about devotion, choices, and what lasts when everything else changes.",
    isMock: true,
  },
  {
    id: "mock-romance-outlander",
    title: "Outlander",
    author: "Diana Gabaldon",
    genre: "Romance",
    description:
      "A modern woman is pulled into a dangerous past and meets a love she never expected. It mixes adventure, history, and a relationship tested by time itself.",
    isMock: true,
  },
  {
    id: "mock-romance-me-before-you",
    title: "Me Before You",
    author: "Jojo Moyes",
    genre: "Romance",
    description:
      "An unlikely friendship grows into something deeper between two people with very different lives. It is about care, dignity, and learning to live boldly.",
    isMock: true,
  },
  {
    id: "mock-romance-the-time-travelers-wife",
    title: "The Time Traveler's Wife",
    author: "Audrey Niffenegger",
    genre: "Romance",
    description:
      "A couple tries to build a life together while time keeps pulling them apart. It is a love story with a sci-fi twist and a lot of heart.",
    isMock: true,
  },

  // MOCK DATA — remove when real upload is implemented.
  // Science
  {
    id: "mock-science-a-brief-history-of-time",
    title: "A Brief History of Time",
    author: "Stephen Hawking",
    genre: "Science",
    description:
      "Big ideas about the universe, from black holes to the nature of time. It is a guided tour of modern physics for curious readers.",
    isMock: true,
  },
  {
    id: "mock-science-cosmos",
    title: "Cosmos",
    author: "Carl Sagan",
    genre: "Science",
    description:
      "A wide, wonder-filled look at space, life, and how humans learn about the universe. It connects science to culture and the story of discovery.",
    isMock: true,
  },
  {
    id: "mock-science-the-selfish-gene",
    title: "The Selfish Gene",
    author: "Richard Dawkins",
    genre: "Science",
    description:
      "An explanation of evolution that focuses on genes as the key players. It reshapes how you think about behavior, survival, and cooperation.",
    isMock: true,
  },
  {
    id: "mock-science-sapiens",
    title: "Sapiens",
    author: "Yuval Noah Harari",
    genre: "Science",
    description:
      "A fast-moving history of humans, from early hunters to modern societies. It asks why we believe shared stories and how that shaped the world.",
    isMock: true,
  },
  {
    id: "mock-science-the-gene",
    title: "The Gene",
    author: "Siddhartha Mukherjee",
    genre: "Science",
    description:
      "A story of genetics: the people, the breakthroughs, and the hard questions that came with them. It blends history with clear science explanations.",
    isMock: true,
  },

  // MOCK DATA — remove when real upload is implemented.
  // Fantasy
  {
    id: "mock-fantasy-the-hobbit",
    title: "The Hobbit",
    author: "J.R.R. Tolkien",
    genre: "Fantasy",
    description:
      "A quiet hobbit gets pulled into a quest full of trolls, dragons, and treasure. It is an adventure about courage growing one step at a time.",
    isMock: true,
  },
  {
    id: "mock-fantasy-a-game-of-thrones",
    title: "A Game of Thrones",
    author: "George R.R. Martin",
    genre: "Fantasy",
    description:
      "Noble houses fight for power while darker threats gather beyond the map. It is political, brutal, and packed with characters making risky moves.",
    isMock: true,
  },
  {
    id: "mock-fantasy-the-name-of-the-wind",
    title: "The Name of the Wind",
    author: "Patrick Rothfuss",
    genre: "Fantasy",
    description:
      "A legendary musician and magician tells the true story behind his fame. It is about talent, obsession, and the cost of chasing answers.",
    isMock: true,
  },
  {
    id: "mock-fantasy-mistborn",
    title: "Mistborn",
    author: "Brandon Sanderson",
    genre: "Fantasy",
    description:
      "In a world of ash and tyranny, a crew plans an impossible rebellion. It features clever magic rules and a heist that turns into something bigger.",
    isMock: true,
  },
  {
    id: "mock-fantasy-the-way-of-kings",
    title: "The Way of Kings",
    author: "Brandon Sanderson",
    genre: "Fantasy",
    description:
      "A huge epic with war, storms, and people trying to become better than their past. It is slow-burn worldbuilding with massive payoffs.",
    isMock: true,
  },

  // MOCK DATA — remove when real upload is implemented.
  // Casual Nonfiction
  {
    id: "mock-casual-nonfiction-atomic-habits",
    title: "Atomic Habits",
    author: "James Clear",
    genre: "Casual Nonfiction",
    description:
      "A practical guide to building good habits and breaking bad ones using tiny changes. It focuses on systems, not motivation.",
    isMock: true,
  },
  {
    id: "mock-casual-nonfiction-freakonomics",
    title: "Freakonomics",
    author: "Steven D. Levitt & Stephen J. Dubner",
    genre: "Casual Nonfiction",
    description:
      "A collection of surprising questions answered with economic thinking. It is about incentives, data, and the hidden side of everyday life.",
    isMock: true,
  },
  {
    id: "mock-casual-nonfiction-thinking-fast-and-slow",
    title: "Thinking, Fast and Slow",
    author: "Daniel Kahneman",
    genre: "Casual Nonfiction",
    description:
      "A deep look at how the mind makes quick guesses and slow, careful decisions. It shows why we make predictable mistakes and how to notice them.",
    isMock: true,
  },
  {
    id: "mock-casual-nonfiction-the-tipping-point",
    title: "The Tipping Point",
    author: "Malcolm Gladwell",
    genre: "Casual Nonfiction",
    description:
      "Stories about how small actions can trigger big social changes. It is about how ideas spread and why some trends explode.",
    isMock: true,
  },
  {
    id: "mock-casual-nonfiction-quiet",
    title: "Quiet",
    author: "Susan Cain",
    genre: "Casual Nonfiction",
    description:
      "A defense of introversion and the strengths of quieter people. It explores how environment, culture, and temperament shape success.",
    isMock: true,
  },
];
