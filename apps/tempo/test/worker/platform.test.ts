import { describe } from "vitest";

// Sequential forge, Artifacts, credential, preview, browser and agent cases share one test file, so
// they pay the per-file workerd startup once (docs/CI.md). Each module loads inside its own describe,
// so its hooks stay scoped to it.
describe("forge", async () => {
  await import("./forge.cases.ts");
});

describe("credential-hub", async () => {
  await import("./credential-hub.cases.ts");
});

describe("browser", async () => {
  await import("./browser.cases.ts");
});

describe("preview", async () => {
  await import("./preview.cases.ts");
});

describe("regressions", async () => {
  await import("./regressions.cases.ts");
});

describe("agent-proposals", async () => {
  await import("./agent-proposals.cases.ts");
});

describe("agent-library", async () => {
  await import("./agent-library.cases.ts");
});

describe("decisions", async () => {
  await import("./decisions.cases.ts");
});

describe("conversations", async () => {
  await import("./conversations.cases.ts");
});

describe("model-catalog", async () => {
  await import("./model-catalog.cases.ts");
});
