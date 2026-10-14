// Usage: bun evals/design/run-clef.ts <case-dir> [--rubric <subdir>] [--reuse]
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN unless --reuse rescores saved answers.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Schema } from "effect";
import policy from "./acceptance.v1.json" with { type: "json" };
import type { Answer, Answers, Capture, ClefImage, ImageType, ScreenGate } from "./design-eval.ts";

type Scorer = typeof import("./design-eval.ts");

type Spec = typeof import("./design-eval.questions.json");

type AreaId = keyof typeof policy.areas;

type AnswerSet = Record<string, Answer>;

interface Question {
  type: string;
  instructions: string;
  criteria?: object;
}

const Gate = Schema.Literals(["ai", "async", "collection", "editing", "empty", "errors", "limits"]);

const CaseFile = Schema.Struct({
  context: Schema.String,
  images: Schema.Array(Schema.String),
  interactions: Schema.optional(Schema.Array(Schema.Struct({ action: Schema.String, before: Schema.String, after: Schema.String }))),
  related: Schema.optional(
    Schema.Struct({ images: Schema.Array(Schema.String), image_legend: Schema.Array(Schema.String), page_text: Schema.optional(Schema.String) }),
  ),
  known: Schema.Record(Gate, Schema.Boolean),
  knownSource: Schema.String,
});

const Context = Schema.Struct({
  app: Schema.Struct({
    name: Schema.String,
    category: Schema.String,
    platform: Schema.Literals(["web", "desktop", "mobile"]),
    primary_user: Schema.String,
    primary_job: Schema.String,
  }),
  screen: Schema.Struct({ name: Schema.String, purpose: Schema.String }),
  image_legend: Schema.Array(Schema.String),
  page_text: Schema.optional(Schema.String),
});

const Probabilities = Schema.optional(Schema.Record(Schema.String, Schema.Number));

const ClefAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("score"), score: Schema.Number, confidence: Schema.optional(Schema.Number), probabilities: Probabilities }),
  Schema.Struct({ type: Schema.Literal("choice"), choice: Schema.String, confidence: Schema.optional(Schema.Number), probabilities: Probabilities }),
]);

const ClefResponse = Schema.Struct({ result: Schema.Struct({ answers: Schema.Record(Schema.String, ClefAnswer) }) });

const SavedAnswers = Schema.Struct({ response: ClefResponse });

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const copyAnswers = (answers: Readonly<Record<string, Answer>>) => ({ ...answers });

const rubricArg = process.argv.indexOf("--rubric");

const rubric = (rubricArg > 0 ? process.argv[rubricArg + 1] : "") ?? "";

const rubricDir = join(import.meta.dir, rubric);

const scorer: Scorer = await import(join(rubricDir, "design-eval.ts"));

const spec: Spec = JSON.parse(readFileSync(join(rubricDir, "design-eval.questions.json"), "utf8"));

const { buildRequests, findJudgmentWords, scoreDesign, toClefImage, SCREEN_RULES, VISUAL_RULES, THRESHOLDS } = scorer;

const AREAS: AreaId[] = ["layout", "spacing", "color-depth", "usability"];

const TYPES = new Map<string, ImageType>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

const dir = process.argv[2] ?? "";

const reuse = process.argv.includes("--reuse");

if (!dir) throw new Error("Pass a case directory.");

const out = join(dir, rubric);

mkdirSync(out, { recursive: true });

const file = Schema.decodeUnknownSync(CaseFile)(readJson(join(dir, "capture.json")));

const known: Record<ScreenGate, boolean> = file.known;

const imageMeta = new Map<string, { bytes: number; sha256: string }>();

