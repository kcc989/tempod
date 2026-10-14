// Usage: bun evals/design/run-design.ts <case-dir> [--reuse]
// Acceptance v2 (rubric v3 as a policy over the unchanged questions), averaged over re-encoded replicates, with measured spacing and color/depth gates.
// Run `python3 evals/design/measure.py <case-dir>` first. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Schema } from "effect";
import policy from "./acceptance.v2.json" with { type: "json" };
import spec from "./design-eval.questions.json" with { type: "json" };
import {
  buildRequests,
  findJudgmentWords,
  scoreDesign,
  toClefImage,
  SCREEN_RULES,
  THRESHOLDS,
  VISUAL_RULES,
  type Answer,
  type Answers,
  type Capture,
  type Checks,
  type ClefImage,
  type ImageType,
  type Result,
  type ScreenGate,
} from "./design-eval.ts";

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
  interactions: Schema.optional(
    Schema.Array(Schema.Struct({ action: Schema.String, before: Schema.String, after: Schema.String })),
  ),
  related: Schema.optional(
    Schema.Struct({
      images: Schema.Array(Schema.String),
      image_legend: Schema.Array(Schema.String),
      page_text: Schema.optional(Schema.String),
    }),
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

const Measured = Schema.Struct({
  checks: Schema.Record(Schema.String, Schema.Struct({ pass: Schema.NullOr(Schema.Boolean) })),
});

const Probabilities = Schema.optional(Schema.Record(Schema.String, Schema.Number));

const ClefAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    confidence: Schema.optional(Schema.Number),
    probabilities: Probabilities,
  }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    confidence: Schema.optional(Schema.Number),
    probabilities: Probabilities,
  }),
]);

const ClefResponse = Schema.Struct({
  result: Schema.Struct({ answers: Schema.Record(Schema.String, ClefAnswer) }),
});

const SavedAnswers = Schema.Struct({ response: ClefResponse });

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const copyAnswers = (answers: Readonly<Record<string, Answer>>) => ({ ...answers });

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

const out = join(dir, "v3");

mkdirSync(out, { recursive: true });

const file = Schema.decodeUnknownSync(CaseFile)(readJson(join(dir, "capture.json")));

const known: Record<ScreenGate, boolean> = file.known;

const measuredPath = join(dir, "measured.json");

if (!existsSync(measuredPath)) throw new Error("Run evals/design/measure.py on this case first.");

const measured = new Map(
  Object.entries(Schema.decodeUnknownSync(Measured)(readJson(measuredPath)).checks).map(([k, v]) => [
    k,
    v.pass,
  ]),
);

const measuredPass = (id: string) => measured.get(id) === true;

const scorerChecks: Checks = {
  textContrastAA: measuredPass(policy.measuredToScorerChecks.textContrastAA),
  nonTextContrast3: measuredPass(policy.measuredToScorerChecks.nonTextContrast3),
  targetSize24px: measuredPass(policy.measuredToScorerChecks.targetSize24px),
  spacingOnScale: measuredPass(policy.measuredToScorerChecks.spacingOnScale),
  matchesDesignSystem: policy.measuredToScorerChecks.matchesDesignSystem.every(measuredPass),
  noHorizontalOverflow: measuredPass(policy.measuredToScorerChecks.noHorizontalOverflow),
};

// Re-encoding the same capture gives Clef slightly different bytes; averaging over encodings removes that noise.
const variant = (name: string, quality: number | null) => {
  if (quality === null) return name;

  const target = join("v3", "replicates", `q${quality}`, `${name.replaceAll("/", "__")}.jpg`);

  if (!existsSync(join(dir, target))) {
    mkdirSync(join(dir, "v3", "replicates", `q${quality}`), { recursive: true });

    const run = Bun.spawnSync([
      "sips",
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(quality),
      join(dir, name),
      "--out",
      join(dir, target),
    ]);

    if (run.exitCode !== 0) throw new Error(`sips failed for ${name}`);
  }

  return target;
};

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

const captureFor = (quality: number | null): Capture => {
  const img = (name: string) => image(variant(name, quality));

  return {
    context: { ...context, image_legend: [...context.image_legend] },
    images: file.images.map(img),
    interactions: file.interactions?.map((i) => ({
      action: i.action,
      before: img(i.before),
      after: img(i.after),
    })),
    related: file.related && {
      images: file.related.images.map(img),
      image_legend: [...file.related.image_legend],
      page_text: file.related.page_text,
    },
    known,
    checks: scorerChecks,
  };
};

