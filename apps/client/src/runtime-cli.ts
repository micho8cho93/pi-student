#!/usr/bin/env node

// npm's bin mapping cannot inject the internal `runtime` subcommand. Keep a
// tiny executable shim so pi-student-runtime has the same behavior as the
// launcher written by the curl installer.
process.argv.splice(2, 0, "runtime");
await import("./cli.js");
