#!/bin/sh

set -eu
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

project_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
output_dir=${1:-apps/teacher-console/artifacts}
case "$output_dir" in /*) ;; *) output_dir="$project_dir/$output_dir" ;; esac
stage=$(mktemp -d "${TMPDIR:-/tmp}/pi-student-teacher-release.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT HUP INT TERM

cd "$project_dir"
npm run build:teacher
npm run check:versions
version=$(node -p 'require("./apps/teacher-console/package.json").version')

mkdir -p "$stage/package/docs" "$output_dir"
cp package.json package-lock.json README.md "$stage/package/"
cp docs/architecture.md docs/organization-readiness.md docs/teacher-integration.md "$stage/package/docs/"
cp -R docs/adr "$stage/package/docs/"

for workspace in \
	apps/teacher-console \
	packages/contracts \
	packages/runtime \
	packages/education \
	packages/policy \
	packages/sandbox \
	packages/classroom \
	packages/supabase-adapter \
	packages/telemetry \
	packages/shared
do
	mkdir -p "$stage/package/$workspace"
	cp "$workspace/package.json" "$stage/package/$workspace/"
	cp -R "$workspace/dist" "$stage/package/$workspace/"
done

cd "$stage/package"
npm ci --omit=dev --ignore-scripts
cd "$project_dir"
artifact="$output_dir/pi-student-teacher-console-$version.tar.gz"
tar -czf "$artifact" -C "$stage/package" .
node tooling/verify-release-artifact.mjs teacher "$artifact"
printf 'Teacher console artifact: %s\n' "$artifact"
