import os from "node:os";
import path from "node:path";

export interface InstallationPaths {
	root: string;
	app: string;
	bin: string;
	runtime: string;
	paseo: string;
	paseoHome: string;
	paseoConfig: string;
	paseoExecutable: string;
	images: string;
	cache: string;
	logs: string;
	config: string;
	runtimeMetadata: string;
	launcher: string;
	runtimeLauncher: string;
}

export function getInstallationPaths(env: NodeJS.ProcessEnv = process.env): InstallationPaths {
	const root = path.resolve(env.PI_STUDENT_HOME?.trim() || path.join(os.homedir(), ".pi-student"));
	const config = path.join(root, "config");
	const bin = path.join(root, "bin");
	const paseo = path.join(root, "runtime", "paseo");
	const paseoHome = path.join(root, "paseo");
	return {
		root,
		app: path.join(root, "app"),
		bin,
		runtime: path.join(root, "runtime"),
		paseo,
		paseoHome,
		paseoConfig: path.join(paseoHome, "config.json"),
		paseoExecutable: path.join(paseo, "node_modules", ".bin", "paseo"),
		images: path.join(root, "images"),
		cache: path.join(root, "cache"),
		logs: path.join(root, "logs"),
		config,
		runtimeMetadata: path.join(config, "runtime.json"),
		launcher: path.join(bin, "pi-student"),
		runtimeLauncher: path.join(bin, "pi-student-runtime"),
	};
}
