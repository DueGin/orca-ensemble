// Checks a draft with the team schema and maps each problem to the field it belongs to, plus a few warnings that don't
// make a team invalid but usually mean it won't work as meant.
import { TeamSchema, type Team } from "../../shared/team";
import { t } from "../i18n";
import type { TeamDraft } from "./draft";

export interface Issue {
  /** The field the issue belongs to, as a path such as `roles.1.name`; `data-field` carries the same value. */
  field: string;
  level: "error" | "warning";
  message: string;
}

export interface Check {
  issues: Issue[];
  errors: number;
  warnings: number;
  /** The parsed team when the draft is valid. */
  team: Team | null;
}

const quoted = (message: string) => /"([^"]*)"/.exec(message)?.[1] ?? "";

function errorMessage(path: (string | number | symbol)[], code: string, message: string): string {
  const last = path[path.length - 1];
  if (code === "too_small") {
    if (last === "agent") return t("editor.v.agent");
    if (last === "name") return t("editor.v.roleName");
    if (path[path.length - 2] === "folders") return t("editor.v.folder");
  }
  if (code === "custom") {
    if (message.startsWith("duplicate role name")) return t("editor.v.dupRole", { name: quoted(message) });
    if (message.startsWith("duplicate candidate name")) return t("editor.v.dupCandidate", { name: quoted(message) });
    if (message.includes("has the name of a role")) return t("editor.v.candidateIsRole", { name: quoted(message) });
    if (message.startsWith("a team needs")) return t("editor.v.empty");
  }
  return message;
}

export function checkDraft(team: TeamDraft): Check {
  const issues: Issue[] = [];
  const result = TeamSchema.safeParse(team);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map(String);
      // An empty folder entry belongs to the folder list it sits in.
      const field = path[0] === "roles" && path[2] === "folders" ? path.slice(0, 3).join(".") : path.join(".") || "name";
      issues.push({ field, level: "error", message: errorMessage(issue.path, issue.code, issue.message) });
    }
  }
  team.roles.forEach((role, index) => {
    if (!role.instructions.trim()) issues.push({ field: `roles.${index}.instructions`, level: "warning", message: t("editor.v.noInstructions") });
  });
  if (team.mode === "none" && (team.roles.length || team.candidates.length)) issues.push({ field: "mode", level: "warning", message: t("editor.v.modeNone") });
  const errors = issues.filter((issue) => issue.level === "error").length;
  return { issues, errors, warnings: issues.length - errors, team: result.success ? result.data : null };
}

/** Where an issue is, in words: "Role 2 · frontend". */
export function issuePlace(team: TeamDraft, field: string): string {
  const [head, index] = field.split(".");
  const at = Number(index);
  if (head === "roles" && Number.isInteger(at)) return `${t("editor.where.role", { n: at + 1 })}${team.roles[at]?.name.trim() ? ` · ${team.roles[at]!.name.trim()}` : ""}`;
  if (head === "roles") return t("editor.where.roles");
  if (head === "candidates" && Number.isInteger(at)) return t("editor.where.candidate", { n: at + 1 });
  if (head === "candidates") return t("editor.where.candidates");
  if (head === "lead") return t("editor.where.lead");
  if (head === "mode") return t("editor.where.mode");
  return t("editor.where.team");
}
