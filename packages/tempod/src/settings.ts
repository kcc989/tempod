import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SettingsLayer, SettingsReadResult } from "@tempo/protocol";
import { resolveSettings, SETTINGS_PATHS, type SettingsFiles } from "@tempo/settings";

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export const readSettingsFiles = (workspace: string): SettingsFiles => ({
  tempoToml: readOrNull(join(workspace, SETTINGS_PATHS.tempoToml)),
  conductorToml: readOrNull(join(workspace, SETTINGS_PATHS.conductorToml)),
  conductorJson: readOrNull(join(workspace, SETTINGS_PATHS.conductorJson)),
});

export const SETTINGS_FILE_PATHS: ReadonlyArray<string> = Object.values(SETTINGS_PATHS);

const fingerprint = (files: SettingsFiles): string =>
  JSON.stringify([files.tempoToml ?? null, files.conductorToml ?? null, files.conductorJson ?? null]);

/** Last settings overrides and file contents, so the watcher can re-read settings when a file changes. */
export class SettingsState {
  private overrides: SettingsLayer;
  private lastFingerprint: string | null = null;
  private known: boolean;

  /** `saved` are the overrides of the last settings.read, kept in tempod.db across restarts. */
  constructor(
    private readonly workspace: string,
    saved: SettingsLayer | null,
    private readonly persist: (overrides: SettingsLayer) => void = () => {},
  ) {
    this.overrides = saved ?? {};
    this.known = saved !== null;
  }

  read(overrides: SettingsLayer): SettingsReadResult {
    this.overrides = overrides;
    this.known = true;
    this.persist(overrides);
    const files = readSettingsFiles(this.workspace);
    this.lastFingerprint = fingerprint(files);
    return resolveSettings(overrides, files);
  }

  /** Re-resolves with the last overrides when any of the three files changed since the last read. */
  reReadIfChanged(): SettingsReadResult | null {
    const files = readSettingsFiles(this.workspace);
    const fp = fingerprint(files);
    if (fp === this.lastFingerprint) return null;
    this.lastFingerprint = fp;
    // Without a settings.read the UI overrides are unknown, and settings without them would be wrong.
    if (!this.known) return null;
    return resolveSettings(this.overrides, files);
  }

  /** Records the current files as seen without emitting. */
  prime(): void {
    if (this.lastFingerprint === null) this.lastFingerprint = fingerprint(readSettingsFiles(this.workspace));
  }
}
