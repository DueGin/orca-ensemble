import { describe, expect, it } from "vitest";
import { clientMark, modelMark, modelVendor } from "../src/shared/agent-marks";
import { BRAND_SVGS, CLIENT_MARKS, MODEL_MARKS } from "../src/shared/brand-icons";

describe("the bundled marks", () => {
  it.each(Object.keys(BRAND_SVGS))("%s is a self-contained SVG", (name) => {
    const svg = BRAND_SVGS[name]!;
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox");
    expect(svg).not.toMatch(/<script|<style|<foreignObject|\son[a-z]+\s*=|javascript:/i);
    for (const match of svg.matchAll(/\s(?:href|xlink:href)\s*=\s*"([^"]*)"/gi)) expect(match[1]!.startsWith("#")).toBe(true);
    expect(BRAND_SVGS[name]).not.toMatch(/https?:|<title/);
  });

  it("cover every client and vendor they name", () => {
    for (const name of [...Object.values(CLIENT_MARKS), ...Object.values(MODEL_MARKS)]) expect(BRAND_SVGS[name]).toBeDefined();
  });
});

describe("an agent's client mark", () => {
  it("covers the agents Orca runs, and gives the others their initial", () => {
    for (const agent of ["claude", "codex", "gemini", "opencode", "pi", "copilot", "cursor", "kimi", "qwen-code", "kiro", "codebuddy", "grok"]) expect(clientMark(agent).kind).toBe("svg");
    expect(clientMark("droid")).toEqual({ kind: "letter", letter: "D" });
    expect(clientMark("hermes")).toEqual({ kind: "letter", letter: "H" });
  });

  it("is the client's own mark, so Claude Code differs from the Claude model", () => {
    expect(clientMark("claude", "<svg>snapshot</svg>")).toEqual({ kind: "svg", svg: BRAND_SVGS["claudecode-color"] });
    expect(clientMark("codex")).toEqual({ kind: "svg", svg: BRAND_SVGS["codex-color"] });
    expect(clientMark("opencode")).toEqual({ kind: "svg", svg: BRAND_SVGS.opencode });
  });

  it("falls back to the provider snapshot's icon, then the initial", () => {
    expect(clientMark("antigravity", "<svg>snapshot</svg>")).toEqual({ kind: "svg", svg: "<svg>snapshot</svg>" });
    expect(clientMark("antigravity")).toEqual({ kind: "letter", letter: "A" });
    expect(clientMark("omp", "")).toEqual({ kind: "letter", letter: "O" });
  });
});

describe("a model's vendor", () => {
  it.each([
    ["claude-opus-5-5", "anthropic"],
    ["sonnet", "anthropic"],
    ["claude-fable-5-1", "anthropic"],
    ["gpt-5.5-codex", "openai"],
    ["o4-mini", "openai"],
    ["group/auto-gpt-sol", "openai"],
    ["gemini-2.5-pro", "gemini"],
    ["gemma-3-27b", "gemma"],
    ["deepseek/deepseek-v4-flash", "deepseek"],
    ["openrouter/qwen/qwen3-coder", "qwen"],
    ["kimi-k2", "kimi"],
    ["glm-5", "zhipu"],
    ["MiniMax-M2", "minimax"],
    ["x-ai/grok-4", "xai"],
    ["devstral-medium", "mistral"],
    ["llama-4-maverick", "meta"],
    ["doubao-seed-1.6", "doubao"],
  ])("of %s is %s", (model, vendor) => {
    expect(modelVendor(model)).toBe(vendor);
  });

  it("comes from the client when the model id names none", () => {
    expect(modelVendor("default", "claude")).toBe("anthropic");
    expect(modelVendor("", "codex")).toBe("openai");
    expect(modelVendor("default", "opencode")).toBeNull();
  });

  it("gives the model's initial when unknown, and nothing without a model", () => {
    expect(modelMark("anthropic/claude-haiku-5-5")).toEqual({ kind: "svg", svg: BRAND_SVGS["claude-color"] });
    expect(modelMark("custom/zeta-7b")).toEqual({ kind: "letter", letter: "Z" });
    expect(modelMark(null)).toBeNull();
    expect(modelMark("", "pi")).toBeNull();
  });
});
