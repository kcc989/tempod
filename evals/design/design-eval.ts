import spec from "./design-eval.questions.json" with { type: "json" };

export type Platform = "web" | "desktop" | "mobile";
export type ImageType = "image/png" | "image/jpeg" | "image/webp";
export type ClefImage = string | { content_type: ImageType; base64: string };
export type ScreenGate = "ai" | "async" | "collection" | "editing" | "empty" | "errors" | "limits";

export interface ScreenContext {
  app: { name: string; category: string; platform: Platform; primary_user: string; primary_job: string };
  screen: { name: string; purpose: string };
  image_legend: string[];
  page_text?: string;
}

export interface Interaction {
  action: string;
  before: ClefImage;
  after: ClefImage;
}

export interface RelatedScreens {
  images: ClefImage[];
  image_legend: string[];
  page_text?: string;
}

export interface Checks {
  textContrastAA?: boolean;
  nonTextContrast3?: boolean;
  targetSize24px?: boolean;
  spacingOnScale?: boolean;
  matchesDesignSystem?: boolean;
  lineLength75?: boolean;
  noHorizontalOverflow?: boolean;
  narrowViewportOk?: boolean;
  findings?: { rule: string; kind: "slop" | "quality"; fix?: string }[];
}

export interface Capture {
  context: ScreenContext;
  images: ClefImage[];
  interactions?: Interaction[];
  related?: RelatedScreens;
  known?: Partial<Record<ScreenGate, boolean>>;
  checks?: Checks;
}

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence?: number; probabilities?: Record<string, number> }
  | { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> };

export interface Answers {
  screen: Record<string, Answer>;
  visual: Record<string, Answer>;
  slop: Record<string, Answer>;
  interactions: Record<string, Answer>[];
  consistency?: Record<string, Answer>;
}

export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

type ScreenId = keyof typeof spec.screen;
type RubricId = Exclude<ScreenId, `applies_${string}`>;
type VisualId = keyof typeof spec.visual;
type SlopId = keyof typeof spec.slop;
type ConsistencyId = keyof typeof spec.consistency;
type Gate = ScreenGate | "keyboard";
type PenaltyDim = "slop" | "quality";
type RubricDim =
  | "focus"
  | "status"
  | "ai"
  | "control"
  | "scan"
  | "nav"
  | "speed"
  | "states"
  | "copy"
  | "trust"
  | "color"
  | "spacing"
  | "type"
  | "icons"
  | "contrast"
  | "overflow"
  | "restraint"
  | "consistency";
type Dim = RubricDim | "craft" | PenaltyDim;

interface Rule {
  dim: RubricDim;
  fix: string;
  gate?: Gate;
  weight?: number;
  choices?: Record<string, number | null>;
}

interface SlopRule {
  dim: PenaltyDim;
  rule: string;
  fix: string;
  breaking?: boolean;
}

export const DIM_WEIGHTS: Record<Dim, number> = {
  focus: 0.09,
  status: 0.07,
  ai: 0.07,
  control: 0.05,
  scan: 0.05,
  nav: 0.04,
  speed: 0.03,
  states: 0.06,
  copy: 0.04,
  trust: 0.02,
  color: 0.05,
  spacing: 0.05,
  type: 0.05,
  icons: 0.03,
  contrast: 0.05,
  overflow: 0.04,
  restraint: 0.03,
  consistency: 0.03,
  craft: 0.03,
  slop: 0.07,
  quality: 0.05,
};

export const THRESHOLDS = {
  wellDesigned: 0.75,
  needsWork: 0.55,
  maxUncertainShare: 0.25,
  minConfidence: 0.4,
  noulUncertainLow: 0.35,
  noulUncertainHigh: 0.65,
  weakAnswer: 0.67,
  appliesAt: 0.5,
  dimensionFloor: 0.6,
  maxFixes: 6,
};

export const PENALTY = {
  perIssue: { slop: 0.2, quality: 0.25 } as Record<PenaltyDim, number>,
  detectAt: 0.5,
  breakingAt: 0.7,
  slopBlockerCount: 3,
};

const MODEL_IDS: Record<string, string> = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
};

