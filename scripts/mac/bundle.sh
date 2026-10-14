#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bash scripts/mac/dev.sh --build-only