const judged = findJudgmentWords({ ...context, image_legend: [...context.image_legend] });

if (judged.length) throw new Error(`context.json contains judgment words: ${judged.join(", ")}`);

const everyQuestion = new Map<string, Question>(
  Object.entries({ ...spec.screen, ...spec.visual, ...spec.slop }),
);

const notScored = new Set([...policy.notSent.coverage, ...policy.notSent.replacedByMeasured]);

const allQuestions = new Map(
  [...everyQuestion].filter(([id]) => !notScored.has(id) && !id.startsWith("applies_")),
);

const interactionQuestions = new Map<string, Question>(Object.entries(spec.interaction));

const areaQuestions = (a: AreaId) => policy.areas[a].questions.filter((q) => allQuestions.has(q));

const assigned = AREAS.flatMap(areaQuestions);

const unassigned = [...allQuestions.keys()].filter((q) => !assigned.includes(q));

if (unassigned.length || new Set(assigned).size !== assigned.length) {
  throw new Error(`Area map must cover each scored question once: ${unassigned.join(", ")}`);
}

const pick = (ids: string[], from: Map<string, Question>) =>
  Object.fromEntries(ids.flatMap((id) => (from.has(id) ? [[id, from.get(id)]] : [])));

const keyboard = (action: string) => action.startsWith(policy.keyboardActions.prefix);

const qualities = policy.denoise.jpegQualities.slice(0, policy.denoise.replicates);

interface Job {
  name: string;
  body: object & { questions: Record<string, Question | undefined> };
}

const jobsFor = (capture: Capture): Job[] => {
  const requests = buildRequests(capture);

  return [
    ...AREAS.map((a) => ({
      name: a,
      body: { ...requests.screen, questions: pick(areaQuestions(a), allQuestions) },
    })),
    {
      name: "coverage",
      body: { ...requests.screen, questions: pick(policy.notSent.coverage, everyQuestion) },
    },
    ...requests.interactions.map((body, i) => ({
      name: `interaction-${i + 1}`,
      body: keyboard(file.interactions?.[i]?.action ?? "")
        ? { ...body, questions: pick(policy.keyboardActions.questions, interactionQuestions) }
        : body,
    })),
    ...(requests.consistency ? [{ name: "consistency", body: requests.consistency }] : []),
  ];
};

async function send(body: Job["body"]) {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;

  if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  return { status: res.status, text: await res.text() };
}

const parseAnswers = (text: string) => {
  try {
    return copyAnswers(Schema.decodeUnknownSync(ClefResponse)(JSON.parse(text)).result.answers);
  } catch {
    return null;
  }
};

async function ask(path: string, body: Job["body"]): Promise<AnswerSet | null> {
  if (reuse && existsSync(path))
    return copyAnswers(Schema.decodeUnknownSync(SavedAnswers)(readJson(path)).response.result.answers);

  const statuses: number[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await Bun.sleep(5000);

    // A dropped connection counts as a failed attempt, like an error status.
    const { status, text } = await send(body).catch((error: Error) => ({ status: 0, text: error.message }));

    statuses.push(status);

    const answers = status === 200 ? parseAnswers(text) : null;

    if (answers) {
      const saved = {
        status,
        attemptStatuses: statuses,
        timestamp: new Date().toISOString(),
        response: JSON.parse(text),
      };

      writeFileSync(path, JSON.stringify(saved, null, 2));

      return answers;
    }

    if (attempt === 1) {
      writeFileSync(
        path.replace(".answers.json", ".error.json"),
        JSON.stringify({ attemptStatuses: statuses, response: text }, null, 2),
      );
      console.error(`${basename(path)}: failed after retry (${statuses.join(", ")})`);
    }
  }

  return null;
}

const replicates = await Promise.all(
  qualities.map(async (quality, r) => {
    const capture = captureFor(quality);

    const results = await Promise.all(
      jobsFor(capture).map(
        async (j) => [j.name, await ask(join(out, `${j.name}.r${r}.answers.json`), j.body)] as const,
      ),
    );

    return { capture, got: new Map<string, AnswerSet | null>(results) };
  }),
);

const failed = replicates.flatMap((rep, r) =>
  [...rep.got].flatMap(([name, a]) => (a ? [] : [`${name} (replicate ${r})`])),
);

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

