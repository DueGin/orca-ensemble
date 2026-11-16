// Builds dev/fixtures.js for the static run-report harness: the real runs in ~/.orca-ensemble/*/runs, converted to
// RunDetail like the worker's detailView does, plus a team run and a delegation run played through the shared state
// functions (so their data flow is traced exactly like a live run's).
// Run: node dev/make-fixtures.mjs  (bundled from this file by dev/build-harness.mjs)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  addBatch, addPost, addTasks, attachPacket, claimPaths, claimTask, completeTask, createRun, finishMember, markCollected, markInbox, markPlansNotified, markVerdictsDelivered, normalizeRun, rejectTask, reviewPlan,
  startBatch, startRound, submitPlan, summarizeBatch, taskOf, updateMember, updateTasks, upsertMember, type Brief, type Run,
} from "../src/shared/collab";
import { logEvents, traceRun, type FlowParty, type NewEvent } from "../src/shared/flow";
import type { RunDetail } from "../src/shared/views";

const T0 = Date.parse("2026-11-16T09:00:00.000Z");
let clock = 0;
const at = () => new Date(T0 + clock * 1000).toISOString();

/** Applies a change the way the run store does: trace, then log. */
function step(run: Run, change: (run: Run, now: string) => Run, actor: FlowParty = "plugin", seconds = 20): Run {
  clock += seconds;
  const now = at();
  const after = change(run, now);
  return after === run ? run : logEvents(after, traceRun(run, after, actor), now);
}
/** Notices the plugin logs itself once sent. */
function note(run: Run, events: NewEvent[], seconds = 2): Run {
  clock += seconds;
  return logEvents(run, events, at());
}
const ok = <T extends { run: Run; error?: string; errors?: string[] }>(result: T): Run => {
  if (result.error || result.errors?.length) throw new Error(result.error ?? result.errors!.join("; "));
  return result.run;
};

type Extra = { agent: string | null; model: string | null; live: string | null };

