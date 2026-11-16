// Builds the static harnesses for the run views (no Orca needed): dev/fixtures.js from real and played-through runs,
// dev/run-harness.html (the run report as Orca would load it) and dev/sidebar-harness.html (RunOverview and
// ComponentDetail at sidebar width). Run `node build.mjs` first, then `node dev/build-harness.mjs`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
await build({ entryPoints: [`${here}make-fixtures.ts`], outfile: `${here}.make-fixtures.mjs`, bundle: true, platform: "node", format: "esm", logLevel: "warning" });
execFileSync(process.execPath, [`${here}.make-fixtures.mjs`], { stdio: "inherit" });
await build({ entryPoints: [`${here}sidebar-harness.tsx`], outfile: `${here}sidebar.js`, bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning" });

const report = readFileSync(`${here}../dist/run-report.html`, "utf8");
const host = '<script src="fixtures.js"></script><script src="fake-orca.js"></script>';
writeFileSync(`${here}run-harness.html`, report.replace("<head>", `<head>${host}`));
const css = report.match(/<style>([\s\S]*?)<\/style>/)[1];
writeFileSync(`${here}sidebar-harness.html`, `<!doctype html>\n<html><head><meta charset="utf-8">${host}<style>${css}</style></head><body><div id="root"></div><script src="sidebar.js"></script></body></html>\n`);
console.log("harness ready: dev/run-harness.html, dev/sidebar-harness.html");