const averageProbabilities = (list: (Record<string, number> | undefined)[]) => {
  const present = list.flatMap((p) => (p ? [p] : []));

  if (present.length === 0) return undefined;

  const keys = [...new Set(present.flatMap((p) => Object.keys(p)))];

  return Object.fromEntries(keys.map((k) => [k, mean(present.map((p) => p[k] ?? 0))]));
};

const average = (answers: Answer[]): Answer | undefined => {
  const [first] = answers;

  if (!first) return undefined;

  const noul = answers.flatMap((a) => (a.type === "noul" ? [a.noul] : []));

  if (first.type === "noul") return { type: "noul", noul: mean(noul) };

  const confidence = mean(answers.flatMap((a) => (a.type === "noul" ? [] : [a.confidence ?? 1])));

  const probabilities = averageProbabilities(
    answers.map((a) => (a.type === "noul" ? undefined : a.probabilities)),
  );

  if (first.type === "score") {
    return {
      type: "score",
      score: mean(answers.flatMap((a) => (a.type === "score" ? [a.score] : []))),
      confidence,
      probabilities,
    };
  }

  const votes = answers.flatMap((a) => (a.type === "choice" ? [a.choice] : []));

  const ranked = probabilities
    ? Object.entries(probabilities).sort((a, b) => b[1] - a[1])
    : [...new Set(votes)]
        .map((c) => [c, votes.filter((v) => v === c).length] as const)
        .sort((a, b) => b[1] - a[1]);

  return { type: "choice", choice: ranked[0]?.[0] ?? first.choice, confidence, probabilities };
};

const merged = new Map<string, AnswerSet>();

for (const name of replicates[0]?.got.keys() ?? []) {
  const sets = replicates.flatMap((rep) => {
    const set = rep.got.get(name);

    return set ? [set] : [];
  });

  const ids = [...new Set(sets.flatMap((s) => Object.keys(s)))];

  merged.set(
    name,
    Object.fromEntries(
      ids.flatMap((id) => {
        const avg = average(sets.flatMap((s) => (s[id] ? [s[id]] : [])));

        return avg ? [[id, avg]] : [];
      }),
    ),
  );
}

const answersFrom = (
  got: Map<string, AnswerSet | null | undefined>,
  ids: string[],
  withUsability: boolean,
): Answers => {
  const answers: Answers = { screen: {}, visual: {}, slop: {}, interactions: [] };

  for (const area of AREAS) {
    for (const [id, a] of Object.entries(got.get(area) ?? {})) {
      if (!ids.includes(id)) continue;

      const set = id in spec.screen ? "screen" : id in spec.visual ? "visual" : "slop";

      answers[set][id] = a;
    }
  }

  if (!withUsability) return answers;

  answers.interactions = [...got].flatMap(([name, set]) =>
    name.startsWith("interaction-") && set ? [set] : [],
  );
  answers.consistency = got.get("consistency") ?? undefined;

  return answers;
};

const baseCapture = replicates[0]?.capture ?? captureFor(null);

const result = scoreDesign(baseCapture, answersFrom(merged, assigned, true));

const perReplicate = replicates.map((rep) => scoreDesign(rep.capture, answersFrom(rep.got, assigned, true)));

