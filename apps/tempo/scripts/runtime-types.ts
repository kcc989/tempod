// Writes worker-runtime.d.ts from `cf workers types`: the runtime types only. Env is in src/env.ts.
import { readFileSync, writeFileSync } from "node:fs";

const generated = readFileSync(".cloudflare/types/index.d.ts", "utf8");

const start = generated.indexOf("// Runtime types generated");

if (start < 0) throw new Error("cf workers types wrote no runtime types");

writeFileSync("worker-runtime.d.ts", `/* eslint-disable */\n${generated.slice(start)}`);
