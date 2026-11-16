import type { PromptLanguage } from "./modes";
import * as en from "./prompt";
import * as zh from "./prompt-zh";

export type Prompts = typeof en;
const SETS: Record<PromptLanguage, Prompts> = { en, zh };

/** The prompt set of a language; English when unset. */
export function promptsFor(language: PromptLanguage | null | undefined): Prompts {
  return SETS[language ?? "en"];
}
