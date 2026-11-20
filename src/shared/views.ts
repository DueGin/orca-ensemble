// What the panel, the team editor and the run report get from the worker.
import type { RunEvent } from "./flow";
import type { CollabMode, PromptLanguage, TeamMode } from "./modes";
import type { Preset, Team } from "./team";

export interface RunView {
  id: string;
  mode: CollabMode;
  title: string;
  status: "active" | "closed";
  round: number;
  rounds: number;
  planApproval: boolean;
  language: PromptLanguage;
  createdAt: string;
  updatedAt: string;
  brief: { title: string; goal: string; acceptance: string[] } | null;
  members: { role: string; agentId: string; title: string; state: "working" | "done" | "attention" | "failed"; task: string; retired: boolean; agent: string | null; model: string | null }[];
  tasks: { id: string; title: string; role: string | null; state: "todo" | "doing" | "done" | "dropped"; ownerTitle: string | null; waitingOn: string[]; plan: "pending" | "approved" | "rejected" | null; sentBack: boolean }[];
  posts: { seq: number; round: number; author: string; kind: string; text: string; to: string[]; at: string }[];
  postCount: number;
  claims: { role: string; path: string }[];
  events: RunEvent[];
  batches: { round: number; title: string; packets: number; warnings: number; followUp: boolean; summarized: boolean }[];
}

export interface RunDetail {
  id: string;
  /** The lead's terminal. */
  leadAgentId: string;
  mode: CollabMode;
  title: string;
  reason: string;
  status: "active" | "closed";
  round: number;
  rounds: number;
  planApproval: boolean;
  language: PromptLanguage;
  createdAt: string;
  updatedAt: string;
  brief: { title: string; goal: string; requirements: string[]; acceptance: string[]; constraints: string[]; outOfScope: string[]; userConfirmation: string } | null;
  leadReadSeq: number;
  members: { role: string; agentId: string; title: string; state: "working" | "done" | "attention" | "failed"; task: string; result: string | null; collected: boolean; readSeq: number; inboxSeq: number; retired: boolean; dispatchedAt: string; agent: string | null; model: string | null; live: string | null }[];
  tasks: { id: string; title: string; detail: string; role: string | null; deps: string[]; waitingOn: string[]; files: string[]; state: "todo" | "doing" | "done" | "dropped"; owner: string | null; ownerTitle: string | null; result: string; plan: { text: string; status: "pending" | "approved" | "rejected"; feedback: string; delivered: boolean } | null; feedback: string; createdBy: string; updatedAt: string }[];
  posts: { seq: number; round: number; author: string; agentId: string; kind: string; text: string; to: string[]; files: string[]; at: string }[];
  claims: { role: string; agentId: string; path: string; at: string }[];
  events: RunEvent[];
  batches: { round: number; title: string; reason: string; at: string; taskIds: string[]; warnings: string[]; followUp: boolean; summary: string; summaryAt: string | null }[];
}

export interface PendingBriefView {
  brief: { title: string; goal: string; requirements: string[]; acceptance: string[]; constraints: string[]; outOfScope: string[] };
  roles: string[];
  rounds: number;
  planApproval: boolean;
  tasks: { title: string; detail: string; role: string | null; after: string[]; files: string[] }[];
  at: string;
  confirmed: boolean;
}

/** A lead session as the panel lists it. */
export interface LeadView {
  terminalId: string;
  workspaceId: string | null;
  workspaceName: string;
  path: string;
  teamTitle: string;
  source: string;
  team: Team;
  language: PromptLanguage;
  configured: TeamMode;
  override: TeamMode | null;
  locked: CollabMode | null;
  effective: TeamMode;
  state: "working" | "blocked" | "waiting" | "done" | "ended" | "unknown";
  createdAt: string;
  ended: boolean;
  roles: { name: string; candidate: string; agent: string; model?: string }[];
  members: { terminalId: string; role: string; title: string; agent: string; model?: string; state: string }[];
  pendingBrief: PendingBriefView | null;
  run: RunView | null;
  runCount: number;
}

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  kind: "git" | "folder";
  hostId: string;
  teams: { file: string; title: string; errors: string[]; mode: TeamMode | null }[];
}

export interface WorkspaceAgentView {
  terminalId: string;
  title: string | null;
  agent: string | null;
  state: string;
  role: "lead" | "member" | null;
}

export interface AppState {
  /** The focused workspace, with its agents. */
  focused: { workspaceId: string | null; name: string; branch: string; path: string | null; projectId: string | null; projectPath: string | null; projectName: string | null; projectKind: "git" | "folder" | null; agents: WorkspaceAgentView[] } | null;
  leads: LeadView[];
  /** Planner agents writing team files in the focused checkout, newest first. */
  planners: { terminalId: string; file: string; goal: string; status: "planning" | "done" | "failed"; errors: string[]; startedAt: string }[];
  projects: ProjectView[];
  presets: Preset[];
  settings: { language: "auto" | PromptLanguage; directive: boolean; defaultTeam: string };
  locale: string;
  pluginReady: { cli: boolean; problems: string[] };
}

export interface StartInput {
  /** A project (new worktree) or an existing workspace path. */
  projectPath?: string;
  workspacePath?: string;
  newWorkspace?: { name: string; baseBranch?: string };
  team: { kind: "file"; file: string; root: string } | { kind: "preset"; presetId: string } | { kind: "inline"; team: Team };
  request: string;
  mode?: TeamMode;
  language?: PromptLanguage;
}
