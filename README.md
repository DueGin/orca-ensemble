# Agent Team for Orca

Run a request with a team of coding agents in [Orca](https://github.com/stablyai/orca). A **lead** agent talks to you; **members** run in their own Orca terminals, each on its own agent CLI and model (Claude, Codex, Gemini, OpenCode, …). The lead works in one of two collaboration modes, or picks one per request:

| Mode | Pattern | How it goes |
| --- | --- | --- |
| **Team** | MA-08, shared board | Intake with you first (the lead restates the request and asks), then a brief and a task plan you confirm. Members share a task board (dependencies, atomic claims, the plugin hands ready tasks to idle members), post on a team board (questions, findings, answers), claim the files they edit, optionally get their plans approved, and review each other's done tasks in a review round. |
| **Delegation** | MA-04, orchestrator–workers | The lead splits the request into self-contained packets, one per role; each member works alone in its own context and reports only to the lead, who sums up. |
| **Auto** | | The lead picks team or delegation per request; the first run fixes the session to that mode. |
| **None** | | No members: the lead works alone. |

Everything the team does is recorded as a **data flow**: who wrote into which part of the mode (the brief, the task board, plan approval, the board, file claims; or the split, the sub-agent contexts, the reports and the summary) and what each part handed to whom. The plugin shows it live.

## What you get in Orca

- **Agent Team panel** (right sidebar, robot icon): the focused workspace's team session, its mode (switch it, or see it locked), the brief waiting for your **Confirm**, the members with their live state (click to show a member's terminal), and the run's data-flow diagram with a page per component.
  - **Start** tab: pick a team file of the project or a preset, write the request, choose this workspace or a **new worktree**, the mode and the language; or make an agent already running here the lead.
  - **Teams** tab: the project's team files (open one in the team editor), create a team, **plan a team with AI** (an agent reads the project, checks which agent CLIs you have and writes the team file), and the presets.
- **Team editor**: `.agents/teams/*.team.json` files open in a visual editor (Orca's Source view still shows the JSON): mode cards, language, the lead's agent/model/effort, fixed roles (folders, instructions) and the candidate pool (described by what each is good at and must not do), inline validation, undo/redo, **Save as preset**, **Start a session**.
- **Run report**: a full-width tab per run: the data-flow diagram, members, a Kanban task board, the brief, plans, a chat-like team board with read progress, file claims; for delegation the split, sub-agent contexts, reports and summary.
- **`@team` in Orca's own new agent**: start any agent in terminal mode with a first prompt such as

  ```
  @team web auto
  Add a dark mode toggle to the settings page
  ```

  and it becomes the lead of the team `web` (a team file or preset name; optional when the project has one team), in the given mode (optional). Turn it off in Settings → Plugins → Agent Team.
- **Status bar**: active runs, working members and briefs waiting for you; click to open the latest run report.
- **Chinese or English**: set per team (or follow Orca's language): the plugin's instructions to the agents, their replies, briefs and board posts, and the plugin's own UI.

## How it works

Orca plugins can't give agents new tools, so the plugin puts a command, `agent-team`, on the PATH of every agent Orca starts (an `agent.launch.before` hook). The lead runs `agent-team status`, `agent-team delegate '<json>'`, `agent-team brief`, `agent-team kickoff`, `agent-team wait`, …; members run `agent-team read`, `task`, `post`, `claim`, `report`. Each call goes over a Unix socket to the plugin's worker, which knows the caller by its Orca terminal (`ORCA_TERMINAL_HANDLE`). `agent-team help [command]` lists the commands and their JSON fields.

- Members start with `orca agent launch` (terminal surface, the role's model and effort) in the lead's checkout; the launch hook ties each launch to its terminal and gives Claude its standing instructions as an appended system prompt (other agents get them in their first message).
- Messages to idle agents are typed with `orca terminal send`, never into an agent mid-turn. Messages to a busy agent arrive in the output of its next `agent-team` command.
- Turn ends come from Orca's agent status and, for Claude, its session transcript (`stop_reason: end_turn`), so an agent's idle status while it starts up is not taken for a finished turn.
- Team mode's intake can't be skipped: `agent-team kickoff` needs your own words confirming the brief, found in the lead's transcript or on its screen after the brief was recorded, or your **Confirm** in the panel.
- State lives in `~/.orca-agent-team/<plugin>/` (sessions and runs). Team files live in the project, `.agents/teams/*.team.json`, shared through git. A run report opens on a small link file in `.agents/runs/`, which the plugin keeps out of git.

## Requirements

- **Orca 1.4.259 or later** (plugin host API 1.9). Older Orca can't load this plugin.
- Node.js on the PATH for the `agent-team` command (Orca's bundled runtime is used as a fallback).
- Agents in **terminal mode**. Orca's Chat UI sessions don't run launch hooks, so `@team` and `agent-team` work only in terminal agents; the panel always starts terminal agents.
- Local workspaces. SSH and remote Orca servers are not supported yet.

## Install

From Git: Orca → Settings → Plugins → Install from Git → `https://github.com/DueGin/orca-agent-team`, then review and enable it (it asks for workspace, agent, terminal, notification and storage access).

From a folder (development):

```sh
npm install
npm run build
orca plugin dev load .        # asks you to approve its access once
```

`dist/` is committed, so a Git install needs no build.

## Team file

```json
{
  "version": 1,
  "name": "web",
  "goal": "Ship features in the web app end to end",
  "mode": "auto",
  "language": "zh",
  "lead": { "agent": "claude", "model": "opus", "effort": "high" },
  "roles": [
    { "name": "frontend", "agent": "claude", "model": "sonnet", "folders": ["web/src"], "instructions": "Builds the React UI." },
    { "name": "backend", "agent": "codex", "model": "gpt-5.5-codex", "folders": ["api"], "instructions": "Owns the HTTP API." }
  ],
  "candidates": [
    { "name": "", "agent": "gemini", "model": "gemini-2.5-flash", "notes": "Good at: quick research, reading large files\nDo not give it: changes to the API" }
  ]
}
```

Roles own stable areas; candidates are a pool the lead assigns work to by their notes (and treats "do not give it" as a hard rule). Either may be empty, not both.

## Development

```sh
npm run typecheck && npm test   # unit tests, including a fake Orca that runs both modes end to end
npm run watch                    # rebuild dist/ on change; Orca reloads a development plugin
```

Layout: `src/worker/` (the plugin worker: hooks, the `agent-team` server, runs, the panel API), `src/cli/agent-team.ts` (the command), `src/shared/` (run model, task board, data flow, prompts in English and Chinese), `src/ui/` (panel, team editor and run report frames, React).

This is a port of [paseo-agent-team](https://github.com/DueGin/paseo-agent-team), the same plugin for Paseo.

## License

MIT
