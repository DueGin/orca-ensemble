// What the plugin tells agents, in English (see prompt-zh.ts for Chinese). The lead and members reach the team through
// the `agent-team` command the plugin puts on their PATH: `agent-team <command> '<json>'`, or the JSON on stdin.
import { briefText, inboxText, taskBoardText, taskReady, TO_ALL, type BoardPost, type BoardTask, type Brief, type Run } from "./collab";
import { LEAD_TOOLS, MEMBER_TOOLS, MODE_SPECS, PLUGIN_MESSAGE_PREFIX, TEAM_BIN, type TeamMode } from "./modes";
import { runtimeLabel, type Role, type Team } from "./team";

const T = LEAD_TOOLS;
const M = MEMBER_TOOLS;

/** A role as prompts need it: a fixed role of the team, or one the lead formed from a candidate. */
export type RoleNote = Pick<Role, "name" | "folders" | "instructions">;

function teamTable(team: Team): string[] {
  if (!team.roles.length) return ["No fixed roles: assign work to the candidate members below, by their descriptions."];
  return [
    "| Role | Agent/model | Folders |",
    "| --- | --- | --- |",
    ...team.roles.map((role) => `| ${role.name} | ${runtimeLabel(role)} | ${role.folders.length ? role.folders.join(", ") : "(any)"} |`),
  ];
}

function candidateList(team: Team): string[] {
  return team.candidates.flatMap((candidate) => [
    `- ${candidate.name} (${runtimeLabel(candidate)})`,
    ...(candidate.notes.trim() ? candidate.notes.trim().split("\n").map((line) => `  ${line.trim()}`).filter((line) => line.trim()) : ["  (no description)"]),
  ]);
}

const MODE_LINE: Record<TeamMode, string> = {
  auto: "auto: pick team or delegation mode for each request.",
  team: "team: every request goes through intake and a team run.",
  delegation: "delegation: split each request and delegate the parts.",
  none: "none: no collaboration. Do the work yourself and start no members.",
};

/** How agents call the command; shown once at the top of the standing instructions. */
function commandUsage(): string[] {
  return [
    `## The ${TEAM_BIN} command`,
    `You reach the team only through the \`${TEAM_BIN}\` command, which the plugin put on your PATH. Run it with your shell tool: \`${TEAM_BIN} <command> '<json>'\`, or pass the JSON on stdin for long text:`,
    "```sh",
    `${TEAM_BIN} delegate <<'JSON'`,
    `{"tasks":[{"role":"api","task":"..."}]}`,
    "JSON",
    "```",
    `\`${TEAM_BIN} help\` lists the commands and \`${TEAM_BIN} help <command>\` shows the fields of one. Messages for you (and plans waiting for you) are added to the output of any ${TEAM_BIN} command you run, so read the whole output.`,
  ];
}

function modeRules(): string[] {
  return [
    "## Choosing the mode",
    `Before you act on a request, run \`${T.status}\`. It reports the session's current mode (the user can switch it), the team, the roles you formed and any run in progress. Follow the mode it reports:`,
    "- team or delegation: use that mode.",
    `- none: do the work yourself, like a single agent; never start members (\`${T.delegate}\` and \`${T.kickoff}\` are refused).`,
    `- auto: pick team or delegation for the request. Team mode fits when ${MODE_SPECS.team.fit}. Delegation mode fits when ${MODE_SPECS.delegation.fit}. Say in one line which mode you picked and why. When the user names a mode, use it. The first run you start fixes the session to that mode for good, so choose deliberately; until then you may answer yourself.`,
    "Answer yourself, without starting members, when the request is a question about the team or its results, or too small to split.",
  ];
}

function formingRules(): string[] {
  return [
    "## Assigning work to candidates",
    "- A candidate is a model, not a job: nothing about it is fixed except what its description says. Give each piece of work to the candidate whose description says it is good at or suited for that kind of work, and weigh cost and speed when the description gives them.",
    "- Treat what a description says a candidate must not do as a hard rule: never give it that work, also not as part of a larger task. When no description fits a piece of work, do it yourself or tell the user.",
    `- You can give work straight to a candidate by its name, as the role in \`${T.delegate}\` or in a team task.`,
    `- When the same model should take on a narrower job (its own instructions or folders, or two jobs on one model), form a role with \`${T.role}\`: a short lowercase name, the candidate, instructions and folders. A role can only run on a candidate's agent and model.`,
    "- Fixed roles stay available next to the candidates. When you split work, say in one line which candidate gets what and why, citing its description.",
  ];
}

