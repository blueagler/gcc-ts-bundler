export const data = [
  {
    id: "cats",
    value: "Cats",
    summary: "Measured, opinionated, and impossible to ignore.",
    detail:
      "Cats suit a quieter page. The layout stays crisp, but the copy leans into patience, observation, and the feeling that the interface noticed more than it said.",
  },
  {
    id: "dogs",
    value: "Dogs",
    summary: "Big energy and very little hesitation.",
    detail:
      "Dogs fit the route that moves faster. The card wants motion, the detail view wants a brighter accent, and the whole page should feel like it got there first.",
  },
  {
    id: "hippos",
    value: "Hippos",
    summary: "Still water, hidden force, bad assumptions.",
    detail:
      "Hippos are useful demo data because the surface looks calm while the content underneath is heavy. That contrast makes a good second-stage page.",
  },
  {
    id: "elephants",
    value: "Elephants",
    summary: "Weight, memory, and room to breathe.",
    detail:
      "Elephants make the lazy route obvious. The page can afford larger type, a slower rhythm, and enough copy to show the detail view was worth splitting out.",
  },
  {
    id: "mosquitoes",
    value: "Mosquitoes",
    summary: "Small, annoying, and surprisingly durable.",
    detail:
      "Mosquitoes are a good reminder that tiny pages still benefit from real chunk boundaries when they are not needed on first paint.",
  },
  {
    id: "snakes",
    value: "Snakes",
    summary: "Lean pages with no wasted movement.",
    detail:
      "Snakes keep the detail route tight: a short intro, a few actions, and a fast return path without turning the screen into a wall of text.",
  },
  {
    id: "frogs",
    value: "Frogs",
    summary: "Half water, half land, fully routeable.",
    detail:
      "Frogs sit between worlds, which is a decent metaphor for this example sitting between eager shell code and lazily loaded page modules.",
  },
  {
    id: "alligators",
    value: "Alligators",
    summary: "Quiet until the surface breaks.",
    detail:
      "Alligators are the ambush route. The card is composed, the detail page is sharper, and the point is to prove repeated lazy navigation feels ordinary.",
  },
  {
    id: "cows",
    value: "Cows",
    summary: "Calm presence, slower pace, bigger fields.",
    detail:
      "Cows close the set with a calmer page and enough whitespace to show the shell and lazy route can still feel cohesive.",
  },
] as const;

export type DataItem = (typeof data)[number];

export const HOME_PATH = "/";
export const INDEX_PATH = "/index.html";
export const ABOUT_PATH = "/about";

export function findItemById(id: string | undefined): DataItem | undefined {
  return data.find((item) => item.id === id);
}

export function animalPath(id: string) {
  return `/animals/${id}`;
}