const APPLIES: Record<ScreenGate, ScreenId> = {
  ai: "applies_ai",
  async: "applies_async",
  collection: "applies_collection",
  editing: "applies_editing",
  empty: "applies_empty",
  errors: "applies_errors",
  limits: "applies_limits",
};

export const SCREEN_RULES: Record<RubricId, Rule> = {
  focus_primary_path: { dim: "focus", weight: 2, fix: "Give the screen one main path: one filled button, or no control that competes with the content." },
  focus_content_share: { dim: "focus", fix: "Give the user's content most of the screen. Move controls to the edges." },
  focus_reading_order: { dim: "focus", fix: "Use one reading order: navigation at one edge, then a page title, then the content." },
  focus_affordance: { dim: "focus", weight: 2, fix: "Make actions look clickable with a button shape, an icon, or a link color. Keep static text plain." },
  focus_space_fit: { dim: "focus", fix: "Make each panel only as wide as its content needs." },

  status_items: { dim: "status", weight: 2, fix: "Show the state of each item inline with an icon, a label, or a count." },
  status_async: { dim: "status", gate: "async", fix: "Show running work as a live line: what happens now, plus elapsed time or steps." },
  status_attention: { dim: "status", gate: "async", fix: "Mark items that need user input differently from items that are only running." },
  status_consistent: { dim: "status", weight: 2, fix: "Make all status signals agree. Remove spinners from work that is not running." },
  status_lifecycle: {
    dim: "status",
    choices: { explains: 1, bare: 0.3, not_shown: null },
    fix: "When work sleeps or pauses, say what that means and how to resume.",
  },

  ai_steps: { dim: "ai", gate: "ai", fix: "Show each AI step as one short line that the user can expand." },
  ai_evidence: { dim: "ai", gate: "ai", fix: "Show the sources, files, or commands that the AI used." },
  ai_marked: {
    dim: "ai",
    gate: "ai",
    choices: { marked: 1, unmarked: 0, not_shown: null },
    fix: "Mark values that the AI made, for example with a sparkle icon.",
  },
  ai_limits: { dim: "ai", gate: "ai", fix: "State the limits of the AI near its output." },
  ai_feedback: { dim: "ai", gate: "ai", fix: "Let the user rate or correct AI output, and confirm the rating." },

  control_ask: {
    dim: "control",
    gate: "ai",
    choices: { structured: 1, free_text: 0.5, none: 0, not_shown: null },
    fix: "When the AI needs a decision, ask one question with options, a free-text field, and Skip.",
  },
  control_draft: { dim: "control", gate: "editing", fix: "Let the user save a draft or undo before work is final." },
  control_diff: {
    dim: "control",
    choices: { shown: 1, hidden: 0, not_shown: null },
    fix: "Show changes as before and after.",
  },
  control_consent: {
    dim: "control",
    choices: { in_context: 1, upfront: 0, not_shown: null },
    fix: "Ask for permissions in the page, at the moment they help, with a way to dismiss.",
  },

  scan_rows: { dim: "scan", gate: "collection", fix: "Give each row one bold main field, aligned grey secondary fields, and truncation." },
  scan_missing: {
    dim: "scan",
    gate: "collection",
    choices: { muted: 1, raw: 0, not_shown: null },
    fix: "Show missing values as a muted placeholder.",
  },
  scan_overflow: {
    dim: "scan",
    gate: "collection",
    choices: { count: 1, clipped: 0, not_shown: null },
    fix: "When items do not fit in a row, show a few and a '+N' count.",
  },

  nav_current: { dim: "nav", fix: "Show the current location with a visible selected state." },
  nav_groups: { dim: "nav", fix: "Put navigation in short groups with clear names. Add counts where they help." },
  nav_return: { dim: "nav", fix: "Let the user go back to recent or pinned work in one click." },
  nav_tabs_current: {
    dim: "nav",
    choices: { clear: 1, weak: 0.2, not_shown: null },
    fix: "Mark the active tab with a background, an underline, or bold text, not only a text color.",
  },

  speed_search: { dim: "speed", fix: "Add search or a command menu that opens from the keyboard." },
  speed_shortcuts: { dim: "speed", gate: "keyboard", fix: "Show keyboard shortcuts next to frequent actions." },
  speed_views: { dim: "speed", gate: "collection", fix: "Let the user sort, filter, and change the view of the collection." },

  states_empty: { dim: "states", gate: "empty", fix: "In empty states, say what will appear and why, and offer one action." },
  states_errors: { dim: "states", gate: "errors", fix: "In error and warning messages, say what happened and what to do next." },
  states_disabled_clear: {
    dim: "states",
    choices: { clear: 1, confusing: 0, not_shown: null },
    fix: "Fade only disabled controls. Give enabled controls full contrast.",
  },

  copy_labels: { dim: "copy", fix: "Use plain, specific words. Start button labels with a verb that names the result." },
  copy_status: { dim: "copy", fix: "Use status labels that a new user understands." },
  copy_controls_labeled: { dim: "copy", fix: "Give each dropdown and selector a label that says what it sets." },

  trust_usage: { dim: "trust", gate: "limits", fix: "Show usage limits, such as credits or trial days, with a next step." },
  trust_onboarding: {
    dim: "trust",
    choices: { light: 1, blocking: 0, none: null },
    fix: "Replace blocking tours with small, optional help.",
  },
};