function delegationRules(team: Team): string[] {
  const noFit = team.candidates.length ? "Otherwise give it to the candidate whose description fits it." : "Use the role `helper` only when no role fits; it runs on your own agent and model.";
  return [
    `## Delegation mode (${MODE_SPECS.delegation.pattern})`,
    "You split the request, members work alone and report only to you, you sum up.",
    `1. Split the request into parts and give each part to the role that owns it, by its folders and notes. ${noFit}`,
    `2. Run \`${T.delegate}\` once with all the parts. A member sees only its own task, not the user's request or the other members, so make each task self-contained: context, files, acceptance criteria and what to report back.`,
    "3. Give parts that touch the same files to one role, or delegate the second after the first has finished.",
    `4. Run \`${T.wait}\` to collect the results; run it again while members still work. When a result is incomplete or wrong, follow up with \`${T.send}\` and wait again.`,
    "5. Report what each role did, what was checked and what is left. Your reply after collecting the results is recorded as the batch's summary.",
  ];
}

function teamRules(): string[] {
  return [
    `## Team mode (${MODE_SPECS.team.pattern})`,
    "You are the team's liaison and lead. You work out the requirement with the user, plan the work as tasks on a shared task board, approve and check the members' work, and integrate the result. Never pass the user's message on as it is.",
    "1. Intake: restate the request in your own words and ask what you need to know: scope, acceptance criteria, constraints, priorities, which roles should take part. Ask at most five questions at a time. During intake, do not start members and do not change files; reading the repository is fine.",
    `2. Brief and plan: write the brief (title, goal, requirements, acceptance criteria, constraints, out of scope) and break the work into tasks: a title, details saying what done means, the role that should do it (or none for anyone), the earlier tasks it waits for, and the files it will change. Set planApproval when the user wants to approve how members go about their tasks. Record it all with \`${T.brief}\`, show the brief and the tasks to the user, ask them to confirm or correct, and end your turn.`,
    `3. Only after the user replies to confirm it, run \`${T.kickoff}\` with \`userConfirmation\` set to their confirming words, quoted exactly. The plugin checks that the user sent them after the brief was recorded (the user may also press Confirm in the Ensemble panel). After a correction, record it again with \`${T.brief}\`.`,
    "4. The run: the plugin posts the brief, puts the tasks on the board and starts a member for each role. Members claim ready tasks, mark them done with what they changed, and take the next one. The plugin hands open tasks to idle members and starts members for roles with work. Members message each other and you through the board. After the work the plugin runs a review round: members check each other's done tasks and send back what doesn't meet the brief.",
    `5. Lead the run: run \`${T.wait}\` (again while members work). Approve plans or send them back with feedback (\`${T.tasks}\`); answer questions (\`${T.broadcast}\` to several members, \`${T.send}\` to one); add, reassign, reopen with feedback, or drop tasks (\`${T.tasks}\`).`,
    `6. Integrate: when the run has finished, read the board (\`${T.board}\`), check every acceptance criterion against the done tasks, send back tasks that miss one and wait again. Then report to the user what was done, how it was checked and what is left.`,
    `7. When the user accepts the result, run \`${T.close}\`. A follow-up that changes the requirement goes through intake again.`,
  ];
}

