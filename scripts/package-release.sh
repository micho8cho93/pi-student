#!/bin/sh

set -eu
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

detect_platform() {
	case "$(uname -s)-$(uname -m)" in
		Darwin-arm64) printf '%s\n' darwin-arm64 ;;
		Darwin-x86_64) printf '%s\n' darwin-x64 ;;
		Linux-x86_64) printf '%s\n' linux-x64 ;;
		Linux-aarch64|Linux-arm64) printf '%s\n' linux-arm64 ;;
		*) printf 'unsupported build host\n' >&2; exit 1 ;;
	esac
}

platform=${1:-$(detect_platform)}
output_dir=${2:-apps/client/artifacts}
case "$platform" in darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;; *) printf 'usage: %s [platform] [output-dir]\n' "$0" >&2; exit 2 ;; esac

detected=$(detect_platform)
[ "$platform" = "$detected" ] || { printf 'refusing to label %s build as %s\n' "$detected" "$platform" >&2; exit 1; }

project_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
case "$output_dir" in /*) ;; *) output_dir="$project_dir/$output_dir" ;; esac
stage=$(mktemp -d "${TMPDIR:-/tmp}/pi-student-client-release.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT HUP INT TERM

cd "$project_dir"
npm ci
npm run build:client
# Compatibility only: the local teacher command remains bundled, but it is not
# a dependency of @pi-student/client and has its own build/package boundary.
npm run build:teacher
npm run check:versions

mkdir -p "$stage/package/docs" "$output_dir"
cp package.json package-lock.json README.md "$stage/package/"
cp docs/architecture.md docs/github-publishing.md docs/learn-mode.md docs/organization-readiness.md docs/sdk.md docs/teacher-integration.md "$stage/package/docs/"
cp -R docs/adr "$stage/package/docs/"

for workspace in \
	apps/client \
	apps/teacher-console \
	packages/contracts \
	packages/sdk \
	packages/runtime \
	packages/education \
	packages/policy \
	packages/sandbox \
	packages/sandbox-gondolin \
	packages/classroom \
	packages/supabase-adapter \
	packages/telemetry \
	packages/publishing \
	packages/paseo-adapter \
	packages/shared
do
	mkdir -p "$stage/package/$workspace"
	cp "$workspace/package.json" "$stage/package/$workspace/"
	cp -R "$workspace/dist" "$stage/package/$workspace/"
done
cp -R packages/paseo-adapter/config packages/paseo-adapter/README.md "$stage/package/packages/paseo-adapter/"

cd "$stage/package"
npm ci --omit=dev --ignore-scripts
cd "$project_dir"
artifact="$output_dir/pi-student-$platform.tar.gz"
tar -czf "$artifact" -C "$stage/package" .
node tooling/verify-release-artifact.mjs client "$artifact"
printf 'Client artifact: %s\n' "$artifact"
