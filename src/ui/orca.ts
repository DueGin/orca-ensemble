// The frame's link to Orca and to the plugin's worker. Orca defines a frozen `window.orca` before any plugin code runs.
import type { Api } from "../worker/api";

interface OrcaFrame {
  api: { major: number; minor: number };
  locale: string;
  host: { call<T = unknown>(method: string, params?: unknown): Promise<T>; has(method: string): boolean };
  plugin: { request<T = unknown>(name: string, input?: unknown, options?: { timeoutMs?: number }): Promise<T>; on(name: string, handler: (data: any) => void): { dispose(): void } };
  on(event: string, handler: (data: any) => void): { dispose(): void };
  shell?: { openExternal(url: string): Promise<{ opened: boolean }> };
  document?: {
    get(): Promise<{ version: number; readOnly: boolean; content: { kind: "text"; text: string } }>;
    onDidChange(handler: (doc: { version: number; readOnly: boolean; content: { kind: "text"; text: string } }) => void): { dispose(): void };
    session?<T>(options: { decode?: (content: { kind: "text"; text: string }) => T; encode?: (value: T) => { kind: "text"; text: string }; merge?: (base: T, outside: T, mine: T) => T; debounceMs?: number }): Promise<{ value: T; readOnly: boolean; change(value: T): void; flush(): Promise<void>; onReplace(handler: (value: T) => void): { dispose(): void } }>;
    applyEdit(edit: { baseVersion: number; content: { kind: "text"; text: string } }): Promise<unknown>;
  };
}

declare global {
  interface Window {
    orca: OrcaFrame;
  }
}

export const orca = (): OrcaFrame => window.orca;

type Handlers = Api;
type Input<K extends keyof Handlers> = Parameters<Handlers[K]> extends [infer I, ...unknown[]] ? I : Record<string, never>;
type Output<K extends keyof Handlers> = Awaited<ReturnType<Handlers[K]>>;

/** Calls the plugin's worker; starts it if needed. */
export function call<K extends keyof Handlers>(name: K, input?: Input<K>, timeoutMs = 60_000): Promise<Output<K>> {
  return window.orca.plugin.request<Output<K>>(`api.${String(name)}`, { ...(input ?? {}), locale: window.orca.locale }, { timeoutMs });
}

/** Runs `handler` whenever the worker reports a change (runs, sessions, presets). */
export function onChanged(handler: (runs: string[]) => void): () => void {
  const subscription = window.orca.plugin.on("changed", (data: { runs?: string[] }) => handler(data?.runs ?? []));
  return () => subscription.dispose();
}

export const isZh = () => (window.orca?.locale ?? navigator.language).toLowerCase().startsWith("zh");
