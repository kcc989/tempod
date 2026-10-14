import { Schema } from "effect";

/** Shell files (01, Shell and dotfiles). Paths are relative to /home/tempo. */

export const DOTFILES_LIMITS = {
  filesMax: 20,
  pathMax: 200,
  fileMaxBytes: 64 * 1024,
  totalMaxBytes: 256 * 1024,
} as const;

/** Agent state, Tempo state and credentials stay out of reach. */
export const DOTFILES_RESERVED = [
  ".tempod",
  ".claude",
  ".codex",
  ".pi",
  ".local/share/opencode",
  ".ssh",
  "attachments",
];

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._+-]+$/;

export const isDotfilePath = (path: string): boolean => {
  const segments = path.split("/");

  return (
    path.length > 0 &&
    path.length <= DOTFILES_LIMITS.pathMax &&
    segments.every((s) => SEGMENT.test(s)) &&
    !DOTFILES_RESERVED.some((r) => path === r || path.startsWith(`${r}/`))
  );
};

export const DotfilePath = Schema.String.check(Schema.makeFilter((p: string) => isDotfilePath(p)));

export const Dotfile = Schema.Struct({ path: DotfilePath, content: Schema.String });

export type Dotfile = typeof Dotfile.Type;

export const DotfileList = Schema.Array(Dotfile).check(Schema.isMaxLength(DOTFILES_LIMITS.filesMax));

export const DotfilesState = Schema.Struct({
  files: DotfileList,
  /** The image defaults, for Reset. */
  defaults: DotfileList,
  /** False until the first save; `files` then equals `defaults`. */
  saved: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.Number),
});

export type DotfilesState = typeof DotfilesState.Type;

/** Baked into the image as /home/tempo/.zshrc; `container/check-versions.ts` keeps them equal. */
export const DEFAULT_ZSHRC = `export ZSH=/opt/oh-my-zsh
export ZSH_CUSTOM="$HOME/.oh-my-zsh-custom"
ZSH_THEME="robbyrussell"
plugins=(git)
DISABLE_AUTO_UPDATE=true
source "$ZSH/oh-my-zsh.sh"
`;

/** Baked into the image as /home/tempo/.tmux.conf. */
export const DEFAULT_TMUX_CONF = `set -g default-shell /bin/zsh
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:RGB"
set -g status off
set -g escape-time 10
set -g history-limit 10000
`;

export const DEFAULT_DOTFILES: ReadonlyArray<Dotfile> = [
  { path: ".zshrc", content: DEFAULT_ZSHRC },
  { path: ".tmux.conf", content: DEFAULT_TMUX_CONF },
];

const utf8 = new TextEncoder();

/** Size and duplicate checks the schema cannot express. Returns the first problem, or null. */
export const dotfilesProblem = (files: ReadonlyArray<Dotfile>): string | null => {
  const seen = new Set<string>();
  let total = 0;

  for (const f of files) {
    if (seen.has(f.path)) return `${f.path} is listed twice.`;

    if ([...seen].some((p) => f.path.startsWith(`${p}/`) || p.startsWith(`${f.path}/`)))
      return `${f.path} conflicts with another path.`;

    seen.add(f.path);
    const bytes = utf8.encode(f.content).length;

    if (bytes > DOTFILES_LIMITS.fileMaxBytes) return `${f.path} is larger than 64 KB.`;
    total += bytes;
  }

  return total > DOTFILES_LIMITS.totalMaxBytes ? "Shell files are larger than 256 KB in total." : null;
};
