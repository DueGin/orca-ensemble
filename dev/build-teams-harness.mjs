// Builds dev/teams-harness.html: the panel's Teams tab against a fake worker (see dev/teams-harness.tsx).
// Run `node build.mjs` first, then `node dev/build-teams-harness.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
await build({ entryPoints: [`${here}teams-harness.tsx`], outfile: `${here}teams.js`, bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning" });
const css = readFileSync(`${here}../dist/panel.html`, "utf8").match(/<style>([\s\S]*?)<\/style>/)[1];
writeFileSync(`${here}teams-harness.html`, `<!doctype html>\n<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="teams.js"></script></body></html>\n`);
console.log("harness ready: dev/teams-harness.html");