export const VISUAL_RULES: Record<VisualId, Rule> = {
  color_role: { dim: "color", weight: 2, fix: "Use a neutral base. Use color only for status, tags, selection, and the main action." },
  color_accents: { dim: "color", fix: "Use one accent color, plus a small set of status colors." },
  color_semantic: { dim: "color", fix: "Give each color one meaning, such as red only for errors and destructive actions." },
  color_not_alone: { dim: "color", fix: "Add an icon or a label wherever color shows a state." },
  color_dark_layers: {
    dim: "color",
    choices: { tonal: 1, flat: 0, not_shown: null },
    fix: "In dark themes, show higher layers with lighter surfaces or subtle borders, not shadows.",
  },

  spacing_grouping: { dim: "spacing", weight: 2, fix: "Put related items close together, make gaps between groups wider, and reuse the same gap sizes." },
  spacing_alignment: { dim: "spacing", fix: "Align elements to shared left edges and columns." },
  spacing_consistent: { dim: "spacing", fix: "Give repeated components the same padding and height." },

  type_hierarchy: { dim: "type", weight: 2, fix: "Make type hierarchy with size, weight, and grey tone before you add a second family." },
  type_scale: { dim: "type", fix: "Use a small type scale with clearly different steps, one step per role." },
  type_line_height: { dim: "type", fix: "Set body line height near 1.5 times the font size." },
  type_numbers: {
    dim: "type",
    choices: { aligned: 1, ragged: 0, not_shown: null },
    fix: "Use tabular figures and align number columns.",
  },
  type_mono: {
    dim: "type",
    choices: { mono: 1, mixed: 0.3, not_shown: null },
    fix: "Set code, commands, IDs, and paths in one monospace font.",
  },

  icons_one_set: { dim: "icons", fix: "Use one icon set with one stroke weight." },
  icons_size: { dim: "icons", fix: "Use one icon size in each context, and center icons with their labels." },
  icons_meaning: { dim: "icons", fix: "Use common symbols for icon-only buttons, or add a label." },

  contrast_secondary: { dim: "contrast", weight: 2, fix: "Make secondary text, placeholders, and metadata darker until they are easy to read." },
  contrast_boundaries: { dim: "contrast", fix: "Give inputs, buttons, and selected items edges with at least 3:1 contrast." },

  restraint_noise: { dim: "restraint", fix: "Remove decoration that does not explain something: extra borders, shadows, glows, and badges." },

  overflow_long_text: {
    dim: "overflow",
    choices: { ellipsis: 1, cut: 0.2, breaks_layout: 0, not_shown: null },
    fix: "Cut long text with an ellipsis, and keep the layout fixed.",
  },
  overflow_scroll_cue: {
    dim: "overflow",
    choices: { cue: 1, no_cue: 0, not_shown: null },
    fix: "Show that a region scrolls: let the last item show partly, or add a fade or a scrollbar.",
  },
};

