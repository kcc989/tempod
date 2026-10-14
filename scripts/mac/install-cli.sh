#!/usr/bin/env bash
set -euo pipefail

helper_path="${1:-/Applications/Tempo.app/Contents/MacOS/tempo}"
bin_dir="${2:-$HOME/.local/bin}"
if [[ ! -x "$helper_path" ]]; then
  echo 'The bundled tempo command is missing. Build or install Tempo for Mac first.' >&2
  exit 1
fi
helper_path="$(cd "$(dirname "$helper_path")" && pwd)/$(basename "$helper_path")"
mkdir -p "$bin_dir"
if [[ -e "$bin_dir/tempo" || -L "$bin_dir/tempo" ]]; then
  if [[ -L "$bin_dir/tempo" && "$(readlink "$bin_dir/tempo")" == "$helper_path" ]]; then
    echo "tempo is already installed in $bin_dir"
    exit 0
  fi
  echo "A tempo command already exists in $bin_dir. Choose another directory." >&2
  exit 1
fi
ln -s "$helper_path" "$bin_dir/tempo"
echo "Installed $bin_dir/tempo. Add $bin_dir to PATH, then run: tempo terminal <workspace>"
