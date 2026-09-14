import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstallationPaths, type InstallationPaths } from "./paths.js";

export async function installLauncher(paths: InstallationPaths = getInstallationPaths()): Promise<void> {
	await mkdir(paths.bin, { recursive: true, mode: 0o700 });
	const launcher = `#!/bin/sh
set -eu
INSTALL_ROOT=${shellQuote(paths.root)}
PI_STUDENT_HOME="\${PI_STUDENT_HOME:-\${INSTALL_ROOT}}"
export PI_STUDENT_HOME
export XDG_CACHE_HOME="\${PI_STUDENT_HOME}/cache"
export DESERTANT_HOME="\${PI_STUDENT_HOME}/runtime/voz"
export PATH="\${PI_STUDENT_HOME}/runtime/voz:\${PI_STUDENT_HOME}/runtime/native/bin:\${PI_STUDENT_HOME}/bin:\${PATH}"
NODE="\${PI_STUDENT_HOME}/runtime/node/bin/node"
APP="\${PI_STUDENT_HOME}/app/dist/cli.js"
if [ ! -x "\${NODE}" ] || [ ! -f "\${APP}" ]; then
  printf '%s\n' 'Pi Student installation is incomplete.' >&2
  printf '%s\n' 'Run the installation command again to repair it.' >&2
  exit 1
fi
exec "\${NODE}" "\${APP}" "$@"
`;
	const runtimeLauncher = `#!/bin/sh
set -eu
INSTALL_ROOT=${shellQuote(paths.root)}
PI_STUDENT_HOME="\${PI_STUDENT_HOME:-\${INSTALL_ROOT}}"
export PI_STUDENT_HOME
export XDG_CACHE_HOME="\${PI_STUDENT_HOME}/cache"
export DESERTANT_HOME="\${PI_STUDENT_HOME}/runtime/voz"
export PATH="\${PI_STUDENT_HOME}/runtime/voz:\${PI_STUDENT_HOME}/runtime/native/bin:\${PI_STUDENT_HOME}/bin:\${PATH}"
NODE="\${PI_STUDENT_HOME}/runtime/node/bin/node"
APP="\${PI_STUDENT_HOME}/app/dist/cli.js"
if [ ! -x "\${NODE}" ] || [ ! -f "\${APP}" ]; then
  printf '%s\n' 'Pi Student runtime is incomplete.' >&2
  printf '%s\n' 'Run the Pi Student installation command again to repair it.' >&2
  exit 1
fi
exec "\${NODE}" "\${APP}" runtime "$@"
`;
	await writeFile(paths.launcher, launcher, { mode: 0o755 });
	await chmod(paths.launcher, 0o755);
	await writeFile(paths.runtimeLauncher, runtimeLauncher, { mode: 0o755 });
	await chmod(paths.runtimeLauncher, 0o755);
}

export function shellPathExport(paths: InstallationPaths = getInstallationPaths()): string {
	return `export PATH="${path.join(paths.root, "bin")}:$PATH"`;
}

function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