export const CONSISTENCY_RULES: Record<ConsistencyId, Rule> = {
  consistency_terms: { dim: "consistency", weight: 2, fix: "Use one name for each concept on every screen." },
  consistency_components: { dim: "consistency", fix: "Use the same component styles on every screen." },
  consistency_navigation: { dim: "consistency", fix: "Keep the navigation in the same place with the same items." },
  consistency_color: { dim: "consistency", fix: "Keep each color's meaning the same on every screen." },
  consistency_type: { dim: "consistency", fix: "Use the same type style for the same role on every screen." },
};

export const SLOP_RULES: Record<SlopId, SlopRule> = {
  slop_grid_background: { dim: "slop", rule: "Decorative grid-line background", fix: "Remove the grid. Keep grids for canvases, maps, and measuring." },
  slop_rounded_border_accent: { dim: "slop", rule: "Border accent on rounded element", fix: "Use a light border, or let the background mark the card." },
  slop_side_stripe: { dim: "slop", rule: "Side-tab accent border", fix: "Remove the side stripe unless it shows a status or a warning." },
  slop_border_and_shadow: { dim: "slop", rule: "Hairline border with wide shadow", fix: "Keep the border or the shadow, not both." },
  slop_glass: { dim: "slop", rule: "Glassmorphism everywhere", fix: "Use blur and glass only for a real layering problem." },
  slop_stripes: { dim: "slop", rule: "Repeating-gradient stripes", fix: "Use a plain surface." },
  slop_extreme_radius: { dim: "slop", rule: "Extreme border-radius on cards", fix: "Make the corner radius fit the size of the card." },
  slop_rough_illustration: { dim: "slop", rule: "Rough SVG illustrations", fix: "Use a well-made illustration or photo, or remove it." },
  slop_placeholder_illustration: { dim: "slop", rule: "Placeholder-style illustrations", fix: "Use an image that says something specific about the product." },

  slop_eyebrow_label: { dim: "slop", rule: "Label above a heading", fix: "Remove the label, or put its useful words in the heading." },
  slop_icon_tile_heading: { dim: "slop", rule: "Icon tile stacked above heading", fix: "Put the icon beside the heading, or remove the tile." },
  slop_badge_headline: { dim: "slop", rule: "Badge above the main headline", fix: "Remove the badge, or move its words into the headline or body." },
  slop_italic_serif_headline: { dim: "slop", rule: "Italic serif display headline", fix: "Use a type style that fits the product." },
  slop_hero_headline: { dim: "slop", rule: "Oversized hero headline", fix: "Shorten the headline or make it smaller." },
  slop_flat_hierarchy: { dim: "slop", rule: "Flat type hierarchy", fix: "Make headings differ from body text in size, weight, or spacing." },
  slop_tight_tracking: { dim: "slop", rule: "Crushed letter spacing", fix: "Loosen the letter spacing, mostly at small sizes." },

  slop_glow: { dim: "slop", rule: "Radial-gradient halo or soft spotlight", fix: "Remove the glow. Guide attention with spacing, contrast, or a heading." },
  slop_ai_palette: { dim: "slop", rule: "AI color palette", fix: "Build the palette from the product's identity and use." },
  slop_dark_glow: { dim: "slop", rule: "Dark mode with glowing accents", fix: "Keep the dark theme, but remove the glow." },
  slop_gradient_text: { dim: "slop", rule: "Gradient text", fix: "Use one solid color. Add emphasis with size or weight." },

  slop_numbered_labels: { dim: "slop", rule: "Tiny numbered section labels", fix: "Use numbers only for steps or a real order." },
  slop_hero_metric: { dim: "slop", rule: "Hero metric layout", fix: "Lead with a metric only when it helps, and give it context." },
  slop_card_grid: { dim: "slop", rule: "Identical card grids", fix: "Group related ideas and vary the layout." },
  slop_nested_cards: { dim: "slop", rule: "Nested cards", fix: "Flatten the cards. Use spacing, type, and dividers." },
  slop_monotonous_spacing: { dim: "slop", rule: "Monotonous spacing", fix: "Put related items close together. Make gaps between groups wider." },
  slop_hidden_image: { dim: "slop", rule: "Images hidden under overlays", fix: "Make the overlay lighter, or remove the image." },

  slop_em_dash: { dim: "slop", rule: "Em-dash overuse", fix: "Use a full stop between thoughts." },
  slop_marketing_claims: { dim: "slop", rule: "Generic marketing claims", fix: "Say what people can do and what gets better for them." },
  slop_forced_contrast: { dim: "slop", rule: "Forced contrast", fix: "State the difference directly, only when it matters." },
  slop_theater: { dim: "slop", rule: "Calling things \"theater\"", fix: "Name what does not work, and say why." },

  quality_tiny_text: { dim: "quality", rule: "Tiny interface text", fix: "Make the text larger. Start body text near 16 px." },
  quality_all_caps: { dim: "quality", rule: "All-caps body text", fix: "Use sentence case. Keep capitals for short labels." },
  quality_gray_on_color: { dim: "quality", rule: "Gray text on colored background", fix: "Use a darker tint of the surface color, or light text." },
  quality_heading_spacing: { dim: "quality", rule: "Heading closer to the previous section", fix: "Put more space above a heading than below it." },
  quality_cramped: { dim: "quality", rule: "Cramped padding", fix: "Add padding from your spacing scale." },
  quality_long_lines: { dim: "quality", rule: "Line length too long", fix: "Keep body lines near 65 to 75 characters." },
  quality_repeated_text: { dim: "quality", rule: "Same text repeated inside one container", fix: "Show the label once, where it matters." },
  quality_text_covered: { dim: "quality", rule: "Text covered by another element", breaking: true, fix: "Move the layer, or give the text clear space." },
  quality_overflow: { dim: "quality", rule: "Content overflowing or clipped menus", breaking: true, fix: "Let content wrap, and render menus outside the clipping container." },
  quality_broken_image: { dim: "quality", rule: "Broken or placeholder image", breaking: true, fix: "Add the real image and make sure it loads, or remove it." },
  quality_scroll_edge: { dim: "quality", rule: "Content cut at a fixed header", fix: "Add a divider or a shadow where scrolled content meets a fixed header." },
  quality_repeated_identifier: { dim: "quality", rule: "Same name repeated across regions", fix: "Show each name once in each region, and remove copies that add nothing." },
};

