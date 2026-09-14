#!/bin/sh

set -eu
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

platform=${1:-}
output_dir=${2:-dist-release}
case "$platform" in darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;; *) printf 'usage: %s <platform> [output-dir]\n' "$0" >&2; exit 2 ;; esac

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) detected=darwin-arm64 ;;
  Darwin-x86_64) detected=darwin-x64 ;;
  Linux-x86_64) detected=linux-x64 ;;
  Linux-aarch64|Linux-arm64) detected=linux-arm64 ;;
  *) printf 'unsupported build host\n' >&2; exit 1 ;;
esac
[ "$platform" = "$detected" ] || { printf 'refusing to label %s build as %s\n' "$detected" "$platform" >&2; exit 1; }

project_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/pi-student-release.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT HUP INT TERM

cd "$project_dir"
npm ci
npm run build
mkdir -p "$stage/package" "$output_dir"
cp -R dist docs integrations scripts/start-dev.mjs package.json package-lock.json README.md "$stage/package/"
mkdir -p "$stage/package/supabase"
cp supabase/config.toml "$stage/package/supabase/"
cp -R supabase/migrations supabase/tests "$stage/package/supabase/"
cd "$stage/package"
npm ci --omit=dev --ignore-scripts
cd "$project_dir"
tar -czf "$output_dir/pi-student-$platform.tar.gz" -C "$stage/package" .