const image = (name: string): ClefImage => {
  const bytes = readFileSync(join(dir, name));

  if (bytes.length > 4 * 1024 * 1024) throw new Error(`${name} is larger than 4 MiB.`);

  const type = TYPES.get(extname(name).toLowerCase());

  if (!type) throw new Error(`${name} must be PNG, JPEG or WebP.`);

  imageMeta.set(name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

  return toClefImage(bytes, type);
};

const context = Schema.decodeUnknownSync(Context)(readJson(join(dir, file.context)));

const capture: Capture = {
  context: { ...context, image_legend: [...context.image_legend] },
  images: file.images.map(image),
  interactions: file.interactions?.map((i) => ({ action: i.action, before: image(i.before), after: image(i.after) })),
  related: file.related && {
    images: file.related.images.map(image),
    image_legend: [...file.related.image_legend],
    page_text: file.related.page_text,
  },
  known,
};

const judged = findJudgmentWords(capture.context);

if (judged.length) throw new Error(`context.json contains judgment words: ${judged.join(", ")}`);

const requests = buildRequests(capture);

const allQuestions = new Map<string, Question>(
  Object.entries({ ...requests.screen.questions, ...requests.visual.questions, ...requests.slop.questions }),
);

const interactionQuestions = new Map<string, Question>(Object.entries(spec.interaction));

const areaQuestions = (a: AreaId) => policy.areas[a].questions.filter((q) => allQuestions.has(q));

const assigned = AREAS.flatMap(areaQuestions);

const unassigned = [...allQuestions.keys()].filter((q) => !q.startsWith("applies_") && !assigned.includes(q));

if (unassigned.length || new Set(assigned).size !== assigned.length) {
  throw new Error(`Area map must cover each question once: ${unassigned.join(", ")}`);
}

const pick = (ids: string[]) => Object.fromEntries(ids.flatMap((id) => (allQuestions.has(id) ? [[id, allQuestions.get(id)]] : [])));

type Built = ReturnType<Scorer["buildRequests"]>;

type ClefRequest =
  | (Omit<Built["screen"], "questions"> & { questions: Record<string, Question | undefined> })
  | Built["interactions"][number]
  | NonNullable<Built["consistency"]>;

const jobs: { name: string; body: ClefRequest }[] = [
  ...AREAS.map((a) => ({ name: a, body: { ...requests.screen, questions: pick(areaQuestions(a)) } })),
  ...requests.interactions.map((body, i) => ({ name: `interaction-${i + 1}`, body })),
  ...(requests.consistency ? [{ name: "consistency", body: requests.consistency }] : []),
];

async function send(body: ClefRequest) {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;

  if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  return { status: res.status, text };
}

const parseAnswers = (text: string) => {
  try {
    return copyAnswers(Schema.decodeUnknownSync(ClefResponse)(JSON.parse(text)).result.answers);
  } catch {
    return null;
  }
};

async function ask(name: string, body: ClefRequest): Promise<AnswerSet | null> {
  const path = join(out, `${name}.answers.json`);

  if (reuse && existsSync(path)) return copyAnswers(Schema.decodeUnknownSync(SavedAnswers)(readJson(path)).response.result.answers);

  const statuses: number[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, text } = await send(body);

    statuses.push(status);

    const answers = status === 200 ? parseAnswers(text) : null;

    if (answers) {
      const saved = { status, attemptStatuses: statuses, timestamp: new Date().toISOString(), response: JSON.parse(text) };

      writeFileSync(path, JSON.stringify(saved, null, 2));

      return answers;
    }

    if (attempt === 1) {
      writeFileSync(join(out, `${name}.error.json`), JSON.stringify({ attemptStatuses: statuses, response: text }, null, 2));
      console.error(`${name}: failed after retry (${statuses.join(", ")})`);
    }
  }

  return null;
}

const got = new Map<string, AnswerSet | null>(await Promise.all(jobs.map(async (j) => [j.name, await ask(j.name, j.body)] as const)));

const failed = [...got].flatMap(([name, answers]) => (answers ? [] : [name]));

const split = (ids: string[]) => {
  const answers: Answers = { screen: {}, visual: {}, slop: {}, interactions: [] };

  for (const area of AREAS) {
    for (const [id, a] of Object.entries(got.get(area) ?? {})) {
      if (!ids.includes(id)) continue;

      const set = id in spec.screen ? "screen" : id in spec.visual ? "visual" : "slop";

      answers[set][id] = a;
    }
  }

  return answers;
};

const interactions = jobs.flatMap((j) => {
  const answers = j.name.startsWith("interaction-") ? got.get(j.name) : null;

  return answers ? [answers] : [];
});

const consistency = got.get("consistency") ?? undefined;

const result = scoreDesign(capture, { ...split(assigned), interactions, consistency });

const screenRules = new Map(Object.entries(SCREEN_RULES));

const visualRules = new Map(Object.entries(VISUAL_RULES));

const ruleOf = (id: string) => screenRules.get(id) ?? visualRules.get(id);

const FOCUS_CHOICES = new Map<string, number | null>([
  ["visible", 1],
  ["missing", 0],
  ["not_keyboard", null],
]);

const uncertain = (a: Answer) =>
  a.type === "noul"
    ? a.noul > THRESHOLDS.noulUncertainLow && a.noul < THRESHOLDS.noulUncertainHigh
    : (a.confidence ?? 1) < THRESHOLDS.minConfidence;

const isGate = (gate: string): gate is ScreenGate => Schema.is(Gate)(gate);

function normalized(id: string, a: Answer) {
  const gate = ruleOf(id)?.gate;

  if (gate && isGate(gate) && !known[gate]) return null;

  const penalty = id.startsWith("slop_") || id.startsWith("quality_") || id === "feedback_layout_shift";

  if (a.type === "noul") return penalty ? 1 - a.noul : a.noul;

  if (a.type === "score") {
    const criteria = (allQuestions.get(id) ?? interactionQuestions.get(id))?.criteria;

    return a.score / ((Array.isArray(criteria) ? criteria.length : 2) - 1);
  }

  const choices = id === "feedback_focus_visible" ? FOCUS_CHOICES : new Map(Object.entries(ruleOf(id)?.choices ?? {}));

  return choices.get(a.choice) ?? null;
}

