import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readManifest = async path => JSON.parse(await readFile(path, "utf8"));
const root = await readManifest("package.json");
const client = await readManifest("apps/client/package.json");
const sdk = await readManifest("packages/sdk/package.json");

assert.equal(client.version, root.version, "client and repository release versions must match");
assert.equal(root.private, true, "the monorepo root must remain private");
assert.equal(client.private, true, "the client workspace is released as an archive, not published to npm");
assert.equal(sdk.private, true, "the internal SDK must not be published to npm");

process.stdout.write(`Version policy: client ${client.version}; internal SDK ${sdk.version} (private)\n`);
