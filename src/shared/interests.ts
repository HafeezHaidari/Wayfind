import type { InterestTag } from "./types.js";

export const INTEREST_TAGS: InterestTag[] = [
  "museums",
  "history",
  "architecture",
  "art",
  "nature",
  "parks",
  "viewpoints",
  "beaches",
  "food",
  "cafes",
  "markets",
  "nightlife",
  "shopping",
  "neighbourhoods",
  "religious-sites",
  "offbeat",
  "photography",
  "live-music",
];

/** Traveller-facing labels (§9g). Grouped for the interview grid (§4 q3). */
export const INTEREST_LABELS: Record<InterestTag, string> = {
  museums: "Museums",
  history: "History",
  architecture: "Architecture",
  art: "Art",
  nature: "Nature",
  parks: "Parks",
  viewpoints: "Viewpoints",
  beaches: "Beaches",
  food: "Food",
  cafes: "Cafés",
  markets: "Markets",
  nightlife: "Nightlife",
  shopping: "Shopping",
  neighbourhoods: "Neighbourhoods",
  "religious-sites": "Religious sites",
  offbeat: "Offbeat",
  photography: "Photography",
  "live-music": "Live music",
};

export const INTEREST_GROUPS: { title: string; tags: InterestTag[] }[] = [
  { title: "Culture", tags: ["museums", "history", "architecture", "art", "religious-sites"] },
  { title: "Outdoors", tags: ["nature", "parks", "viewpoints", "beaches", "photography"] },
  { title: "Eating & drinking", tags: ["food", "cafes", "markets", "nightlife", "live-music"] },
  { title: "Wandering", tags: ["neighbourhoods", "shopping", "offbeat"] },
];

/** The four tap states of the interest grid (§4 q3). */
export const INTEREST_LEVEL_LABELS = ["Avoid", "Neutral", "Interested", "Must-do"] as const;
