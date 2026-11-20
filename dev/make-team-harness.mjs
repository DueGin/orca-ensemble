// Writes dev/team-harness.html: the team editor frame with every stylesheet inlined (as build.mjs does), a fake
// `window.orca` (dev/fake-team-orca.js), and the built build/frames/team-editor.js. Run after `node build.mjs`.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".css") && path !== join(root, "src/ui/styles.css")) files.push(path);
  }
};
walk(join(root, "src/ui"));
const css = [join(root, "src/ui/styles.css"), ...files].map((file) => readFileSync(file, "utf8")).join("\n");
writeFileSync(
  join(root, "dev/team-harness.html"),
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>Team (harness)</title><style>${css}</style>\n<script src="fake-team-orca.js"></script></head><body><div id="root"></div><script src="../build/frames/team-editor.js"></script></body></html>\n`,
);
console.log("wrote dev/team-harness.html");