const sd = (xs: number[]) => {
  const m = mean(xs);

  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

const dims = [...new Set(perReplicate.flatMap((r) => Object.keys(r.dimensions)))];

const dimensionOf = (r: Result, d: string) => new Map(Object.entries(r.dimensions)).get(d);

const noise = {
  replicates: qualities.length,
  score: { mean: mean(perReplicate.map((r) => r.score)), sd: sd(perReplicate.map((r) => r.score)) },
  dimensions: Object.fromEntries(
    dims.map((d) => {
      const values = perReplicate.flatMap((r) => {
        const v = dimensionOf(r, d);

        return v === undefined ? [] : [v];
      });

      return [d, { mean: mean(values), sd: sd(values), values }];
    }),
  ),
};

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

  const choices =
    id === "feedback_focus_visible" ? FOCUS_CHOICES : new Map(Object.entries(ruleOf(id)?.choices ?? {}));

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

const usabilitySets = [...merged].flatMap(([name, set]) =>
  name.startsWith("interaction-") || name === "consistency" ? [[name, set] as const] : [],
);

const areaReports = new Map(
  AREAS.map((area) => {
    const def = policy.areas[area];

    const usability = area === "usability";

    const clef = scoreDesign(baseCapture, answersFrom(merged, areaQuestions(area), usability));

    const floor = answerFloor([[area, merged.get(area)], ...(usability ? usabilitySets : [])]);

    const checks = Object.fromEntries(def.measured.map((m) => [m, measured.get(m) ?? null]));

    const measuredFails = def.measured.flatMap((m) =>
      measured.get(m) === true ? [] : [`measured ${m}: ${measured.get(m) === false ? "fail" : "missing"}`],
    );

    const clefMajors = [
      ...clef.blockers,
      ...clef.weakDimensions.map((d) => `dimension ${d} below ${THRESHOLDS.dimensionFloor}`),
      ...floor.low.flatMap((l) =>
        l.uncertain ? [] : [`${l.question} = ${l.value} (below ${policy.screenPass.minAnswer.toFixed(2)})`],
      ),
    ];

    const gatedByClef = def.gate !== "measured";

    const majors = [...measuredFails, ...(gatedByClef ? clefMajors : [])];

    const missing = usability && !(file.interactions?.length ?? 0) ? ["no interaction captures"] : [];

    const reviewItems = gatedByClef ? floor.uncertain : [];

    const status =
      majors.length || (gatedByClef && clef.score < policy.screenPass.minScore)
        ? "fail"
        : missing.length || reviewItems.length
          ? "review"
          : "pass";

    const report = {
      status,
      gate: def.gate,
      measured: checks,
      clefScore: clef.score,
      clefCounts: gatedByClef,
      dimensions: clef.dimensions,
      majors,
      informational: gatedByClef ? [] : clefMajors,
      lowAnswers: floor.low,
      uncertain: floor.uncertain,
      missingEvidence: missing,
      issues: clef.issues,
      fixes: clef.fixes,
    };

    return [area, report] as const;
  }),
);

const screenFloor = answerFloor([
  ...AREAS.flatMap((a) => (policy.areas[a].gate === "measured" ? [] : [[a, merged.get(a)] as const])),
  ...usabilitySets,
]);

const statusOf = (a: AreaId) => areaReports.get(a)?.status ?? "fail";

const reasons = [
  ...(result.score < policy.screenPass.minScore
    ? [`score ${result.score} < ${policy.screenPass.minScore}`]
    : []),
  ...result.blockers.map((b) => `blocker: ${b}`),
  ...result.weakDimensions.map((d) => `weak dimension: ${d}`),
  ...(result.verdict === "review" ? ["verdict is review"] : []),
  ...screenFloor.low.flatMap((l) =>
    l.uncertain ? [] : [`answer below ${policy.screenPass.minAnswer.toFixed(2)}: ${l.question} = ${l.value}`],
  ),
  ...AREAS.flatMap((a) => (statusOf(a) === "pass" ? [] : [`area ${a}: ${statusOf(a)}`])),
  ...failed.map((n) => `request failed: ${n}`),
];

const coverage = merged.get("coverage") ?? {};

const valueText = (a: Answer) => {
  if (a.type === "noul") return Math.round(a.noul * 100) / 100;

  return a.type === "choice" ? a.choice : Math.round(a.score * 100) / 100;
};

const acceptance = {
  policy: policy.version,
  rubric: policy.rubric,
  pass: reasons.length === 0,
  reasons,
  lowAnswers: screenFloor.low,
  coverage: Object.fromEntries(Object.entries(coverage).map(([id, a]) => [id, valueText(a)])),
};

writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));

writeFileSync(join(out, "areas.json"), JSON.stringify(Object.fromEntries(areaReports), null, 2));

writeFileSync(join(out, "acceptance.json"), JSON.stringify(acceptance, null, 2));

writeFileSync(join(out, "noise.json"), JSON.stringify(noise, null, 2));

writeFileSync(join(out, "merged.answers.json"), JSON.stringify(Object.fromEntries(merged), null, 2));

writeFileSync(join(out, "images.json"), JSON.stringify(Object.fromEntries(imageMeta), null, 2));

const summary = Object.fromEntries(AREAS.map((a) => [a, statusOf(a)]));

console.log(
  JSON.stringify({
    case: out,
    score: result.score,
    scoreSd: Math.round(noise.score.sd * 1000) / 1000,
    verdict: result.verdict,
    pass: acceptance.pass,
    areas: summary,
    failed,
  }),
);