const INTERACTION_FIXES = {
  states_feedback: "Show a pressed or selected state at once, and confirm the result near the control.",
  feedback_selected: "Give the control a visible pressed or selected state.",
  feedback_focus_visible: "Show a clear focus ring on the element that has keyboard focus.",
};
const FOCUS_CHOICES: Record<string, number | null> = { visible: 1, missing: 0, not_keyboard: null };
const LAYOUT_SHIFT = { rule: "Animation that changes layout", fix: "Do not move nearby content when a control changes. Use transforms." };

const CRAFT_FIXES = {
  textContrastAA: "Raise text contrast to WCAG AA: 4.5:1 for body text, 3:1 for large text.",
  nonTextContrast3: "Give icons, input borders, and focus rings at least 3:1 contrast.",
  targetSize24px: "Make click and tap targets at least 24 by 24 px.",
  spacingOnScale: "Use one spacing scale, for example multiples of 4 px.",
  matchesDesignSystem: "Use only the fonts, colors, radii, and sizes in DESIGN.md, or update DESIGN.md.",
  lineLength75: "Limit body text to about 75 characters per line.",
  noHorizontalOverflow: "Remove elements that are wider than their container.",
  narrowViewportOk: "Make the screen work at 375 px wide with no horizontal scroll.",
} as const;

const JUDGMENT_WORDS =
  /\b(clean|beautiful|intuitive|modern|sleek|elegant|polished|cluttered|messy|ugly|user-friendly|well[- ]designed|good|bad|nice|great|confusing|easy|professional|premium)\b/gi;

export interface Issue {
  rule: string;
  kind: PenaltyDim;
  p: number;
}

export interface Result {
  verdict: "well_designed" | "needs_work" | "poorly_designed" | "review";
  score: number;
  dimensions: Partial<Record<Dim, number>>;
  blockers: string[];
  weakDimensions: Dim[];
  issues: Issue[];
  fixes: string[];
  uncertain: string[];
}

interface Item {
  key: string;
  fix: string;
  value: number;
  weight: number;
  uncertain: boolean;
}

interface Found extends Issue {
  fix: string;
  breaking: boolean;
}

