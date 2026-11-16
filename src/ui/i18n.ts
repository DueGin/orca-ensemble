// `t("flow.title")`, `t("session.round", { round: 1, rounds: 2 })`; Chinese when Orca runs in Chinese.
import { isZh } from "./orca";
import { STRINGS } from "./strings";

type Tree = typeof STRINGS.en;
type Paths<T, P extends string = ""> = { [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`> }[keyof T & string];
/** A key such as "flow.event.post"; plural keys are named without their _one/_other suffix. */
export type Key = Paths<Tree> | (Paths<Tree> extends infer K ? (K extends `${infer B}_one` | `${infer B}_other` ? B : never) : never);

function lookup(tree: unknown, path: string): string | undefined {
  let node = tree as Record<string, unknown> | undefined;
  for (const part of path.split(".")) node = node && typeof node === "object" ? (node[part] as Record<string, unknown>) : undefined;
  return typeof node === "string" ? node : undefined;
}

export function t(key: Key | string, vars: Record<string, string | number> = {}): string {
  const tree = isZh() ? STRINGS.zh : STRINGS.en;
  const count = typeof vars.count === "number" ? vars.count : null;
  const raw = (count !== null ? lookup(tree, `${key}_${count === 1 ? "one" : "other"}`) : undefined) ?? lookup(tree, key) ?? lookup(STRINGS.en, key) ?? key;
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (name in vars ? String(vars[name]) : ""));
}
