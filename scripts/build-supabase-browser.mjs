import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = process.argv[2];
if (!output) throw new Error("Pass the workspace-relative browser bundle output path.");

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: ["@supabase/supabase-js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  legalComments: "none",
  outfile: resolve(process.cwd(), output),
});
