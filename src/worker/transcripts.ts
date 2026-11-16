// What an agent last said, and what the user typed: from Claude's session transcript when there is one, else from the
// agent's terminal screen.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../shared/collab";

/** Claude's project folder for a working directory: every non-alphanumeric character becomes "-". */
function claudeProjectDirs(cwd: string): string[] {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const variants = new Set([cwd, cwd.replace(/^\/private\//, "/"), cwd.startsWith("/tmp/") ? `/private${cwd}` : cwd]);
  return [...variants].map((dir) => join(base, "projects", dir.replace(/[^A-Za-z0-9]/g, "-")));
}

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n").trim();
}

/** The user and assistant text messages of a Claude session, oldest first; null when the transcript is not found. */
export async function claudeTranscript(cwd: string, sessionId: string | null | undefined): Promise<TranscriptMessage[] | null> {
  if (!sessionId) return null;
  for (const dir of claudeProjectDirs(cwd)) {
    let raw: string;
    try {
      raw = await readFile(join(dir, `${sessionId}.jsonl`), "utf8");
    } catch {
      continue;
    }
    const messages: TranscriptMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string; isMeta?: boolean };
        if ((entry.type !== "user" && entry.type !== "assistant") || entry.isMeta) continue;
        const text = textOf(entry.message?.content);
        if (!text) continue;
        messages.push({ role: entry.type, text, at: entry.timestamp ? Date.parse(entry.timestamp) : 0 });
      } catch {
        // A partial last line while Claude writes.
      }
    }
    return messages;
  }
  return null;
}

/** Where a Claude session's turn stands: ended (its last assistant message ended the turn) and what it said last. */
export async function claudeTurn(cwd: string, sessionId: string | null | undefined): Promise<{ found: boolean; ended: boolean; endedAt: number; text: string }> {
  if (!sessionId) return { found: false, ended: false, endedAt: 0, text: "" };
  for (const dir of claudeProjectDirs(cwd)) {
    let raw: string;
    try {
      raw = await readFile(join(dir, `${sessionId}.jsonl`), "utf8");
    } catch {
      continue;
    }
    let last: { at: number; stop: string | null } | null = null;
    let text = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown; stop_reason?: string | null }; timestamp?: string; isMeta?: boolean };
        if (entry.type === "user" && !entry.isMeta && textOf(entry.message?.content)) text = "";
        if (entry.type !== "assistant") continue;
        last = { at: entry.timestamp ? Date.parse(entry.timestamp) : 0, stop: entry.message?.stop_reason ?? null };
        const said = textOf(entry.message?.content);
        if (said) text = said;
      } catch {
        // A partial last line while Claude writes.
      }
    }
    return { found: true, ended: last?.stop === "end_turn", endedAt: last?.at ?? 0, text };
  }
  return { found: false, ended: false, endedAt: 0, text: "" };
}

const CHROME = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║]*$/;

/** The text of an agent's last reply on its terminal screen: what follows the last ⏺ marker, without the TUI chrome. */
export function lastReplyFromScreen(lines: readonly string[]): string {
  const cleaned = lines.filter((line) => !CHROME.test(line));
  let start = -1;
  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    if (/^\s*[⏺●•]\s/.test(cleaned[index]!)) {
      start = index;
      // Keep going up while earlier lines belong to the same reply block.
      while (start > 0 && /^\s*[⏺●•]\s/.test(cleaned[start - 1]!)) start -= 1;
      break;
    }
  }
  const tail = start >= 0 ? cleaned.slice(start) : cleaned.slice(-40);
  const end = tail.findIndex((line, index) => index > 0 && /^\s*(❯|›|>)\s/.test(line));
  return (end > 0 ? tail.slice(0, end) : tail)
    .filter((line) => !/^\s*(✻|⏵⏵|\? for shortcuts|esc to interrupt)/.test(line))
    .map((line) => line.replace(/^\s*[⏺●•]\s?/, ""))
    .join("\n")
    .trim();
}

/** What the user typed on the screen below the line `after`: each prompt line (❯ / ›) with its wrapped continuation. */
export function typedAfter(lines: readonly string[], before: readonly string[]): ChatMessage[] {
  // The screen scrolled: find where the snapshot taken at brief time ends, by its last non-empty lines.
  const anchor = before.filter((line) => line.trim() && !CHROME.test(line)).slice(-3);
  let from = 0;
  if (anchor.length) {
    for (let index = lines.length - anchor.length; index >= 0; index -= 1) {
      if (anchor.every((line, offset) => lines[index + offset] === line)) {
        from = index + anchor.length;
        break;
      }
    }
  }
  const messages: ChatMessage[] = [];
  let current: string[] | null = null;
  for (const line of lines.slice(from)) {
    const prompt = line.match(/^\s*(?:❯|›)\s+(.*)$/);
    if (prompt) {
      if (current?.join(" ").trim()) messages.push({ role: "user", text: current.join(" "), seq: messages.length + 1 });
      current = [prompt[1]!];
    } else if (current && /^\s{2,}\S/.test(line) && !/^\s*[⏺●•✻]/.test(line)) {
      current.push(line.trim());
    } else if (current) {
      if (current.join(" ").trim()) messages.push({ role: "user", text: current.join(" "), seq: messages.length + 1 });
      current = null;
    }
  }
  if (current?.join(" ").trim()) messages.push({ role: "user", text: current.join(" "), seq: messages.length + 1 });
  return messages;
}
