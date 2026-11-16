// The plugin's worker: Orca starts it when the plugin is enabled (it has hooks and a status bar item, so it stays up).
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_MESSAGE_PREFIX } from "../shared/modes";
import { dataDir, socketPath } from "../shared/paths";
import type { ShimRequest } from "../shared/ipc";
import type { AppState } from "../shared/views";
import { OrcaAdapter, type OrcaWorker } from "./adapter";
import { createApi } from "./api";
import { handleShim, initCollaboration, noteAgentWorking, onAgentStatus, startSweep } from "./collab";
import { onAgentLaunch, onAgentPrompt, type HookDeps } from "./hooks";
import { Store } from "./store";
import { teamOfLead } from "./teams";

const pluginRoot = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return realpathSync(join(here, ".."));
  } catch {
    return join(here, "..");
  }
})();

let locale = "en";
/** Logs every agent status change to `orca plugin logs`; on while the plugin is young. */
const debugStatus = false;

export default async function activate(orca: OrcaWorker): Promise<void> {
  const adapter = new OrcaAdapter(orca);
  const store = new Store(dataDir(pluginRoot));
  await store.load();
  initCollaboration(adapter, store, (lead) => teamOfLead(orca, lead));
  const problems: string[] = [];
  if (!adapter.cliPath) problems.push("The orca CLI was not found beside Orca, so members can't be started or messaged in the background.");

  const settings = async (): Promise<AppState["settings"]> => {
    const read: Record<string, unknown> = (await orca.host.call<{ settings: Record<string, unknown> }>("settings.get", {}).catch(() => ({ settings: {} as Record<string, unknown> }))).settings;
    const language = read.language === "zh" || read.language === "en" ? read.language : "auto";
    return { language, directive: read.nativeDirective !== false, defaultTeam: typeof read.defaultTeam === "string" ? read.defaultTeam : "" };
  };

  // ----- Panels: one request handler per API method; changes are pushed so panels refresh.
  const api = createApi({ adapter, store, settings, locale: () => locale, problems: () => problems });
  for (const [name, handler] of Object.entries(api)) {
    orca.panels.handle(`api.${name}`, async (input: { locale?: string } & Record<string, unknown>) => {
      if (input && typeof input.locale === "string") locale = input.locale;
      return (handler as (input: unknown) => unknown)(input ?? {});
    });
  }
  let pending: ReturnType<typeof setTimeout> | null = null;
  const changed = new Set<string>();
  store.onChange = (runId) => {
    if (runId) changed.add(runId);
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const runs = [...changed];
      changed.clear();
      try {
        orca.panels.post("changed", { runs });
      } catch {
        // No panel open.
      }
      void updateStatusBar();
    }, 400);
  };

  // ----- Status bar: what the teams are doing.
  async function updateStatusBar(): Promise<void> {
    const active = store.activeRuns();
    const working = active.reduce((sum, run) => sum + run.members.filter((member) => member.state === "working").length, 0);
    const attention = active.some((run) => run.members.some((member) => member.state === "attention"));
    const briefs = store.leads().filter((lead) => lead.brief && !lead.endedAt).length;
    const zh = locale.toLowerCase().startsWith("zh");
    const text = active.length
      ? zh ? `团队 ${active.length} · ${working} 工作中${briefs ? ` · ${briefs} 待确认` : ""}` : `Teams ${active.length} · ${working} working${briefs ? ` · ${briefs} to confirm` : ""}`
      : briefs ? (zh ? `团队 · ${briefs} 待确认` : `Teams · ${briefs} to confirm`) : zh ? "团队" : "Teams";
    await orca.host.call("statusBar.update", { id: "teams", text, icon: "bot", tone: attention ? "warning" : briefs ? "accent" : working ? "success" : "neutral", tooltip: zh ? "智能体团队：打开面板" : "Ensemble: open the panel", visible: true }).catch(() => undefined);
  }
  void updateStatusBar();

  // ----- Agent status
  orca.events.on("agent.status.changed", (payload) => {
    if (process.env.AGENT_TEAM_DEBUG || debugStatus) {
      const role = store.lead(payload.terminalId) ? "lead" : store.member(payload.terminalId)?.title ?? "-";
      orca.log(`status ${role} ${payload.terminalId?.slice(5, 13)} ${payload.state} main=${payload.mainAgent?.state ?? "-"}/${payload.mainAgent?.outcome ?? "-"}`);
    }
    adapter.noteStatus(payload);
    void onAgentStatus(payload).catch((error) => orca.log(`status: ${String(error)}`));
  });
  orca.events.on("workspace.removed", (payload: { workspaceId: string; path: string }) => {
    void (async () => {
      for (const lead of store.leads()) if (lead.path === payload.path && !lead.endedAt) await store.patchLead(lead.terminalId, { endedAt: new Date().toISOString() });
    })();
  });

  // ----- Hooks
  const hookDeps: HookDeps = {
    orca,
    store,
    pluginRoot,
    socket: socketPath(pluginRoot),
    nodeBin: process.execPath,
    settings: async () => {
      const value = await settings();
      return { directive: value.directive, defaultTeam: value.defaultTeam, language: value.language };
    },
    locale: () => locale,
  };
  orca.hooks.on("agent.launch.before", async (event, next) => next(await onAgentLaunch(hookDeps, event).catch((error) => {
    orca.log(`launch hook: ${String(error)}`);
    return event;
  })));
  orca.hooks.on("agent.prompt.before", async (event, next) => {
    const changedPrompt = await onAgentPrompt(hookDeps, event, async (terminalId) => {
      const row = adapter.agents.get(terminalId);
      const context = await adapter.focusedWorkspace().catch(() => null);
      const workspaceId = row?.workspaceId ?? context?.workspaceId ?? null;
      const path = workspaceId?.includes("::") ? workspaceId.slice(workspaceId.indexOf("::") + 2) : null;
      return path ? { workspaceId, path } : null;
    }).catch(() => null);
    return next(changedPrompt ?? event);
  });

  // ----- Commands
  orca.commands.register("ensemble.openLatestReport", async () => {
    const run = store.allRuns().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!run) return locale.startsWith("zh") ? "还没有团队运行。" : "No team run yet.";
    const result = await api.openReport({ runId: run.id });
    return result.ok ? undefined : result.error;
  });
  orca.commands.register("ensemble.startHere", async () => {
    await orca.host.call("commands.run", { action: "sidebar.right.toggle" }).catch(() => undefined);
    return locale.startsWith("zh") ? "在右侧「智能体团队」面板里选择团队并开始。也可以在新 agent 的第一条消息开头写 @team。" : "Pick a team in the Ensemble panel on the right and start. You can also begin a new agent's first prompt with @team.";
  });

  // ----- The agents' `agent-team` command
  const server = serveShim(socketPath(pluginRoot), (request) => {
    if (request.terminalId) noteAgentWorking(request.terminalId);
    return handleShim(request);
  }, (message) => orca.log(message));
  const stopSweep = startSweep();

  // Leads whose terminal is gone end; checked now and then, not on every view.
  const liveness = setInterval(() => {
    void (async () => {
      for (const lead of store.leads().filter((entry) => !entry.endedAt)) {
        const seen = adapter.agents.get(lead.terminalId);
        if (seen && Date.now() - seen.at < 120_000) continue;
        if (!(await adapter.terminalAlive(lead.terminalId))) await store.patchLead(lead.terminalId, { endedAt: new Date().toISOString() });
      }
      await store.prune();
    })().catch(() => undefined);
  }, 120_000);
  liveness.unref?.();

  orca.log(`${PLUGIN_MESSAGE_PREFIX} ready: socket ${socketPath(pluginRoot)}, data ${dataDir(pluginRoot)}, cli ${adapter.cliPath ?? "missing"}`);
  deactivateHandlers.push(() => {
    stopSweep();
    clearInterval(liveness);
    server.close();
  });
}

const deactivateHandlers: Array<() => void> = [];

export function deactivate(): void {
  for (const handler of deactivateHandlers.splice(0)) handler();
}

/** Serves `agent-team` on a Unix socket: one JSON request line in, one JSON response out. */
function serveShim(path: string, handle: (request: ShimRequest) => Promise<{ text: string; isError: boolean }>, log: (message: string) => void): Server {
  try {
    unlinkSync(path);
  } catch {
    // No stale socket.
  }
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = "";
      let request: ShimRequest;
      try {
        request = JSON.parse(line) as ShimRequest;
      } catch {
        socket.end(JSON.stringify({ text: "Malformed request.", isError: true }) + "\n");
        return;
      }
      void handle(request).then(
        (response) => socket.end(JSON.stringify(response) + "\n"),
        (error) => socket.end(JSON.stringify({ text: String(error), isError: true }) + "\n"),
      );
    });
    socket.on("error", () => undefined);
  });
  server.on("error", (error) => log(`agent-team socket: ${String(error)}`));
  server.listen(path);
  return server;
}