export function toClefImage(bytes: ArrayBuffer | Uint8Array, contentType: ImageType): ClefImage {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return { content_type: contentType, base64: btoa(binary) };
}

export function findJudgmentWords(context: ScreenContext): string[] {
  const text = [context.screen.purpose, context.app.primary_job, ...context.image_legend].join(" ");
  return [...new Set((text.match(JUDGMENT_WORDS) ?? []).map((w) => w.toLowerCase()))];
}

function checkImages(images: ClefImage[], legend: string[], max: number) {
  if (images.length < 1 || images.length > max) throw new Error(`Clef takes 1 to ${max} images here.`);
  if (images.length !== legend.length) throw new Error("image_legend needs one line per image.");
}

export function buildRequests(capture: Capture) {
  const { context, images, related } = capture;
  checkImages(images, context.image_legend, 4);
  const base = { model: spec.model, state: context, images };
  let consistency = null;
  if (related) {
    checkImages(related.images, related.image_legend, 3);
    consistency = {
      model: spec.model,
      state: {
        app: context.app,
        image_legend: [`Image 1: ${context.screen.name}`, ...related.image_legend.map((l, i) => `Image ${i + 2}: ${l}`)],
        page_text: [context.page_text, related.page_text].filter(Boolean).join("\n\n"),
      },
      images: [images[0], ...related.images],
      questions: spec.consistency,
    };
  }
  return {
    screen: { ...base, questions: spec.screen },
    visual: { ...base, questions: spec.visual },
    slop: { ...base, questions: spec.slop },
    interactions: (capture.interactions ?? []).map((i) => ({
      model: spec.model,
      state: {
        app: context.app,
        screen: context.screen,
        action: i.action,
        image_legend: ["Image 1: the screen before the action", "Image 2: the screen after the action"],
      },
      images: [i.before, i.after],
      questions: spec.interaction,
    })),
    consistency,
  };
}

export async function evaluate(ai: AiBinding, capture: Capture): Promise<Result> {
  const requests = buildRequests(capture);
  const modelId = MODEL_IDS[spec.model];
  if (!modelId) throw new Error(`Unknown Clef model: ${spec.model}`);
  const ask = async (body: object) => ((await ai.run(modelId, body)) as { answers: Record<string, Answer> }).answers;
  const [screen, visual, slop, consistency, ...interactions] = await Promise.all([
    ask(requests.screen),
    ask(requests.visual),
    ask(requests.slop),
    requests.consistency ? ask(requests.consistency) : Promise.resolve(undefined),
    ...requests.interactions.map(ask),
  ]);
  return scoreDesign(capture, { screen, visual, slop, interactions, consistency });
}

function levelsOf(criteria: unknown): number {
  return Array.isArray(criteria) ? criteria.length - 1 : 1;
}

function confidenceOf(a: Answer): number | null {
  if (a.type === "noul") return null;
  if (a.confidence !== undefined) return a.confidence;
  const p = Object.values(a.probabilities ?? {});
  if (p.length < 2) return 1;
  const entropy = -p.reduce((sum, x) => sum + (x > 0 ? x * Math.log(x) : 0), 0);
  return 1 - entropy / Math.log(p.length);
}

function isUncertain(a: Answer): boolean {
  if (a.type === "noul") return a.noul > THRESHOLDS.noulUncertainLow && a.noul < THRESHOLDS.noulUncertainHigh;
  return (confidenceOf(a) ?? 1) < THRESHOLDS.minConfidence;
}

function valueOf(a: Answer, criteria: unknown, choices?: Record<string, number | null>): number | null {
  if (a.type === "noul") return a.noul;
  if (a.type === "score") return a.score / levelsOf(criteria);
  return choices?.[a.choice] ?? null;
}

