import { describe, expect, it } from "vitest";
import { callerHandle, chatHandleFromPaneKey, chatSessionId, cliModelArgs, isChatHandle, parsePiModels, resolvePiModel, surfaceOf } from "../src/shared/agents";

describe("where an agent runs", () => {
  it("is a chat when its chat works, a terminal otherwise, and an explicit choice wins", () => {
    expect(surfaceOf({ agent: "claude" })).toBe("chat");
    // A pi chat starts and stays idle on Orca 1.4.261, so pi (and opencode) default to terminals.
    expect(surfaceOf({ agent: "pi" })).toBe("terminal");
    expect(surfaceOf({ agent: "pi", surface: "chat" })).toBe("chat");
    expect(surfaceOf({ agent: "claude", surface: "terminal" })).toBe("terminal");
    expect(surfaceOf({ agent: "gemini" })).toBe("terminal");
    // Asked for explicitly, a chat is tried: Orca refuses it and the launch falls back to a terminal.
    expect(surfaceOf({ agent: "gemini", surface: "chat" })).toBe("chat");
  });

  it("knows a chat's handle, its session id and the pane key of its status events", () => {
    const handle = "structured-agent-session-claude_d8ec7293_76c8_476c_b481_e3af574a539d";
    expect(isChatHandle(handle)).toBe(true);
    expect(isChatHandle("term_8866aa11")).toBe(false);
    expect(chatSessionId(handle)).toBe("claude_d8ec7293_76c8_476c_b481_e3af574a539d");
    expect(chatHandleFromPaneKey(`${handle}:152e8e0d-d031-4716-ae75-e932cbbe5d0d`)).toBe(handle);
    expect(chatHandleFromPaneKey("term_x:leaf")).toBeNull();
    expect(chatHandleFromPaneKey(undefined)).toBeNull();
  });

  it("names the caller of agent-team from its shell", () => {
    expect(callerHandle({ ORCA_TERMINAL_HANDLE: "term_x", ORCA_AGENT_SESSION_ID: "s1" })).toBe("term_x");
    expect(callerHandle({ ORCA_AGENT_SESSION_ID: "claude_abc" })).toBe("structured-agent-session-claude_abc");
    expect(callerHandle({})).toBeNull();
  });

  it("adds pi's own model flags when Orca can't pass the model", () => {
    expect(cliModelArgs("pi", "fluxcode/deepseek-v4.1-flash", "high")).toEqual(["--model", "fluxcode/deepseek-v4.1-flash", "--thinking", "high"]);
    expect(cliModelArgs("pi", "fluxcode/deepseek-v4.1-flash", undefined)).toEqual(["--model", "fluxcode/deepseek-v4.1-flash"]);
    expect(cliModelArgs("claude", "haiku", "low")).toBeNull();
    expect(cliModelArgs("pi", undefined, "low")).toBeNull();
  });
});

describe("pi's models", () => {
  const table = [
    "provider     model                              context  max-out  thinking  images",
    "anthropic    claude-sonnet-4-5                 200K     64K      yes       yes   ",
    "fluxcode-国模  deepseek-v4.1-flash               128K     16.4K    yes       yes   ",
    "magpie       deepseek/deepseek-flash            1.0M     393.2K   yes       yes   ",
  ].join("\n");

  it("reads provider/id models from the table", () => {
    expect(parsePiModels(table)).toEqual(["anthropic/claude-sonnet-4-5", "fluxcode-国模/deepseek-v4.1-flash", "magpie/deepseek/deepseek-flash"]);
    expect(parsePiModels("")).toEqual([]);
  });

  it("completes a bare model id to the one provider that has it", () => {
    const known = parsePiModels(table);
    expect(resolvePiModel("fluxcode-国模/deepseek-v4.1-flash", known)).toEqual({ ok: true, model: "fluxcode-国模/deepseek-v4.1-flash" });
    expect(resolvePiModel("deepseek-v4.1-flash", known)).toEqual({ ok: true, model: "fluxcode-国模/deepseek-v4.1-flash" });
    expect(resolvePiModel("deepseek/deepseek-flash", known)).toEqual({ ok: true, model: "magpie/deepseek/deepseek-flash" });
    // A provider/id pi does not list is left to pi, which may reach a provider added since.
    expect(resolvePiModel("elsewhere/whatever", known)).toEqual({ ok: true, model: "elsewhere/whatever" });
    // Nothing listed to compare with: the model goes as it is.
    expect(resolvePiModel("qwen-max", [])).toEqual({ ok: true, model: "qwen-max" });
  });

  it("names the choices when a bare model is one of several or unknown", () => {
    const known = ["a/x", "b/x", "a/y"];
    expect(resolvePiModel("x", known)).toEqual({ ok: false, error: "ambiguous", matches: ["a/x", "b/x"] });
    const missing = resolvePiModel("qwen-max", known);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toBe("unknown");
  });
});
