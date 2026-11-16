// The planner: an agent that reads the project and writes a team file, which the team editor then opens.
import { MODE_SPECS, type PromptLanguage } from "./modes";
import { KNOWN_AGENTS } from "./team";

const EXAMPLE = {
  version: 1,
  name: "<short team name>",
  goal: "<the goal>",
  mode: "auto",
  lead: { agent: "claude", model: "<optional model id>" },
  roles: [{ name: "<lowercase role>", agent: "<agent cli>", model: "<optional model id>", folders: ["<relative/path>"], instructions: "<what this role does>" }],
  candidates: [{ name: "<short handle, may be empty>", agent: "<agent cli>", model: "<optional model id>", notes: "Good at / suited for: …\nCost or speed: …\nDo not give it: …" }],
};

const EXAMPLE_ZH = {
  ...EXAMPLE,
  name: "<简短团队名>",
  goal: "<团队目标>",
  roles: [{ name: "<角色名，小写英文>", agent: "<agent cli>", model: "<可选的模型 id>", folders: ["<相对路径>"], instructions: "<这个角色做什么>" }],
  candidates: [{ name: "<简短标识，可留空>", agent: "<agent cli>", model: "<可选的模型 id>", notes: "擅长 / 适合：…\n成本或速度：…\n不要交给它：…" }],
};

export function plannerPrompt(goal: string, file: string, language: PromptLanguage): string {
  const given = goal.trim();
  const agents = KNOWN_AGENTS.join(" ");
  if (language === "zh") {
    return [
      "[ensemble] 请为这个项目设计一个智能体团队，并把它写成团队文件。团队由一个协调器带领，成员在协调器的工作区里各自运行在自己的 agent CLI 和模型上。",
      given ? `目标：${given}` : "没有给出目标：请先阅读项目（README、目录结构、主要源码），弄清它是什么、需要哪些工作，再写出目标。",
      "",
      "## 步骤",
      `1. 用 shell 查看本机装了哪些 agent CLI：\`for a in ${agents}; do command -v $a >/dev/null && echo $a; done\`。只能用装了的。`,
      `2. 把团队写成 JSON 文件：${file}（相对当前目录；没有目录就创建）。格式与下面完全一致，键名保持英文：`,
      "```json",
      JSON.stringify(EXAMPLE_ZH, null, 2),
      "```",
      `3. 运行 \`agent-team check-team ${file}\` 检查；有错误就改到通过为止。`,
      "4. 最后用一两句话说明团队的组成和模式，然后结束。不要改动项目里的其他文件。",
      "",
      "## 规则",
      `- mode："delegation"（委派，${MODE_SPECS.delegation.pattern}：拆分需求，成员各自独立完成）适合能拆成职责清晰、互不依赖的工作；"team"（团队，${MODE_SPECS.team.pattern}：先与用户确认需求简报，成员共用任务板并互相评审）适合相互依赖、需要统一约定或需求尚不清楚的工作；"auto" 由协调器按需求选择；"none" 不启动成员。除非目标明显需要某一种，否则用 "auto"。`,
      "- 固定角色负责项目中稳定的区域（文件夹），2 到 6 个，职责不重叠；候选成员是模型池，协调器按描述分工，2 到 4 个，能力有差异。两者都可以有，但不能都为空。",
      "- model 可以留空（用该 CLI 的默认模型）；要写就写该 CLI 认得的模型 id，例如 claude 的 opus / sonnet / haiku。",
      "- 文字内容（goal、instructions、notes）用简体中文；name、角色名用小写英文。",
    ].join("\n");
  }
  return [
    "[ensemble] Design an agent team for this project and write it as a team file. A lead runs the team; each member runs in the lead's workspace on its own agent CLI and model.",
    given ? `Goal: ${given}` : "No goal was given: first read the project (README, layout, main sources) to work out what it is and what work it needs, then write the goal yourself.",
    "",
    "## Steps",
    `1. Check which agent CLIs are installed: \`for a in ${agents}; do command -v $a >/dev/null && echo $a; done\`. Use only installed ones.`,
    `2. Write the team as JSON to ${file} (relative to the current directory; create the folder if needed), in exactly this shape:`,
    "```json",
    JSON.stringify(EXAMPLE, null, 2),
    "```",
    `3. Run \`agent-team check-team ${file}\` and fix the file until it passes.`,
    "4. End with one or two sentences on the team and its mode. Change no other file of the project.",
    "",
    "## Rules",
    `- mode: "delegation" (${MODE_SPECS.delegation.pattern}: the lead splits each request and members work alone) when ${MODE_SPECS.delegation.fit}; "team" (${MODE_SPECS.team.pattern}: intake with the user, then a shared task board and review) when ${MODE_SPECS.team.fit}; "auto" to let the lead pick per request; "none" for no members. Prefer "auto" unless the goal clearly calls for one.`,
    "- Fixed roles own stable areas of the project (folders): 2 to 6, with separate work. Candidates are a pool of models the lead assigns work to by their notes: 2 to 4 that differ in strengths. Use either or both, never neither.",
    "- model may be empty (the CLI's default); otherwise use a model id that CLI accepts, such as opus / sonnet / haiku for claude.",
  ].join("\n");
}
