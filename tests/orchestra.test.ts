import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrcaAdapter } from "../src/worker/adapter";
import { detectOrchestration, Orchestra, orchestrationSupported, resetOrchestrationSupport } from "../src/worker/orchestra";

describe("Orchestra.settled", () => {
  it.each([
    ["succeeded", "completed"],
    ["completed", "completed"],
    ["done", "completed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["stopped", "canceled"],
    ["canceled", "canceled"],
    ["cancelled", "canceled"],
    ["abandoned", "canceled"],
    ["killed", "canceled"],
  ] as const)("takes %s as settled, %s", (state, outcome) => {
    expect(Orchestra.settled({ state })).toEqual({ settled: true, outcome });
  });

  it.each(["ready", "running", "queued", "waiting", "unknown", ""])("takes %j as still open", (state) => {
    expect(Orchestra.settled({ state }).settled).toBe(false);
  });

  it("reads Orca's state whatever its case", () => {
    expect(Orchestra.settled({ state: "SUCCEEDED" })).toEqual({ settled: true, outcome: "completed" });
    expect(Orchestra.settled({ state: "Failed" })).toEqual({ settled: true, outcome: "failed" });
    expect(Orchestra.settled({ state: "Running" }).settled).toBe(false);
  });
});

/** An adapter that is only its CLI: each call is recorded and answered by `answer`. */
const stub = (answer: (args: string[]) => unknown) => {
  const calls: string[][] = [];
  const adapter = {
    runCli: async (args: string[]) => {
      calls.push(args);
      return answer(args);
    },
    // Help and other non-JSON probes: the same stub answers, the CLI is "there".
    rawCli: async (args: string[]) => {
      calls.push(args);
      return String(answer(args) ?? "");
    },
  } as unknown as OrcaAdapter;
  return { adapter, calls };
};

describe("Orchestra over a stub adapter", () => {
  beforeEach(() => resetOrchestrationSupport());
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrchestrationSupport();
  });

  it("keeps the follow-up dispatch Orca makes for a message, and the addressed one when it makes none", async () => {
    let followUp = true;
    const { adapter, calls } = stub((args) => (args[1] !== "send" ? {} : followUp ? { delivery: "follow_up", followUpOf: "ctx_a", dispatchId: "ctx_b", taskId: "task_b", state: "ready" } : { delivery: "mail", state: "running" }));
    expect(await detectOrchestration(adapter)).toBe(true);
    const orchestra = new Orchestra(adapter, (id) => (id === "lead1" ? "term_lead" : null));
    expect(await orchestra.send("ctx_a", "lead1", "Ensemble", "Check the header.")).toEqual({ delivery: "follow_up", dispatchId: "ctx_b", followUpOf: "ctx_a", state: "ready" });
    expect(calls.at(-1)).toEqual(["orchestration", "send", "--from", "term_lead", "--to", "dispatch:ctx_a", "--subject", "Ensemble", "--body", "Check the header."]);
    followUp = false;
    expect(await orchestra.send("ctx_a", "lead1", "Ensemble", "Again.")).toEqual({ delivery: "mail", dispatchId: "ctx_a", followUpOf: "ctx_a", state: "running" });
    // No lead to send from: nothing reaches the CLI.
    const before = calls.length;
    expect(await orchestra.send("ctx_a", "nobody", "Ensemble", "x")).toBeNull();
    expect(calls).toHaveLength(before);
  });

  it("does nothing and answers null when the CLI has no orchestration", async () => {
    const { adapter, calls } = stub(() => {
      throw new Error("error: unknown command 'orchestration'");
    });
    expect(await detectOrchestration(adapter)).toBe(false);
    expect(orchestrationSupported(adapter)).toBe(false);
    const orchestra = new Orchestra(adapter, () => "term_lead");
    expect(orchestra.enabled()).toBe(false);
    expect(orchestra.holds({ dispatchId: "ctx_a" })).toBe(false);
    expect(await orchestra.runFor("run_1", "lead1", "objective")).toBeNull();
    expect(await orchestra.startWorker({ runId: "run_o", leadId: "lead1", handle: "term_m", title: "writer#1", spec: "x", workspacePath: "/repo" })).toBeNull();
    expect(await orchestra.show("ctx_a")).toBeNull();
    expect(await orchestra.send("ctx_a", "lead1", "s", "b")).toBeNull();
    expect(await orchestra.stop("ctx_a")).toMatchObject({ ok: false });
    // Only the support probe asked the CLI.
    expect(calls).toEqual([["orchestration", "worker-start", "--help"]]);
  });

  it("stops letting a dispatch tell the member's turn once the plugin sent the member work itself", async () => {
    const { adapter } = stub(() => ({}));
    expect(await detectOrchestration(adapter)).toBe(true);
    const orchestra = new Orchestra(adapter, () => "term_lead");
    expect(orchestra.governs({ dispatchId: "ctx_typed" })).toBe(true);
    Orchestra.sent("ctx_typed");
    // The plugin still holds the dispatch (to stop it at close), but its state speaks of an earlier turn.
    expect(orchestra.holds({ dispatchId: "ctx_typed" })).toBe(true);
    expect(orchestra.governs({ dispatchId: "ctx_typed" })).toBe(false);
    // A new dispatch (the follow-up Orca makes) governs again.
    expect(orchestra.governs({ dispatchId: "ctx_next" })).toBe(true);
  });
});
