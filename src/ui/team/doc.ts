// The editor's document: Orca's `document.session` when it has one (dirty state, saving and outside changes handled by
// Orca), else a small session of our own over `get` / `onDidChange` / `applyEdit` with the same shape.
import { orca } from "../orca";
import { decodeTeam, encodeTeam, mergeTeams, type Draft } from "./draft";

export interface DocSession {
  readonly value: Draft;
  readonly readOnly: boolean;
  change(value: Draft): void;
  flush(): Promise<void>;
  onReplace(handler: (value: Draft) => void): { dispose(): void };
}

type Content = { kind: "text"; text: string };

export async function openDocument(): Promise<DocSession> {
  const doc = orca()?.document;
  if (!doc) throw new Error("no-document");
  if ("session" in doc && typeof doc.session === "function") {
    return doc.session<Draft>({ decode: decodeTeam, encode: encodeTeam, merge: mergeTeams, debounceMs: 250 });
  }
  return fallbackSession(doc);
}

/** Without `session`: edits go out debounced, one at a time; an outside change replaces unsent edits. */
async function fallbackSession(doc: NonNullable<ReturnType<typeof orca>["document"]>): Promise<DocSession> {
  let latest = await doc.get();
  let baseVersion = latest.version;
  let value = decodeTeam(latest.content);
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  const replaced = new Set<(value: Draft) => void>();
  const emit = (next: Draft) => replaced.forEach((handler) => handler(next));

  doc.onDidChange((next) => {
    if (next.version === latest.version) return;
    latest = next;
    if (dirty || inFlight) return;
    baseVersion = next.version;
    value = decodeTeam(next.content as Content);
    emit(value);
  });

  function send(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty || latest.readOnly) return Promise.resolve();
    const sent = value;
    dirty = false;
    const attempt = doc
      .applyEdit({ baseVersion, content: encodeTeam(sent) })
      .then(() => undefined)
      .catch((error: { code?: string }) => {
        if (error?.code !== "conflict") throw error;
        // The file changed outside: it wins, as Orca's own session does without a merge.
        baseVersion = latest.version;
        value = decodeTeam(latest.content as Content);
        dirty = false;
        emit(value);
      })
      .finally(() => {
        inFlight = null;
        if (dirty) void send().catch(() => undefined);
      });
    inFlight = attempt;
    return attempt;
  }

  return {
    get value() {
      return value;
    },
    get readOnly() {
      return latest.readOnly;
    },
    change(next) {
      if (latest.readOnly) return;
      value = next;
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!inFlight) void send().catch(() => undefined);
      }, 250);
    },
    async flush() {
      if (inFlight) await inFlight;
      await send();
    },
    onReplace(handler) {
      replaced.add(handler);
      return { dispose: () => replaced.delete(handler) };
    },
  };
}
