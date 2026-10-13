import { resolveSettings } from "../../src/index.ts";
import { expect, it } from "vitest";

it("ignores obsolete wiring fields in a released settings file while preserving its agent settings", () => {
  const result = resolveSettings({}, {
    tempoYaml: "roles:\n  enabled: false\n  max_runs_per_change: 2\nagent:\n  default: codex\n",
  });

  expect(result.effective.agent.default).toBe("codex");
  expect(result.errors).toEqual([]);
  expect(result.warnings).toContain('.tempo/settings.yaml: unknown key "roles" was ignored');
  expect(Object.keys(result.effective)).not.toContain("roles");
});