interface Low {
  question: string;
  value: number;
  uncertain: boolean;
  source: string;
}

interface Floor {
  low: Low[];
  uncertain: string[];
}

function answerFloor(sets: readonly (readonly [string, AnswerSet | null | undefined])[]): Floor {
  const low: Low[] = [];
  const unsure: string[] = [];

  for (const [source, set] of sets) {
    for (const [id, a] of Object.entries(set ?? {})) {
      const value = normalized(id, a);

      if (value === null) continue;

      if (uncertain(a)) unsure.push(`${source}:${id}`);

      if (value < policy.screenPass.minAnswer) {
        low.push({ question: id, value: Math.round(value * 1000) / 1000, uncertain: uncertain(a), source });
      }
    }
  }

  return { low, uncertain: unsure };
}

const interactionSets = interactions.map((x, i): [string, AnswerSet] => [`interaction-${i + 1}`, x]);

const ownsUsability = (area: AreaId) => area === "usability";

const areaReports = new Map(
  AREAS.map((area) => {
    const usability = ownsUsability(area);

    const r = scoreDesign(capture, {
      ...split(areaQuestions(area)),
      interactions: usability ? interactions : [],
      consistency: usability ? consistency : undefined,
    });

    const floor = answerFloor([[area, got.get(area)], ...(usability ? [...interactionSets, ["consistency", consistency] as const] : [])]);

    const missing = [
      ...(got.get(area) ? [] : [`${area} request failed`]),
      ...(usability && interactions.length === 0 ? ["no interaction captures"] : []),
    ];

    const majors = [
      ...r.blockers,
      ...r.weakDimensions.map((d) => `dimension ${d} below ${THRESHOLDS.dimensionFloor}`),
      ...floor.low.flatMap((l) => (l.uncertain ? [] : [`${l.question} = ${l.value} (below ${policy.areaPass.minAnswer.toFixed(2)})`])),
    ];

    const status = majors.length || r.score < policy.areaPass.minScore ? "fail" : missing.length || floor.uncertain.length ? "review" : "pass";

    const report = {
      status,
      score: r.score,
      dimensions: r.dimensions,
      blockers: r.blockers,
      weakDimensions: r.weakDimensions,
      majors,
      lowAnswers: floor.low,
      uncertain: floor.uncertain,
      missingEvidence: missing,
      issues: r.issues,
      fixes: r.fixes,
    };

    return [area, report] as const;
  }),
);

const screenFloor = answerFloor([...AREAS.map((a): [string, AnswerSet | null | undefined] => [a, got.get(a)]), ...interactionSets, ["consistency", consistency]]);

const statusOf = (a: AreaId) => areaReports.get(a)?.status ?? "fail";

const reasons = [
  ...(result.score < policy.screenPass.minScore ? [`score ${result.score} < ${policy.screenPass.minScore}`] : []),
  ...result.blockers.map((b) => `blocker: ${b}`),
  ...result.weakDimensions.map((d) => `weak dimension: ${d}`),
  ...(result.verdict === "review" ? ["verdict is review"] : []),
  ...screenFloor.low.flatMap((l) => (l.uncertain ? [] : [`answer below ${policy.screenPass.minAnswer.toFixed(2)}: ${l.question} = ${l.value}`])),
  ...AREAS.flatMap((a) => (statusOf(a) === "pass" ? [] : [`area ${a}: ${statusOf(a)}`])),
  ...failed.map((n) => `request failed: ${n}`),
];

const anyReview = result.verdict === "review" || AREAS.some((a) => statusOf(a) === "review");

const acceptance = {
  policy: policy.version,
  pass: reasons.length === 0,
  status: reasons.length === 0 ? "pass" : anyReview ? "review_or_fail" : "fail",
  reasons,
  lowAnswers: screenFloor.low,
};

writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));

writeFileSync(join(out, "areas.json"), JSON.stringify(Object.fromEntries(areaReports), null, 2));

writeFileSync(join(out, "acceptance.json"), JSON.stringify(acceptance, null, 2));

writeFileSync(join(out, "images.json"), JSON.stringify(Object.fromEntries(imageMeta), null, 2));

const summary = Object.fromEntries(AREAS.map((a) => [a, `${statusOf(a)} ${areaReports.get(a)?.score}`]));

console.log(JSON.stringify({ case: out, score: result.score, verdict: result.verdict, pass: acceptance.pass, areas: summary, failed }));