function gatesFor(capture: Capture, screen: Record<string, Answer>): Record<Gate, boolean> {
  const applies = (g: ScreenGate) => {
    const known = capture.known?.[g];
    if (known !== undefined) return known;
    const a = screen[APPLIES[g]];
    return a?.type === "noul" && a.noul >= THRESHOLDS.appliesAt;
  };
  return {
    ai: applies("ai"),
    async: applies("async"),
    collection: applies("collection"),
    editing: applies("editing"),
    empty: applies("empty"),
    errors: applies("errors"),
    limits: applies("limits"),
    keyboard: capture.context.app.platform !== "mobile",
  };
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const round = (n: number) => Math.round(n * 100) / 100;

export function scoreDesign(capture: Capture, answers: Answers): Result {
  const checks = capture.checks ?? {};
  const gates = gatesFor(capture, answers.screen);
  const byDim = new Map<Dim, Item[]>();
  const add = (dim: Dim, item: Item) => byDim.set(dim, [...(byDim.get(dim) ?? []), item]);
  const found: Found[] = [];
  const uncertainIssues: { key: string; dim: PenaltyDim }[] = [];
  const blockers: string[] = [];

  const scoreSet = (questions: Record<string, unknown>, rules: Record<string, Rule>, set: Record<string, Answer> | undefined) => {
    if (!set) return;
    for (const [id, rule] of Object.entries(rules)) {
      const answer = set[id];
      if (!answer || (rule.gate && !gates[rule.gate])) continue;
      const value = valueOf(answer, (questions[id] as { criteria?: unknown }).criteria, rule.choices);
      if (value === null) continue;
      add(rule.dim, { key: id, fix: rule.fix, value, weight: rule.weight ?? 1, uncertain: isUncertain(answer) });
    }
  };
  scoreSet(spec.screen, SCREEN_RULES, answers.screen);
  scoreSet(spec.visual, VISUAL_RULES, answers.visual);
  scoreSet(spec.consistency, CONSISTENCY_RULES, answers.consistency);

  const runs = answers.interactions;
  const collect = (id: keyof typeof spec.interaction) =>
    runs.map((r) => r[id]).filter((a): a is Answer => a !== undefined);

  const feedback = collect("states_feedback");
  if (feedback.length > 0) {
    const values = feedback.map((a) => valueOf(a, spec.interaction.states_feedback.criteria) ?? 0);
    if (Math.min(...values) < 0.34) blockers.push("An action gives no visible feedback near the control.");
    add("states", { key: "states_feedback", fix: INTERACTION_FIXES.states_feedback, value: mean(values), weight: 2, uncertain: feedback.some(isUncertain) });
  }
  const selected = collect("feedback_selected").filter((a) => a.type === "noul");
  if (selected.length > 0) {
    const values = selected.map((a) => valueOf(a, undefined) ?? 0);
    add("states", { key: "feedback_selected", fix: INTERACTION_FIXES.feedback_selected, value: mean(values), weight: 1, uncertain: selected.some(isUncertain) });
  }
  const focus = collect("feedback_focus_visible")
    .map((a) => ({ a, v: valueOf(a, undefined, FOCUS_CHOICES) }))
    .filter((x): x is { a: Answer; v: number } => x.v !== null);
  if (focus.length > 0) {
    const values = focus.map((x) => x.v);
    if (Math.min(...values) === 0) blockers.push("Keyboard focus is not visible.");
    add("contrast", { key: "feedback_focus_visible", fix: INTERACTION_FIXES.feedback_focus_visible, value: mean(values), weight: 2, uncertain: focus.some((x) => isUncertain(x.a)) });
  }
  const shifts = collect("feedback_layout_shift").map((a) => (a.type === "noul" ? a.noul : 0));
  const shift = Math.max(0, ...shifts);
  if (shift >= PENALTY.detectAt) found.push({ ...LAYOUT_SHIFT, kind: "quality", p: shift, breaking: false });

  for (const key of Object.keys(CRAFT_FIXES) as (keyof typeof CRAFT_FIXES)[]) {
    const passed = checks[key];
    if (passed === undefined) continue;
    add("craft", { key, fix: CRAFT_FIXES[key], value: passed ? 1 : 0, weight: 1, uncertain: false });
  }

  for (const id of Object.keys(SLOP_RULES) as SlopId[]) {
    if (id === "quality_long_lines" && checks.lineLength75 !== undefined) continue;
    if (id === "quality_overflow" && checks.noHorizontalOverflow === true) continue;
    const answer = answers.slop[id];
    if (answer?.type !== "noul") continue;
    const rule = SLOP_RULES[id];
    if (isUncertain(answer)) uncertainIssues.push({ key: id, dim: rule.dim });
    if (answer.noul >= PENALTY.detectAt)
      found.push({ rule: rule.rule, kind: rule.dim, p: answer.noul, fix: rule.fix, breaking: rule.breaking === true });
  }
  for (const f of checks.findings ?? [])
    found.push({ rule: f.rule, kind: f.kind, p: 1, fix: f.fix ?? `Fix the ${f.rule} finding.`, breaking: false });

  const dimensions: Partial<Record<Dim, number>> = {};
  const impacts: { fix: string; impact: number; uncertain: boolean; share: number; key: string }[] = [];
  let totalWeight = 0;
  let weighted = 0;

  for (const [dim, items] of byDim) {
    const itemWeight = items.reduce((sum, i) => sum + i.weight, 0);
    const dimScore = items.reduce((sum, i) => sum + i.value * i.weight, 0) / itemWeight;
    dimensions[dim] = round(dimScore);
    totalWeight += DIM_WEIGHTS[dim];
    weighted += DIM_WEIGHTS[dim] * dimScore;
    for (const item of items) {
      const share = (DIM_WEIGHTS[dim] * item.weight) / itemWeight;
      impacts.push({ key: item.key, fix: item.fix, share, uncertain: item.uncertain, impact: item.value < THRESHOLDS.weakAnswer ? share * (1 - item.value) : 0 });
    }
  }

  for (const dim of ["slop", "quality"] as const) {
    const per = PENALTY.perIssue[dim];
    const issues = found.filter((f) => f.kind === dim);
    const dimScore = Math.max(0, 1 - per * issues.reduce((sum, f) => sum + f.p, 0));
    dimensions[dim] = round(dimScore);
    totalWeight += DIM_WEIGHTS[dim];
    weighted += DIM_WEIGHTS[dim] * dimScore;
    for (const f of issues) impacts.push({ key: f.rule, fix: `${f.rule}: ${f.fix}`, share: 0, uncertain: false, impact: DIM_WEIGHTS[dim] * per * f.p });
    const unsure = uncertainIssues.filter((u) => u.dim === dim).length;
    impacts.push({ key: `${dim}_uncertain`, fix: "", impact: 0, uncertain: unsure > 0, share: Math.min(DIM_WEIGHTS[dim], unsure * DIM_WEIGHTS[dim] * per) });
  }

  const score = weighted / totalWeight;
  const uncertainShare = impacts.filter((i) => i.uncertain).reduce((sum, i) => sum + i.share, 0) / totalWeight;

  if (checks.textContrastAA === false) blockers.push("Text contrast fails WCAG AA.");
  if (checks.noHorizontalOverflow === false) blockers.push("An element is wider than its container.");
  for (const f of found) if (f.breaking && f.p >= PENALTY.breakingAt) blockers.push(`${f.rule}.`);
  const slopCount = found.filter((f) => f.kind === "slop").length;
  if (slopCount >= PENALTY.slopBlockerCount) blockers.push(`${slopCount} AI-slop patterns: the screen reads as generated.`);

  const fixes = impacts
    .filter((i) => i.impact > 0)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, THRESHOLDS.maxFixes)
    .map((i) => i.fix);

  const weakDimensions = (Object.entries(dimensions) as [Dim, number][])
    .filter(([, v]) => v < THRESHOLDS.dimensionFloor)
    .map(([d]) => d);

  const verdict: Result["verdict"] =
    uncertainShare > THRESHOLDS.maxUncertainShare
      ? "review"
      : score >= THRESHOLDS.wellDesigned && blockers.length === 0 && weakDimensions.length === 0
        ? "well_designed"
        : score >= THRESHOLDS.needsWork
          ? "needs_work"
          : "poorly_designed";

  return {
    verdict,
    score: round(score),
    dimensions,
    blockers,
    weakDimensions,
    issues: found.map(({ rule, kind, p }) => ({ rule, kind, p: round(p) })),
    fixes,
    uncertain: [
      ...impacts.filter((i) => i.uncertain && !i.key.endsWith("_uncertain")).map((i) => i.key),
      ...uncertainIssues.map((u) => u.key),
    ],
  };
}
