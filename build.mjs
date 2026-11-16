// Bundles the worker, the agents' command, and the panel and editor frames into dist/.
import { build, context } from "esbuild";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Every stylesheet under src/ui, base first. */
function allCss() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".css") && path !== "src/ui/styles.css") files.push(path);
    }
  };
  walk("src/ui");
  return ["src/ui/styles.css", ...files].map((file) => readFileSync(file, "utf8")).join("\n");
}

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

const common = { bundle: true, logLevel: "info", sourcemap: false, legalComments: "none" };
const targets = [
  { ...common, entryPoints: ["src/worker/main.ts"], outfile: "dist/worker.mjs", platform: "node", format: "esm", target: "node20", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } },
  { ...common, entryPoints: ["src/cli/agent-team.ts"], outfile: "dist/agent-team.cjs", platform: "node", format: "cjs", target: "node18" },
];
const frames = [
  { name: "panel", entry: "src/ui/panel.tsx", title: "Agent Team" },
  { name: "team-editor", entry: "src/ui/team-editor.tsx", title: "Team" },
  { name: "run-report", entry: "src/ui/run-report.tsx", title: "Run report" },
];
for (const frame of frames) {
  targets.push({ ...common, entryPoints: [frame.entry], outfile: `dist/${frame.name}.js`, platform: "browser", format: "iife", target: "es2022", jsx: "automatic", minify: !watch, define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' } });
}

/** Each frame as one HTML file with its script inlined, so it also runs in a browser client's sandboxed frame. */
function writeFrames() {
  const css = allCss();
  for (const frame of frames) {
    const js = readFileSync(`dist/${frame.name}.js`, "utf8").replace(/<\/script/gi, "<\\/script");
    writeFileSync(`dist/${frame.name}.html`, `<!doctype html>\n<html><head><meta charset="utf-8"><title>${frame.title}</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>\n`);
  }
}

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context({ ...options, plugins: [{ name: "frames", setup(b) { b.onEnd(() => { try { writeFrames(); } catch {} }); } }] })));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(targets.map((options) => build(options)));
  writeFrames();
}
