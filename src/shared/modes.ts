// Collaboration modes. A team fixes one in advance or sets "auto", which lets the lead pick one per request (and then
// keeps it for the whole session). Each mode is a pattern from the multi-agent catalogue (MA-xx).

/** The modes a collaboration run can use. */
export const COLLAB_MODES = ["team", "delegation"] as const;
export type CollabMode = (typeof COLLAB_MODES)[number];

/** What a team or a session can be set to: one mode, "auto" to pick one, or "none" for no collaboration. */
export const TEAM_MODES = ["auto", ...COLLAB_MODES, "none"] as const;
export type TeamMode = (typeof TEAM_MODES)[number];

export interface ModeSpec {
  id: CollabMode;
  /** The pattern in the multi-agent catalogue. */
  pattern: string;
  /** The lead agrees a brief with the user before any member sees the request. */
  intake: boolean;
  /** Members read each other's work on a shared board, or only report to the lead. */
  visibility: "shared" | "isolated";
  /** For the lead in auto mode: when this mode fits. */
  fit: string;
  /** When it does not fit. */
  unfit: string;
}

export const MODE_SPECS: Record<CollabMode, ModeSpec> = {
  team: {
    id: "team",
    pattern: "MA-08",
    intake: true,
    visibility: "shared",
    fit: "the parts depend on each other and need to be agreed as one piece (an interface several roles build against, a cross-cutting change, a design several roles review), the requirements are still unclear, or several hypotheses need checking with members correcting each other",
    unfit: "small or clearly separable work, where every member reading every post only costs time",
  },
  delegation: {
    id: "delegation",
    pattern: "MA-04",
    intake: false,
    visibility: "isolated",
    fit: "the request splits into parts with clear owners that can be done without talking to each other (independent features, research per area, read-only exploration)",
    unfit: "parts that must agree on shared details while they are built, or many parts writing the same files",
  },
};

/** The mode a session runs in: the mode auto settled on (locked), else the session's override, else the team's mode. */
export function effectiveMode(teamMode: TeamMode, override: TeamMode | null | undefined, locked?: CollabMode | null): TeamMode {
  return locked ?? override ?? teamMode;
}

/** Whether a run in `mode` may start when the session is set to `effective`; "none" starts no run. */
export function allowsMode(effective: TeamMode, mode: CollabMode): boolean {
  return effective === "auto" || effective === mode;
}

export function isCollabMode(value: unknown): value is CollabMode {
  return typeof value === "string" && (COLLAB_MODES as readonly string[]).includes(value);
}

export function isTeamMode(value: unknown): value is TeamMode {
  return typeof value === "string" && (TEAM_MODES as readonly string[]).includes(value);
}

/** The command agents run; the plugin puts it on their PATH. */
export const TEAM_BIN = "agent-team";

/** Lead commands, as agents type them. */
export const LEAD_TOOLS = {
  status: `${TEAM_BIN} status`,
  role: `${TEAM_BIN} role`,
  delegate: `${TEAM_BIN} delegate`,
  brief: `${TEAM_BIN} brief`,
  kickoff: `${TEAM_BIN} kickoff`,
  tasks: `${TEAM_BIN} tasks`,
  broadcast: `${TEAM_BIN} broadcast`,
  send: `${TEAM_BIN} send`,
  wait: `${TEAM_BIN} wait`,
  board: `${TEAM_BIN} board`,
  close: `${TEAM_BIN} close`,
} as const;

/** Member commands, as agents type them. */
export const MEMBER_TOOLS = {
  read: `${TEAM_BIN} read`,
  post: `${TEAM_BIN} post`,
  claim: `${TEAM_BIN} claim`,
  task: `${TEAM_BIN} task`,
  report: `${TEAM_BIN} report`,
} as const;

/** Prefix of every message the plugin types into an agent, so they can be told from the user's own. */
export const PLUGIN_MESSAGE_PREFIX = "[agent-team]";

/** Languages the plugin writes agent instructions in; the agents reply in it too. */
export const PROMPT_LANGUAGES = ["zh", "en"] as const;
export type PromptLanguage = (typeof PROMPT_LANGUAGES)[number];

/** The prompt language for an app locale such as `zh-CN`: Chinese for Chinese, else English. */
export function languageFromLocale(locale: string | null | undefined): PromptLanguage {
  return (locale ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function isPromptLanguage(value: unknown): value is PromptLanguage {
  return typeof value === "string" && (PROMPT_LANGUAGES as readonly string[]).includes(value);
}
