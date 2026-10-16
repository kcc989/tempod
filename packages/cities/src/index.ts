/** Fixed animal slug list. A random unused name wins. */
export const ANIMALS = [
  "otter",
  "fox",
  "badger",
  "lynx",
  "panda",
  "koala",
  "wolf",
  "bear",
  "rabbit",
  "deer",
  "moose",
  "bison",
  "beaver",
  "raccoon",
  "hedgehog",
  "squirrel",
  "marten",
  "ferret",
  "wombat",
  "kangaroo",
  "lemur",
  "tiger",
  "lion",
  "leopard",
  "jaguar",
  "cheetah",
  "elephant",
  "giraffe",
  "zebra",
  "rhino",
  "hippo",
  "camel",
  "alpaca",
  "llama",
  "yak",
  "goat",
  "sheep",
  "horse",
  "donkey",
  "seal",
  "walrus",
  "dolphin",
  "whale",
  "narwhal",
  "penguin",
  "puffin",
  "owl",
  "eagle",
  "falcon",
  "hawk",
  "raven",
  "crow",
  "robin",
  "sparrow",
  "finch",
  "heron",
  "crane",
  "swan",
  "duck",
  "goose",
  "pelican",
  "flamingo",
  "parrot",
  "toucan",
  "turtle",
  "tortoise",
  "gecko",
  "iguana",
  "chameleon",
  "frog",
  "salamander",
  "axolotl",
  "octopus",
  "squid",
  "crab",
  "lobster",
  "shrimp",
  "seahorse",
  "starfish",
  "manta",
  "shark",
  "salmon",
  "trout",
  "bee",
  "butterfly",
  "dragonfly",
  "beetle",
] as const;

export type Animal = (typeof ANIMALS)[number];

export const pickSlug = (used: Iterable<string>, random: () => number = Math.random): string => {
  const taken = new Set(used);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const free = ANIMALS.filter((animal) => !taken.has(animal));

  if (free.length > 0) return pick(free);

  const base = pick(ANIMALS);

  for (let n = 2; ; n++) {
    const slug = `${base}-${n}`;

    if (!taken.has(slug)) return slug;
  }
};

export const promptSlug = (text: string): string =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");

export const SLUG_PATTERN = /^[a-z0-9-]+$/;
