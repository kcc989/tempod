/** The fixed slug list (02, Slugs). Order matters: the first unused name wins. */
export const CITIES = [
  "lisbon", "porto", "madrid", "seville", "valencia", "barcelona", "marseille", "lyon", "paris", "brussels",
  "amsterdam", "rotterdam", "hamburg", "berlin", "munich", "vienna", "prague", "krakow", "warsaw", "vilnius",
  "riga", "tallinn", "helsinki", "stockholm", "oslo", "bergen", "copenhagen", "dublin", "galway", "edinburgh",
  "glasgow", "london", "bristol", "zurich", "geneva", "milan", "turin", "venice", "florence", "rome",
  "naples", "palermo", "athens", "sofia", "bucharest", "budapest", "zagreb", "ljubljana", "belgrade", "istanbul",
  "cairo", "tunis", "casablanca", "dakar", "accra", "lagos", "nairobi", "kampala", "kigali", "zanzibar",
  "capetown", "durban", "windhoek", "lusaka", "harare", "maputo", "antananarivo", "doha", "muscat", "dubai",
  "tehran", "baku", "tbilisi", "yerevan", "almaty", "tashkent", "samarkand", "karachi", "lahore", "delhi",
  "mumbai", "pune", "goa", "chennai", "bangalore", "kolkata", "dhaka", "kathmandu", "colombo", "yangon",
  "bangkok", "hanoi", "saigon", "phnompenh", "vientiane", "kualalumpur", "singapore", "jakarta", "bali", "manila",
  "taipei", "hongkong", "shanghai", "beijing", "seoul", "busan", "tokyo", "kyoto", "osaka", "sapporo",
  "perth", "adelaide", "melbourne", "sydney", "brisbane", "hobart", "auckland", "wellington", "suva", "honolulu",
  "anchorage", "vancouver", "seattle", "portland", "sanfrancisco", "oakland", "losangeles", "sandiego", "phoenix", "denver",
  "austin", "dallas", "houston", "neworleans", "chicago", "detroit", "toronto", "montreal", "quebec", "boston",
  "newyork", "philadelphia", "baltimore", "atlanta", "miami", "havana", "kingston", "mexicocity", "oaxaca", "guatemala",
  "panama", "bogota", "medellin", "quito", "lima", "cusco", "lapaz", "santiago", "valparaiso", "mendoza",
  "buenosaires", "montevideo", "asuncion", "saopaulo", "rio", "salvador", "recife", "reykjavik", "nuuk", "tromso",
] as const;

export type City = (typeof CITIES)[number];

/**
 * Picks the first city name that `used` does not hold. If every name is used, adds `-2`, `-3`,
 * and so on to the first name (03, Create a workspace).
 */
export const pickSlug = (used: Iterable<string>): string => {
  const taken = new Set(used);
  for (const city of CITIES) if (!taken.has(city)) return city;
  const first = CITIES[0];
  for (let n = 2; ; n++) {
    const slug = `${first}-${n}`;
    if (!taken.has(slug)) return slug;
  }
};

export const SLUG_PATTERN = /^[a-z0-9-]+$/;
