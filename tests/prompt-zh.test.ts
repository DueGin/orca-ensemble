import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addPost, addTasks, createRun, upsertMember, type BoardPost, type BoardTask, type Brief, type Run } from "../src/shared/collab";
import { PLUGIN_MESSAGE_PREFIX, TEAM_BIN } from "../src/shared/modes";
import * as en from "../src/shared/prompt";
import * as zh from "../src/shared/prompt-zh";
import { checkTeam, type Team } from "../src/shared/team";

const NOW = "2026-11-16T00:00:00.000Z";

function makeTeam(withRoles = true): Team {
  const result = checkTeam({
    version: 1,
    name: "web",
    goal: "Ship the login page",
    mode: "auto",
    lead: { agent: "claude", model: "opus" },
    roles: withRoles ? [{ name: "api", agent: "codex", model: "gpt-5.5", folders: ["src/api"], instructions: "Owns the HTTP API." }] : [],
    candidates: [{ name: "fast", agent: "claude", model: "haiku", effort: "low", notes: "Good at small edits.\nMust not touch migrations." }],
    language: "zh",
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.team;
}

const brief: Brief = {
  title: "Login",
  goal: "Users can sign in with email.",
  requirements: ["POST /login"],
  acceptance: ["Wrong password shows an error"],
  constraints: ["No new dependencies"],
  outOfScope: ["Sign-up"],
  userConfirmation: "好的，开始吧",
};

function makeRun(planApproval: boolean, mode: "team" | "delegation" = "team"): Run {
  let run = createRun({ id: "R1A2B3C4D", leadAgentId: "lead", workspaceId: "w", mode, title: "Login", planApproval, brief, language: "zh", now: NOW });
  run = upsertMember(run, { role: "api", agentId: "a1", title: "api#1A2B", task: "" }, NOW);
  run = upsertMember(run, { role: "fast", agentId: "f1", title: "fast#3C4D", task: "" }, NOW);
  return addTasks(run, [
    { title: "Schema", detail: "Add the users table.", role: "api", files: ["src/api/schema.ts"] },
    { title: "Page", role: "fast", after: ["1"] },
    { title: "Docs" },
  ], "lead", NOW).run;
}

const role = { name: "api", folders: ["src/api"], instructions: "Owns the HTTP API." };
const freeRole = { name: "fast", folders: [], instructions: "" };

function withPlan(task: BoardTask, status: "approved" | "rejected", feedback: string): BoardTask {
  return { ...task, state: "doing", owner: "a1", ownerTitle: "api#1A2B", feedback: "Missing tests", plan: { text: "Add a migration, then test it.", status, feedback, notified: false, delivered: false } };
}

/** Every exported function, called with fixtures that cover its branches: [label, English output, Chinese output]. */
function cases(): Array<[string, string, string]> {
  const team = makeTeam();
  const bare = makeTeam(false);
  const plain = makeRun(false);
  const gated = makeRun(true);
  const delegation = makeRun(false, "delegation");
  const task = plain.tasks[0];
  const approved = withPlan(task, "approved", "Looks good");
  const rejected = withPlan(task, "rejected", "Split the migration");
  const unnamed = { ...withPlan(task, "rejected", ""), ownerTitle: null };
  const post: BoardPost = addPost(plain, { author: "fast", agentId: "f1", kind: "question", text: "Which field holds the email?", to: ["api"], files: ["src/api/schema.ts"] }, NOW).post;
  const both = <A extends unknown[]>(label: string, pick: (m: typeof en) => (...args: A) => string, ...args: A): [string, string, string] => [label, pick(en)(...args), pick(zh as unknown as typeof en)(...args)];
  return [
    both("orchestratorPrompt", (m) => m.orchestratorPrompt, team, ".agents/teams/web.team.json"),
    both("orchestratorPrompt (no roles)", (m) => m.orchestratorPrompt, bare, "preset web"),
    both("leadStartPrompt (request)", (m) => m.leadStartPrompt, team, "web", "Add a login page"),
    both("leadStartPrompt (no request)", (m) => m.leadStartPrompt, team, "web", "  "),
    both("teamChangedMessage", (m) => m.teamChangedMessage, team, "web.team.json"),
    both("memberSystemPrompt", (m) => m.memberSystemPrompt, team, role),
    both("memberSystemPrompt (no folders)", (m) => m.memberSystemPrompt, team, freeRole),
    both("roleHeader", (m) => m.roleHeader, role),
    both("delegationTaskPrompt", (m) => m.delegationTaskPrompt, delegation, "Write the schema for users."),
    both("teamKickoffPrompt", (m) => m.teamKickoffPrompt, plain, brief, [role, freeRole], role, "Your role in this session: api."),
    both("teamKickoffPrompt (plan approval, nothing ready)", (m) => m.teamKickoffPrompt, gated, brief, [role, freeRole], freeRole),
    both("assignmentPrompt", (m) => m.assignmentPrompt, plain, { ...task, feedback: "Missing tests" }, "header"),
    both("assignmentPrompt (plan approval)", (m) => m.assignmentPrompt, gated, task),
    both("verdictLine (approved)", (m) => m.verdictLine, approved),
    both("verdictLine (rejected)", (m) => m.verdictLine, rejected),
    both("planReviewedPrompt", (m) => m.planReviewedPrompt, gated, [approved, rejected]),
    both("teamRoundPrompt", (m) => m.teamRoundPrompt, plain, 7),
    both("mentionPrompt", (m) => m.mentionPrompt, plain, [post]),
    both("broadcastPrompt (lead)", (m) => m.broadcastPrompt, plain, "Use the new schema."),
    both("broadcastPrompt (role)", (m) => m.broadcastPrompt, plain, "Use the new schema.", "api"),
    both("leadNoticePrompt (team)", (m) => m.leadNoticePrompt, plain),
    both("leadNoticePrompt (delegation)", (m) => m.leadNoticePrompt, delegation),
    both("planWaitingPrompt", (m) => m.planWaitingPrompt, gated, approved),
    both("planWaitingPrompt (no owner title)", (m) => m.planWaitingPrompt, gated, unnamed),
    both("modeChangedPrompt (override)", (m) => m.modeChangedPrompt, "team", "auto"),
    both("modeChangedPrompt (team's mode)", (m) => m.modeChangedPrompt, null, "delegation"),
    both("memberStartPrompt", (m) => m.memberStartPrompt, team, role, "First work."),
  ];
}

/** Inline code spans and the lines inside code fences: commands, JSON and field names, kept as they are. */
function codeBits(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  const fenced: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    else if (inFence) fenced.push(line);
  }
  return [...new Set([...spans, ...fenced])];
}

const isCommand = (bit: string) => bit === TEAM_BIN || bit.startsWith(`${TEAM_BIN} `);
const CJK = /[一-鿿]/;
const KEPT_VALUES = ["claim", "done", "plan", "add", "release", "reject", "answer", "lead", "all", "id"].map((value) => `"${value}"`);

describe("Chinese prompts", () => {
  it("export the same functions with the same arity as the English ones", () => {
    const names = (module: Record<string, unknown>) => Object.keys(module).filter((key) => typeof module[key] === "function").sort();
    expect(names(zh)).toEqual(names(en));
    for (const name of names(en)) expect((zh as Record<string, (...args: unknown[]) => unknown>)[name].length, name).toBe((en as Record<string, (...args: unknown[]) => unknown>)[name].length);
    const covered = new Set(cases().map(([label]) => label.split(" ")[0]));
    expect([...covered].sort()).toEqual(names(en));
  });

  it.each(cases())("%s is written in Chinese", (_label, _english, chinese) => {
    expect(chinese).toMatch(CJK);
  });

  it.each(cases())("%s keeps every command, code span and fixed value of the English text", (label, english, chinese) => {
    const bits = codeBits(english);
    for (const bit of bits.filter(isCommand)) expect(chinese, `${label}: ${bit}`).toContain(bit);
    for (const bit of bits) expect(chinese, `${label}: ${bit}`).toContain(bit);
    for (const value of KEPT_VALUES.filter((value) => english.includes(value))) expect(chinese, `${label}: ${value}`).toContain(value);
    for (const field of ["userConfirmation", "planApproval"].filter((field) => english.includes(field))) expect(chinese, `${label}: ${field}`).toContain(field);
    if (english.startsWith(PLUGIN_MESSAGE_PREFIX)) expect(chinese.startsWith(`${PLUGIN_MESSAGE_PREFIX} `), label).toBe(true);
    for (const id of english.match(/\bR1A2B3C4D\b|\bT\d+\b|\bMA-\d\d\b/g) ?? []) expect(chinese, `${label}: ${id}`).toContain(id);
  });

  it("finds the commands it compares", () => {
    const [, english] = cases()[0];
    expect(codeBits(english).filter(isCommand).length).toBeGreaterThan(10);
  });

  it.each(cases())("%s has no line with an em dash pair", (_label, _english, chinese) => {
    for (const line of chinese.split("\n")) expect(line).not.toContain("——");
  });

  it("tells the lead and the members to work in Simplified Chinese", () => {
    const team = makeTeam();
    for (const text of [zh.orchestratorPrompt(team, "web"), zh.memberSystemPrompt(team, role), zh.memberStartPrompt(team, role, "work")]) {
      expect(text).toContain("始终用简体中文回复");
      expect(text).toMatch(/计划、任务结果和黑板帖子也都用简体中文写/);
      expect(text).toContain("保持原样");
    }
    expect(zh.leadStartPrompt(team, "web", "")).toContain("请用简体中文回复");
    expect(zh.leadStartPrompt(team, "web", "Add a login page")).toContain("请用简体中文回复");
    expect(zh.delegationTaskPrompt(makeRun(false, "delegation"), "Do it.")).toContain("请用简体中文回复");
  });

  it("uses the Chinese task board, brief and inbox", () => {
    const run = makeRun(false);
    const kickoff = zh.teamKickoffPrompt(run, brief, [role], role);
    expect(kickoff).toContain("验收标准：");
    expect(kickoff).toContain("待办");
    expect(kickoff).toContain("现在可以由你做的就绪任务：T1, T3。");
    const post = addPost(run, { author: "fast", agentId: "f1", kind: "question", text: "?", to: ["api"], files: [] }, NOW).post;
    expect(zh.mentionPrompt(run, [post])).toContain("你有 1 条新消息");
  });

  it("names the lead 协调器 and keeps a role author as it is", () => {
    const run = makeRun(false);
    expect(zh.broadcastPrompt(run, "hi")).toContain("来自协调器的消息");
    expect(zh.broadcastPrompt(run, "hi", "api")).toContain("来自 api 的消息");
  });

  it("has no em dash pair anywhere in the source", () => {
    expect(readFileSync(new URL("../src/shared/prompt-zh.ts", import.meta.url), "utf8")).not.toContain("——");
  });
});