function detailOf(run: Run, extra: (agentId: string) => Extra): RunDetail {
  const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
  return {
    id: run.id, mode: run.mode, title: run.title, reason: run.reason, status: run.status, round: run.round, rounds: run.rounds, planApproval: run.planApproval, language: run.language, createdAt: run.createdAt, updatedAt: run.updatedAt,
    brief: run.brief,
    leadReadSeq: run.leadReadSeq,
    members: run.members.map((member) => ({ role: member.role, agentId: member.agentId, title: member.title, state: member.state, task: clip(member.task, 6000), result: member.result, collected: member.collected, readSeq: member.readSeq, inboxSeq: member.inboxSeq, retired: member.retired, dispatchedAt: member.dispatchedAt, ...extra(member.agentId) })),
    tasks: run.tasks.map((task) => ({ id: task.id, title: task.title, detail: task.detail, role: task.role, deps: task.deps, waitingOn: task.state === "todo" ? task.deps.filter((dep) => taskOf(run, dep)?.state !== "done") : [], files: task.files, state: task.state, owner: task.owner, ownerTitle: task.ownerTitle, result: task.result, plan: task.plan ? { text: task.plan.text, status: task.plan.status, feedback: task.plan.feedback, delivered: task.plan.delivered } : null, feedback: task.feedback, createdBy: task.createdBy, updatedAt: task.updatedAt })),
    posts: run.posts.slice(-300).map((post) => ({ ...post, text: clip(post.text, 6000) })),
    claims: run.claims.map((claim) => ({ ...claim, path: claim.path || "." })),
    events: run.events,
    batches: run.batches.map((batch) => ({ ...batch })),
    // Not in RunDetail yet; the report focuses the lead when the worker sends it.
    ...({ leadAgentId: run.leadAgentId } as object),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A team run: intake brief, a task board with dependencies, plan approval (one plan sent back), board posts, file claims,
// a review that sends a task back, a dropped task and a second round.

function teamRun(): { run: Run; extra: Record<string, Extra> } {
  clock = 0;
  const brief: Brief = {
    title: "Dark mode for the settings page",
    goal: "Users can switch the app between light, dark and system themes from Settings, and the choice sticks across reloads.",
    requirements: ["A theme setting (light, dark, system) stored with the user's preferences", "A toggle in Settings → Appearance", "Every screen reads colors from CSS variables, so the theme applies everywhere", "\"System\" follows prefers-color-scheme live"],
    acceptance: ["Switching the theme recolors the app without a reload", "The choice survives a reload and a new login", "No flash of the light theme on load when dark is chosen", "Text contrast meets WCAG AA in both themes"],
    constraints: ["Keep the light theme as the default", "No new runtime dependencies"],
    outOfScope: ["Per-workspace themes", "A theme editor"],
    userConfirmation: "Looks good, go ahead. Keep light as the default for now.",
  };
  let run = createRun({ id: "RTEAMDEMO1", leadAgentId: "term_lead", workspaceId: "w", mode: "team", title: brief.title, reason: "Several roles touch shared files (API, UI, styles); they need a shared board and review.", rounds: 2, brief, planApproval: true, language: "en", now: at() });
  run = logEvents(run, traceRun(null, run, "lead"), at());
  const members = [
    { role: "api", agentId: "term_api", title: "api#7C20" },
    { role: "ui", agentId: "term_ui_old", title: "ui#A1F3" },
    { role: "tester", agentId: "term_test", title: "tester#3B9E" },
  ];
  for (const member of members) run = step(run, (current, now) => upsertMember(current, { ...member, task: "" }, now), "lead", 4);
  run = step(run, (current, now) => addPost(current, { author: "lead", agentId: "term_lead", kind: "brief", text: `${brief.title}\n\n${brief.goal}\n\nAcceptance:\n- ${brief.acceptance.join("\n- ")}`, to: ["all"], files: [] }, now).run, "lead", 3);
  run = step(run, (current, now) => ok(addTasks(current, [
    { title: "Add a theme setting to the user preferences API", detail: "Extend PATCH /api/preferences with `theme: \"light\" | \"dark\" | \"system\"`, validate it, default to light.", role: "api", files: ["src/api/preferences.ts", "src/api/schema.ts"] },
    { title: "Theme toggle in Settings → Appearance", detail: "A segmented control with Light, Dark and System. Saves through the preferences API and applies at once.", role: "ui", after: ["1"], files: ["src/ui/settings/ThemeToggle.tsx"] },
    { title: "Move every color to CSS variables and add the dark palette", detail: "Replace hard-coded colors with tokens from tokens.ts; add a dark palette under html.dark.", role: "ui", files: ["src/ui/theme.css", "src/ui/tokens.ts"] },
    { title: "Restore the theme before first paint", detail: "Read the saved theme in the inline boot script so dark users never see a light flash.", role: "api", after: ["1"], files: ["src/boot.ts"] },
    { title: "End-to-end test for switching and persisting the theme", detail: "Playwright: switch to dark, reload, log out and in, check the html class and a sampled color.", role: "tester", after: ["2", "3"] },
    { title: "Write the docs page for themes", role: null },
  ], "lead", now)), "lead", 30);

  // api takes T1, plans it, the lead approves, it finishes.
  run = step(run, (current, now) => ok(claimTask(current, "term_api", "T1", now)), "term_api", 40);
  run = step(run, (current, now) => ok(submitPlan(current, "term_api", "T1", "1. Add `theme` to the Preferences schema with a default of \"light\".\n2. Validate it in the PATCH handler and return 400 on other values.\n3. Migration: existing rows get null and read as light.\n4. Unit tests for the handler.", now)), "term_api", 60);
  run = step(run, (current, now) => markPlansNotified(current, ["T1"], true, now), "plugin", 3);
  run = note(run, [{ component: "plans", action: "notify", direction: "out", from: "plugin", to: ["lead"], subject: "T1", note: "" }]);
  // ui takes T3 at the same time.
  run = step(run, (current, now) => ok(claimTask(current, "term_ui_old", "T3", now)), "term_ui_old", 10);
  run = step(run, (current, now) => ok(reviewPlan(current, "T1", true, "Good. Keep the default in one place.", now)), "lead", 50);
  run = step(run, (current, now) => markVerdictsDelivered(current, ["T1"], true, now), "plugin", 3);
  run = note(run, [{ component: "plans", action: "verdict", direction: "out", from: "plugin", to: ["term_api"], subject: "T1", note: "" }]);
  run = step(run, (current, now) => ok(submitPlan(current, "term_ui_old", "T3", "Add new tokens --surface-dark-1..4 and swap colors per component.", now)), "term_ui_old", 30);
  run = note(run, [{ component: "plans", action: "notify", direction: "out", from: "plugin", to: ["lead"], subject: "T3", note: "" }]);
  run = step(run, (current, now) => ok(addPost(current, { author: "api", agentId: "term_api", kind: "update", text: "PATCH /api/preferences now accepts theme: light | dark | system. GET returns \"light\" when unset.", to: ["ui"], files: ["src/api/preferences.ts"] }, now)), "term_api", 40);
  run = step(run, (current, now) => markInbox(current, "term_ui_old", current.posts.at(-1)!.seq, now), "plugin", 2);
  run = step(run, (current, now) => ok(reviewPlan(current, "T3", false, "Use the existing token names in tokens.ts instead of new ones, and define the dark values under html.dark.", now)), "lead", 45);
  run = step(run, (current, now) => markVerdictsDelivered(current, ["T3"], true, now), "plugin", 3);
  run = note(run, [{ component: "plans", action: "verdict", direction: "out", from: "plugin", to: ["term_ui_old"], subject: "T3", note: "" }]);
  run = step(run, (current, now) => ok(completeTask(current, "term_api", "T1", "Added `theme` to the preferences schema (default light) and validation in the PATCH handler; 6 unit tests pass (npm test -- preferences).", now)), "term_api", 70);
  run = step(run, (current, now) => ok(addPost(current, { author: "ui", agentId: "term_ui_old", kind: "question", text: "Should \"system\" follow prefers-color-scheme live, or only on load?", to: ["lead"], files: [] }, now)), "term_ui_old", 25);
  run = step(run, (current, now) => markInbox(current, "lead", current.posts.at(-1)!.seq, now), "plugin", 2);
  run = step(run, (current, now) => ({ ...current, leadReadSeq: current.posts.at(-1)!.seq }), "lead", 20);
  run = step(run, (current, now) => ok(addPost(current, { author: "lead", agentId: "term_lead", kind: "answer", text: "Live: listen to matchMedia changes while the theme is \"system\".", to: ["ui"], files: [] }, now)), "lead", 15);
  run = step(run, (current, now) => ok(submitPlan(current, "term_ui_old", "T3", "1. Map every hard-coded color to the existing tokens in tokens.ts.\n2. Add the dark values under html.dark in theme.css.\n3. Check contrast with the axe audit in both themes.", now)), "term_ui_old", 40);
  run = step(run, (current, now) => ok(reviewPlan(current, "T3", true, "", now)), "lead", 30);
  run = step(run, (current, now) => markVerdictsDelivered(current, ["T3"], true, now), "plugin", 3);
  // The ui role moves to another model: its member is replaced.
  run = step(run, (current, now) => ({ ...current, updatedAt: now, members: current.members.map((member) => (member.agentId === "term_ui_old" ? { ...member, retired: true, state: "done" as const } : member)), tasks: current.tasks.map((task) => (task.owner === "term_ui_old" && task.state === "doing" ? { ...task, state: "todo" as const, owner: null, ownerTitle: null, plan: null, updatedAt: now } : task)), claims: current.claims.filter((claim) => claim.agentId !== "term_ui_old") }), "lead", 30);
  run = step(run, (current, now) => upsertMember(current, { role: "ui", agentId: "term_ui", title: "ui#D402", task: "" }, now), "lead", 5);
  run = step(run, (current, now) => ok(claimTask(current, "term_ui", "T3", now)), "term_ui", 20);
  run = step(run, (current, now) => ok(submitPlan(current, "term_ui", "T3", "Same plan as approved before: existing tokens, dark values under html.dark, axe audit.", now)), "term_ui", 25);
  run = step(run, (current, now) => ok(reviewPlan(current, "T3", true, "Approved, as before.", now)), "lead", 20);
  run = step(run, (current, now) => markVerdictsDelivered(current, ["T3"], true, now), "plugin", 3);
  run = step(run, (current, now) => ok(claimTask(current, "term_api", "T4", now)), "term_api", 10);
  run = step(run, (current, now) => ok(submitPlan(current, "term_api", "T4", "Inline script in index.html reads localStorage.theme (mirrored from the API) and sets html.className before CSS loads.", now)), "term_api", 30);
  run = step(run, (current, now) => ok(reviewPlan(current, "T4", true, "", now)), "lead", 25);
  run = step(run, (current, now) => markVerdictsDelivered(current, ["T4"], true, now), "plugin", 3);
  run = step(run, (current, now) => ok(completeTask(current, "term_api", "T4", "Boot script sets the class from localStorage before the stylesheet; the API mirrors the value on save.", now)), "term_api", 80);
  run = step(run, (current, now) => ok(addPost(current, { author: "tester", agentId: "term_test", kind: "finding", text: "With the dark theme saved, a hard reload still shows a white frame for ~80 ms: the boot script runs after theme.css is requested.", to: ["api", "lead"], files: ["src/boot.ts"] }, now)), "term_test", 50);
  run = step(run, (current, now) => ok(rejectTask(current, "T4", "The boot script runs after theme.css starts loading; a dark user still sees a white flash on hard reload.", now)), "lead", 30);
  run = step(run, (current, now) => ok(updateTasks(current, [{ id: "T6", state: "dropped" }], now)), "lead", 20);
  run = step(run, (current, now) => ok(completeTask(current, "term_ui", "T3", "All colors now come from tokens.ts; dark values live under html.dark. axe: 0 contrast issues in either theme.", now)), "term_ui", 90);
  run = step(run, (current, now) => ok(addPost(current, { author: "ui", agentId: "term_ui", kind: "done", text: "T3 done: tokens everywhere, dark palette in place, axe clean.", to: ["lead"], files: ["src/ui/theme.css", "src/ui/tokens.ts"] }, now)), "term_ui", 5);
  // Reads and inbox deliveries.
  run = step(run, (current, now) => updateMember(current, "term_api", { readSeq: current.posts.at(-1)!.seq }, now), "term_api", 10);
  run = step(run, (current, now) => markInbox(current, "term_test", 3, now), "plugin", 2);
  run = step(run, (current, now) => updateMember(current, "term_test", { readSeq: 4 }, now), "term_test", 6);
  // Round 2.
  run = step(run, (current, now) => ({ ...current, members: current.members.map((member) => (member.retired ? member : { ...member, state: "done" as const })) }), "plugin", 20);
  run = step(run, (current, now) => startRound(current, now), "plugin", 4);
  run = step(run, (current, now) => ok(claimTask(current, "term_ui", "T2", now)), "term_ui", 15);
  run = step(run, (current, now) => ok(submitPlan(current, "term_ui", "T2", "A Segmented control (Light / Dark / System) in Appearance; optimistic update, rollback on API error; matchMedia listener while System is on.", now)), "term_ui", 40);
  run = note(run, [{ component: "plans", action: "notify", direction: "out", from: "plugin", to: ["lead"], subject: "T2", note: "" }]);
  run = step(run, (current, now) => ok(claimTask(current, "term_api", "T4", now)), "term_api", 12);
  run = step(run, (current, now) => ok(submitPlan(current, "term_api", "T4", "Move the boot script into <head> before the stylesheet link, and read the cookie mirror so it works before JS bundles load.", now)), "term_api", 35);
  run = step(run, (current, now) => ok(reviewPlan(current, "T4", true, "Yes. Add a test for the cookie fallback.", now)), "lead", 25);
  run = step(run, (current, now) => markVerdictsDelivered(current, ["T4"], true, now), "plugin", 3);
  run = step(run, (current, now) => claimPaths(current, "term_api", ["index.html"], now).run, "term_api", 6);
  run = note(run, [{ component: "claims", action: "conflict", direction: "in", from: "term_test", to: [], subject: "src/boot.ts", note: "held by api#7C20" }], 8);
  run = step(run, (current, now) => ok(addPost(current, { author: "tester", agentId: "term_test", kind: "update", text: "Waiting for T2 before I write the E2E test; drafting the fixtures meanwhile.", to: ["lead"], files: [] }, now)), "term_test", 10);
  return {
    run,
    extra: {
      term_api: { agent: "codex", model: "gpt-5.1-codex", live: "working" },
      term_ui_old: { agent: "claude", model: "haiku", live: null },
      term_ui: { agent: "claude", model: "sonnet", live: "blocked" },
      term_test: { agent: "gemini", model: "gemini-2.5-pro", live: "waiting" },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A delegation run: two splits (the first with an overlap warning), three sub-agents, one reused for a follow-up, one
// that needed attention, and the lead's summaries.

function delegationRun(): { run: Run; extra: Record<string, Extra> } {
  clock = 0;
  let run = createRun({ id: "RDELEGDEMO", leadAgentId: "term_lead2", workspaceId: "w", mode: "delegation", title: "Audit the three services for missing request timeouts and add them", reason: "Three independent services in separate folders: each sub-agent can audit and fix one alone.", language: "en", now: at() });
  run = logEvents(run, traceRun(null, run, "lead"), at());
  const packets = [
    { role: "billing", agentId: "term_bill", title: "billing#11AF", task: "Audit services/billing for outgoing HTTP calls without a timeout. Add a 10 s timeout to each (use the shared httpClient options). Report the files you changed and any call you left alone, with why." },
    { role: "search", agentId: "term_search", title: "search#5D0E", task: "Audit services/search for outgoing HTTP and gRPC calls without a deadline. Add 5 s deadlines. Report the files you changed." },
    { role: "notify", agentId: "term_notify", title: "notify#C3B2", task: "Audit services/notify (email + push providers) for calls without a timeout. Add 15 s timeouts and a retry on 503 only. Report the files you changed." },
  ];
  run = step(run, (current, now) => addBatch(current, { title: "Audit the three services for missing request timeouts and add them", reason: run.reason, warnings: ["billing and notify both list shared/http"], followUp: false }, now), "lead", 5);
  for (const [index, packet] of packets.entries()) {
    run = step(run, (current, now) => {
      const added = ok(addTasks(current, [{ title: packet.task.slice(0, 90), detail: packet.task, role: packet.role }], "lead", now));
      const id = `T${index + 1}`;
      let next = upsertMember(added, packet, now);
      next = { ...next, tasks: next.tasks.map((task) => (task.id === id ? { ...task, state: "doing" as const, owner: packet.agentId, ownerTitle: packet.title } : task)) };
      return attachPacket(next, id);
    }, "lead", 3);
    run = note(run, [{ component: "contexts", action: "start", direction: "out", from: "plugin", to: [packet.agentId], subject: packet.role, note: index === 1 ? "codex/gpt-5.1-codex" : "claude/sonnet" }], 1);
  }
  run = step(run, (current, now) => updateMember(current, "term_notify", { state: "attention" }, now), "plugin", 50);
  run = step(run, (current, now) => updateMember(current, "term_notify", { state: "working" }, now), "plugin", 40);
  run = step(run, (current, now) => finishMember(current, "term_search", "completed", "Added 5 s deadlines to 7 calls in services/search (client.ts, indexer.ts, suggest.ts). The bulk reindex call keeps its 60 s deadline: it streams for minutes by design.", now), "term_search", 140);
  run = step(run, (current, now) => finishMember(current, "term_bill", "completed", "services/billing: 4 calls had no timeout (stripe.ts ×2, invoices.ts, tax.ts); all now use httpClient with timeout 10 s. Left webhooks.ts alone: it only receives requests.", now), "term_bill", 60);
  run = step(run, (current, now) => finishMember(current, "term_notify", "completed", "services/notify: email (ses.ts) and push (apns.ts, fcm.ts) now time out after 15 s and retry once on 503. Note: shared/http had a default of 0 (no timeout); I did not change it, the other services may rely on it.", now), "term_notify", 75);
  run = step(run, (current, now) => markCollected(current, now), "lead", 20);
  run = step(run, (current, now) => summarizeBatch(current, "All three services now set timeouts on outgoing calls:\n• billing: 4 calls → 10 s (stripe, invoices, tax)\n• search: 7 calls → 5 s; the bulk reindex keeps 60 s on purpose\n• notify: email and push → 15 s with one retry on 503\n\nOpen point: shared/http still defaults to no timeout. Changing that default would cover new code too; it needs a decision since every service uses it.", now), "lead", 45);
  // A follow-up to one member, reusing its context.
  run = step(run, (current, now) => startBatch(current, now), "lead", 120);
  run = step(run, (current, now) => addBatch(current, { title: "Set a 30 s default timeout in shared/http", reason: "", warnings: [], followUp: true }, now), "lead", 2);
  run = step(run, (current, now) => {
    const added = ok(addTasks(current, [{ title: "Set a 30 s default timeout in shared/http and keep explicit timeouts as they are", detail: "In shared/http/client.ts set the default timeout to 30 s. Calls that pass their own timeout keep it. Run the whole test suite and report failures.", role: "notify" }], "lead", now));
    let next = upsertMember(added, { ...packets[2]!, task: "In shared/http/client.ts set the default timeout to 30 s. Calls that pass their own timeout keep it. Run the whole test suite and report failures." }, now);
    next = { ...next, tasks: next.tasks.map((task) => (task.id === "T4" ? { ...task, state: "doing" as const, owner: "term_notify", ownerTitle: "notify#C3B2" } : task)) };
    return attachPacket(next, "T4");
  }, "lead", 3);
  run = note(run, [{ component: "contexts", action: "continue", direction: "out", from: "plugin", to: ["term_notify"], subject: "notify", note: "" }], 1);
  return {
    run: normalizeRun(run),
    extra: {
      term_bill: { agent: "claude", model: "sonnet", live: "waiting" },
      term_search: { agent: "codex", model: "gpt-5.1-codex", live: "done" },
      term_notify: { agent: "claude", model: "sonnet", live: "working" },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------

const fixtures: Record<string, RunDetail> = {};
const team = teamRun();
fixtures[team.run.id] = detailOf(team.run, (id) => team.extra[id] ?? { agent: null, model: null, live: null });
const delegation = delegationRun();
fixtures[delegation.run.id] = detailOf(delegation.run, (id) => delegation.extra[id] ?? { agent: null, model: null, live: null });

const root = join(homedir(), ".orca-ensemble");
for (const store of existsSync(root) ? readdirSync(root) : []) {
  const dir = join(root, store, "runs");
  if (!existsSync(dir)) continue;
  let index: { members?: Record<string, { agent: string; model?: string }> } = {};
  try { index = JSON.parse(readFileSync(join(root, store, "index.json"), "utf8")); } catch {}
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const run = normalizeRun(JSON.parse(readFileSync(join(dir, file), "utf8")) as Run);
    const lives = ["working", "waiting", "done", "blocked"];
    fixtures[run.id] = detailOf(run, (id) => {
      const record = index.members?.[id];
      return { agent: record?.agent ?? null, model: record?.model ?? null, live: run.members.find((member) => member.agentId === id)?.state === "working" ? "working" : lives[(id.charCodeAt(6) ?? 0) % 3]! };
    });
  }
}

writeFileSync(new URL("./fixtures.js", import.meta.url), `// Generated by dev/make-fixtures.ts\nwindow.__FIXTURES = ${JSON.stringify(fixtures)};\n`);
console.log(Object.values(fixtures).map((run) => `${run.id} ${run.mode} ${run.status} members=${run.members.length} tasks=${run.tasks.length} posts=${run.posts.length} events=${run.events.length}`).join("\n"));