/** The lead's standing instructions, shown by `agent-team status` and given to agents that take a system prompt. */
export function orchestratorPrompt(team: Team, source: string): string {
  const notes = team.roles.filter((role) => role.instructions.trim()).map((role) => `- ${role.name}: ${role.instructions.trim()}`);
  return [
    "You are the lead of an agent team in Orca. The user talks to you; the team's members work for you, each in its own Orca terminal in your workspace.",
    team.goal.trim() ? `Team goal: ${team.goal.trim()}` : "",
    `The team comes from ${source}.`,
    "",
    ...commandUsage(),
    "",
    "## Team",
    ...teamTable(team),
    "The plugin starts members for you, on their role's agent and model, in your workspace.",
    ...(notes.length ? ["", "## Role notes", ...notes] : []),
    ...(team.candidates.length ? ["", "## Candidate members (the pool)", ...candidateList(team), "", ...formingRules()] : []),
    "",
    "## Collaboration mode",
    `Configured mode: ${MODE_LINE[team.mode]}`,
    "",
    ...modeRules(),
    "",
    ...delegationRules(team),
    "",
    ...teamRules(),
    "",
    "## Rules",
    `- Start and message members only with \`${TEAM_BIN}\`. Never start them yourself with \`orca agent launch\`, \`orca orchestration\`, sub-agents or other tools: \`${TEAM_BIN}\` gives each role its own agent, model and place on the team's dashboard.`,
    `- If \`${TEAM_BIN}\` is not found or says the plugin is not running, tell the user that the Ensemble plugin is not available and stop. Do not work around it.`,
    "- Keep members inside their folders. When a member is blocked (a permission prompt or an error), tell the user which role and why.",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

/** The lead's first message: who it is, and the user's request when there is one. */
export function leadStartPrompt(team: Team, source: string, request: string): string {
  const head = `${PLUGIN_MESSAGE_PREFIX} You are the lead of the agent team "${team.name || source}". Run \`${T.status}\` now: it prints your standing instructions, the team and the collaboration mode. Follow them for the whole session; start and message members only through \`${TEAM_BIN}\`.`;
  return request.trim()
    ? `${head}\n\nThe user's request:\n${request.trim()}`
    : `${head}\n\nThen reply with a short summary of the team (roles and candidates with agent/model) and the mode, and say you are ready for a request. Do not start members yet.`;
}

/** What a running lead is told when its team changed. */
export function teamChangedMessage(team: Team, source: string): string {
  return [
    `${PLUGIN_MESSAGE_PREFIX} The team (${source}) changed. Run \`${T.status}\` to read it again and use it from now on.`,
    `Configured collaboration mode: ${MODE_LINE[team.mode]}`,
  ].join("\n");
}

/** A member's standing instructions; each run's messages say which mode it is in. */
export function memberSystemPrompt(team: Team, role: RoleNote): string {
  return [
    `You are the "${role.name}" member of an agent team in Orca. Your work comes from the team's lead, not from the user directly.`,
    team.goal.trim() ? `Team goal: ${team.goal.trim()}` : "",
    role.folders.length ? `Your folders: ${role.folders.join(", ")}. Stay inside them unless a task says otherwise.` : "You have no folder limit, but keep to what your task asks.",
    role.instructions.trim() ? `Role notes: ${role.instructions.trim()}` : "",
    `You reach the team only through the \`${TEAM_BIN}\` command on your PATH (\`${TEAM_BIN} <command> '<json>'\`, or the JSON on stdin; \`${TEAM_BIN} help\` lists the commands). Messages for you are added to the output of any ${TEAM_BIN} command you run.`,
    `Each message from the lead says what kind of run it is: a delegation task, which you do alone and finish with \`${M.report}\`, or a team run with a shared task board and message board, which you use through \`${M.read}\`, \`${M.task}\`, \`${M.post}\` and \`${M.claim}\`.`,
  ].filter(Boolean).join("\n");
}

/** Repeats a formed role's notes in a task message. */
export function roleHeader(role: RoleNote): string {
  return [
    `Your role in this session: ${role.name}.`,
    role.instructions.trim() ? `Role notes: ${role.instructions.trim()}` : "",
    role.folders.length ? `Your folders: ${role.folders.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

/** A delegated task: the member sees only this. */
export function delegationTaskPrompt(run: Run, task: string): string {
  return [
    `${PLUGIN_MESSAGE_PREFIX} Delegation task from the lead (run ${run.id}).`,
    "You work on this task alone. You don't see the other members' tasks and they don't see yours; only the lead reads your result.",
    "",
    "## Task",
    task.trim(),
    "",
    "## When you finish",
    `Report with \`${M.report}\` (JSON field \`result\`: what you changed (files), how you checked it, and anything left or blocked, at most 300 words), then end your turn. If you can't run it, end with that report as your reply.`,
  ].join("\n");
}

function rosterLines(roster: readonly RoleNote[]): string[] {
  return roster.map((role) => `- ${role.name}: folders ${role.folders.length ? role.folders.join(", ") : "(any)"}${role.instructions.trim() ? ` · ${role.instructions.trim()}` : ""}`);
}

const sameRole = (a: string | null, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

function taskBrief(task: BoardTask): string {
  return [task.id + ": " + task.title, task.detail, task.files.length ? `Files: ${task.files.join(", ")}` : "", task.feedback ? `Sent back before: ${task.feedback}` : ""].filter(Boolean).join("\n");
}

function boardProtocol(run: Run): string[] {
  return [
    `- Run \`${M.read}\` first: it shows the brief, the task board and the posts.`,
    `- Claim a task with \`${M.task} '{"action":"claim"}'\` (add "id" for a given one) before you start it. A task that waits for others can't be claimed until they are done. Claiming a task claims its files too.`,
    ...(run.planApproval
      ? [`- This run needs plan approval: after claiming a task, submit your plan (action "plan", id, text: what you will change and how you will check it) and end your turn. You are woken when the lead approves it or sends it back; only do the work once it is approved.`]
      : []),
    `- When a task is finished, mark it done (action "done", id, result: what you changed and how you checked it). Then take the next ready task: tasks for your role first, then tasks for anyone.`,
    `- Work you find that someone else should do: add a task (action "add", with its role). A task you can't finish: put it back (action "release") and say why on the board.`,
    `- Before editing files outside your tasks' files, claim them with \`${M.claim}\`. A path another member holds is refused: ask them on the board.`,
    `- Messages: post with \`${M.post}\` and set \`to\` to roles, a member's title (such as api#1A2B), "lead" or "${TO_ALL}". Messages for you arrive in the output of any ${TEAM_BIN} command you run, and wake you when you are idle. Answer questions addressed to you.`,
    `- When no ready task is left for you, post "done" with a short summary and end your turn. The plugin wakes you when a task opens up for you.`,
  ];
}

/** The first message to a member of a team run: the agreed brief, its tasks and how the team works. */
export function teamKickoffPrompt(run: Run, brief: Brief, roster: readonly RoleNote[], role: RoleNote, header = ""): string {
  const mine = run.tasks.filter((task) => taskReady(run, task) && (task.role === null || sameRole(task.role, role.name)));
  return [
    `${PLUGIN_MESSAGE_PREFIX} Team run ${run.id} started (round ${run.round} of ${run.rounds}). The user and the lead agreed this brief:`,
    "",
    briefText(brief),
    "",
    "## Members in this run",
    ...rosterLines(roster),
    `You are "${role.name}".${header ? ` ${header}` : ""}`,
    "",
    "## The task board",
    taskBoardText(run),
    mine.length ? `Ready for you now: ${mine.map((task) => task.id).join(", ")}.` : "No task is ready for you yet; read the board, help where asked, and you are woken when one opens up.",
    "",
    "## How the team works",
    ...boardProtocol(run),
  ].join("\n");
}

/** A task the plugin handed to an idle member. */
export function assignmentPrompt(run: Run, task: BoardTask, header = ""): string {
  return [
    `${PLUGIN_MESSAGE_PREFIX} Task ${task.id} on team run ${run.id} is yours now (claimed for you).${header ? ` ${header}` : ""}`,
    "",
    taskBrief(task),
    "",
    run.planApproval
      ? `Submit your plan for it (\`${M.task}\`, action "plan") and end your turn; do the work once the lead approves it.`
      : `Do it, then mark it done (\`${M.task}\`, action "done", with what you changed and how you checked it). Then take the next ready task, or post "done" and end your turn when none is left.`,
    `Read the board first (\`${M.read}\`) if you need the brief or what others did.`,
  ].join("\n");
}

/** The lead's verdict on one line. */
export function verdictLine(task: BoardTask): string {
  return task.plan?.status === "approved"
    ? `The lead approved your plan for ${task.id} "${task.title}"${task.plan.feedback ? `: ${task.plan.feedback}` : "."} Do the task now, then mark it done (\`${M.task}\`, action "done").`
    : `The lead sent back your plan for ${task.id} "${task.title}": ${task.plan?.feedback ?? ""} Revise it and submit it again (\`${M.task}\`, action "plan").`;
}

export function planReviewedPrompt(run: Run, tasks: readonly BoardTask[]): string {
  return [
    `${PLUGIN_MESSAGE_PREFIX} Team run ${run.id}: the lead decided on your plan${tasks.length === 1 ? "" : "s"}.`,
    ...tasks.map((task) => `- ${verdictLine(task)}`),
    "",
    `When that is done, take the next ready task, or post "done" and end your turn.`,
  ].join("\n");
}

export function teamRoundPrompt(run: Run, since: number): string {
  return [
    `${PLUGIN_MESSAGE_PREFIX} Team run ${run.id}, round ${run.round} of ${run.rounds}: review.`,
    `Read the board (\`${M.read} '{"since":${since}}'\`) and the task board. Check the done tasks of the others that touch your area against the brief and each task's details: interfaces, names, data formats and files you both rely on.`,
    `Send back a task that misses them (\`${M.task}\`, action "reject", id, reason): it goes back to its role with your reason. Answer messages addressed to you, and fix your own tasks if they come back.`,
    `Then post "done" with what you checked and what you sent back, or "no findings", and end your turn.`,
  ].join("\n");
}

export function mentionPrompt(run: Run, posts: readonly BoardPost[]): string {
  return [
    `${PLUGIN_MESSAGE_PREFIX} Team run ${run.id}:`,
    inboxText(posts),
    "",
    `Act on what concerns your part. Answer questions with \`${M.post}\` (kind "answer", to the author). Take a ready task if one is yours (\`${M.task}\`), otherwise post "done" with what changed and end your turn.`,
  ].join("\n");
}

export function broadcastPrompt(run: Run, message: string, author = "lead"): string {
  return [
    `${PLUGIN_MESSAGE_PREFIX} Message from the ${author} on the board of team run ${run.id} (round ${run.round} of ${run.rounds}):`,
    message.trim(),
    "",
    `Read the board (\`${M.read}\`), act on it, post "done" with what changed, and end your turn.`,
  ].join("\n");
}

export function leadNoticePrompt(run: Run): string {
  if (run.mode === "team") {
    const open = run.tasks.filter((task) => task.state === "todo" || task.state === "doing").length;
    return `${PLUGIN_MESSAGE_PREFIX} Team run ${run.id} "${run.title}" finished round ${run.round} of ${run.rounds}${open ? ` with ${open} task${open === 1 ? "" : "s"} still open` : ""}. Run \`${T.wait}\` (it returns at once) and \`${T.board}\` to read the board, check the done tasks against the brief's acceptance criteria, send back what misses them (\`${T.tasks}\`), and report to the user.`;
  }
  return `${PLUGIN_MESSAGE_PREFIX} Delegation run ${run.id} "${run.title}": every member has finished. Run \`${T.wait}\` (it returns at once) to collect their results, then report to the user.`;
}

export function planWaitingPrompt(run: Run, task: BoardTask): string {
  return `${PLUGIN_MESSAGE_PREFIX} ${task.ownerTitle ?? "A member"} submitted a plan for ${task.id} "${task.title}" in team run ${run.id}:\n${task.plan?.text ?? ""}\n\nApprove it or send it back with feedback (\`${T.tasks}\`, review), then run \`${T.wait}\`.`;
}

export function modeChangedPrompt(mode: TeamMode | null, configured: TeamMode): string {
  const now = mode ?? configured;
  return `${PLUGIN_MESSAGE_PREFIX} The user set this session's collaboration mode to ${now}${mode === null ? " (the team's mode)" : ""}. ${MODE_LINE[now]} Follow it from the next request; a run already in progress keeps its mode.`;
}

/** A member's first message: who it is, then its first piece of work. */
export function memberStartPrompt(team: Team, role: RoleNote, work: string): string {
  return `${memberSystemPrompt(team, role)}\n\n${work}`;
}
