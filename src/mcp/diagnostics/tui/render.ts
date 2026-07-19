import path from "node:path";
import type { AgentDiagnosticSummary, DiagnosticConversationItem } from "../index.js";
import { visibleAgents } from "./model.js";
import { sanitizeTerminalText } from "./sanitize.js";
import type { AgentsTopState, TextMetrics, TopFrame, TopSegment, TopStyle } from "./types.js";

const MIN_WIDTH = 72;
const MIN_HEIGHT = 12;

export function renderTop(
  state: AgentsTopState,
  width: number,
  height: number,
  metrics: TextMetrics,
): TopFrame {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return renderSmallTerminal(width, height, metrics);
  }
  return state.mode === "attach" && state.attach
    ? renderAttach(state, width, height, metrics)
    : renderList(state, width, height, metrics);
}

function renderList(
  state: AgentsTopState,
  width: number,
  height: number,
  metrics: TextMetrics,
): TopFrame {
  const lines = emptyLines(height);
  const rowAgentIds = new Map<number, string>();
  const agents = visibleAgents(state);
  const managed = state.agents.filter((agent) => agent.kind === "managed");
  const counts = {
    managed: managed.length,
    running: managed.filter((agent) => agent.state === "running").length,
    idle: managed.filter((agent) => agent.state === "idle").length,
    waiting: managed.filter((agent) => agent.state === "waiting_permission").length,
    queued: managed.reduce((sum, agent) => sum + agent.queueDepth, 0),
  };
  lines[0] = [segment(fit("cs-agent-mcp agents top", width, metrics), "header")];
  lines[1] = [
    segment(
      fit(
        `managed ${counts.managed} | running ${counts.running} | idle ${counts.idle} | waiting ${counts.waiting} | queued ${counts.queued}${
          state.loading ? " | refreshing" : ""
        }`,
        width,
        metrics,
      ),
      "accent",
    ),
  ];

  const columns = listColumns(width);
  lines[2] = [segment(renderAgentColumns(columns, undefined, false, metrics), "muted")];
  const bodyStart = 4;
  const bodyRows = height - bodyStart - 2;
  const selectedIndex = Math.max(
    0,
    agents.findIndex((agent) => agent.agentId === state.selectedAgentId),
  );
  const firstIndex = Math.min(
    Math.max(0, selectedIndex - Math.floor(bodyRows / 2)),
    Math.max(0, agents.length - bodyRows),
  );

  if (agents.length === 0) {
    lines[bodyStart - 1] = [
      segment(
        fit(state.filter ? `No agents match "${state.filter}"` : "No agents found", width, metrics),
        "muted",
      ),
    ];
  } else {
    for (let row = 0; row < bodyRows; row += 1) {
      const agent = agents[firstIndex + row];
      if (!agent) {
        break;
      }
      const y = bodyStart + row;
      rowAgentIds.set(y, agent.agentId);
      lines[y - 1] = [
        segment(
          renderAgentColumns(columns, agent, state.staleAgentIds.has(agent.agentId), metrics),
          agent.agentId === state.selectedAgentId
            ? "selected"
            : stateStyle(agent, state.staleAgentIds.has(agent.agentId)),
        ),
      ];
    }
  }

  lines[height - 2] = [segment(fit(statusText(state), width, metrics), statusStyle(state))];
  lines[height - 1] = [
    segment(
      fit(
        state.filterEditing
          ? `filter> ${state.filterDraft}_  Enter apply  Esc cancel`
          : "up/down j/k PgUp/PgDn mouse select | Enter attach | / filter | a all | r refresh | q quit",
        width,
        metrics,
      ),
      "header",
    ),
  ];
  return { lines, rowAgentIds };
}

// oxlint-disable-next-line complexity -- fixed terminal regions stay together to prevent overlap
function renderAttach(
  state: AgentsTopState,
  width: number,
  height: number,
  metrics: TextMetrics,
): TopFrame {
  const attach = state.attach;
  if (!attach) {
    return { lines: emptyLines(height), rowAgentIds: new Map() };
  }
  const lines = emptyLines(height);
  const label = attach.agent.name ?? attach.agent.agentId.slice(0, 8);
  lines[0] = [
    segment(
      fit(`${label} | ${attach.agent.agent} | ${attach.agent.state}`, width, metrics),
      "header",
    ),
  ];
  lines[1] = [
    segment(
      fit(
        attach.scrollOffset === 0
          ? `LIVE${attach.terminalReason ? ` | terminal ${attach.terminalReason}` : ""}`
          : `PAUSED | ${attach.unreadCount} new | End resumes live`,
        width,
        metrics,
      ),
      attach.scrollOffset === 0 ? "accent" : "warning",
    ),
  ];

  const bodyStart = 3;
  const bodyRows = height - bodyStart - 2;
  const renderedItems = attachLines(attach.items, width, metrics);
  const maxOffset = Math.max(0, renderedItems.length - bodyRows);
  const effectiveOffset = Math.min(attach.scrollOffset, maxOffset);
  const endExclusive = Math.max(0, renderedItems.length - effectiveOffset);
  const start = Math.max(0, endExclusive - bodyRows);
  const visible = renderedItems.slice(start, endExclusive);
  for (let index = 0; index < visible.length; index += 1) {
    const line = visible[index];
    if (!line) {
      continue;
    }
    lines[bodyStart - 1 + index] = [segment(fit(line.text, width, metrics), line.style)];
  }
  if (visible.length === 0) {
    lines[bodyStart - 1] = [segment("Waiting for conversation...", "muted")];
  }

  const trimText = attach.trimmedCount > 0 ? ` | trimmed ${attach.trimmedCount}` : "";
  lines[height - 2] = [
    segment(fit(`${state.message ?? ""}${trimText}`, width, metrics), statusStyle(state)),
  ];
  lines[height - 1] = [
    segment(
      fit("up/down j/k PgUp/PgDn mouse scroll | End live | Esc back | q quit", width, metrics),
      "header",
    ),
  ];
  return { lines, rowAgentIds: new Map() };
}

type AttachItem = DiagnosticConversationItem;
type AttachLine = { text: string; style: TopStyle };

export function countAttachLines(items: AttachItem[], width: number, metrics: TextMetrics): number {
  return attachLines(items, width, metrics).length;
}

function attachLines(items: AttachItem[], width: number, metrics: TextMetrics): AttachLine[] {
  return items.flatMap((item) => {
    const conversation = conversationText(item);
    return wrapConversationText(conversation.prefix, conversation.text, width, metrics).map(
      (text) => ({ text, style: timelineStyle(item) }),
    );
  });
}

function conversationText(item: AttachItem): { prefix: string; text: string } {
  if (item.kind === "user") {
    return { prefix: "YOU    ", text: item.text };
  }
  if (item.kind === "assistant") {
    return { prefix: "AGENT  ", text: item.text };
  }
  if (item.kind === "resume") {
    return { prefix: "SESSION  ", text: "resumed" };
  }
  if (item.kind === "thinking") {
    return {
      prefix: "THINKING  ",
      text: item.redacted ? "[redacted_thinking]" : item.text,
    };
  }
  if (item.kind === "tool_call") {
    return { prefix: `TOOL   ${item.name}  `, text: item.input };
  }
  return { prefix: `${item.isError ? "ERROR" : "RESULT"} ${item.name}  `, text: item.text };
}

function wrapConversationText(
  prefix: string,
  text: string,
  width: number,
  metrics: TextMetrics,
): string[] {
  const rawPrefix = sanitizeTerminalText(prefix);
  const prefixBudget = Math.max(1, Math.floor(width * 0.4));
  const safePrefix =
    metrics.measure(rawPrefix) > prefixBudget
      ? `${metrics.truncate(rawPrefix, Math.max(1, prefixBudget - 1))} `
      : rawPrefix;
  const prefixWidth = metrics.measure(safePrefix);
  const continuation = " ".repeat(prefixWidth);
  const contentWidth = Math.max(1, width - prefixWidth);
  const paragraphs = text.split(/\r\n|\r|\n/u);
  const lines: string[] = [];
  let first = true;
  for (const paragraph of paragraphs) {
    const wrapped = wrapVisibleText(sanitizeTerminalText(paragraph), contentWidth, metrics);
    for (const line of wrapped) {
      lines.push(`${first ? safePrefix : continuation}${line}`);
      first = false;
    }
  }
  return lines.length > 0 ? lines : [safePrefix];
}

function wrapVisibleText(text: string, width: number, metrics: TextMetrics): string[] {
  if (!text) {
    return [""];
  }
  const lines: string[] = [];
  let remaining = text;
  while (metrics.measure(remaining) > width) {
    let candidate = metrics.truncate(remaining, width);
    if (!candidate) {
      candidate = Array.from(remaining)[0] ?? "";
    }
    const whitespace = candidate.search(/\s+\S*$/u);
    const line = whitespace > 0 ? candidate.slice(0, whitespace) : candidate;
    lines.push(line.trimEnd());
    remaining = remaining.slice(line.length).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function renderSmallTerminal(width: number, height: number, metrics: TextMetrics): TopFrame {
  const lines = emptyLines(Math.max(1, height));
  lines[0] = [segment(fit("cs-agent-mcp agents top", width, metrics), "header")];
  if (height > 1) {
    lines[1] = [
      segment(
        fit(`Terminal too small; need ${MIN_WIDTH}x${MIN_HEIGHT}`, width, metrics),
        "warning",
      ),
    ];
  }
  if (height > 2) {
    lines[Math.max(2, height - 1)] = [segment(fit("q quit", width, metrics), "header")];
  }
  return { lines, rowAgentIds: new Map() };
}

type ListColumns = {
  id: number;
  kind: number;
  runtime: number;
  state: number;
  queue: number;
  name: number;
  workspace: number;
};

function listColumns(width: number): ListColumns {
  const fixed = { id: 8, kind: 7, runtime: 10, state: 19, queue: 3, name: 12 };
  const separators = 6;
  return {
    ...fixed,
    workspace: Math.max(1, width - Object.values(fixed).reduce(sum, 0) - separators),
  };
}

function renderAgentColumns(
  columns: ListColumns,
  agent: AgentDiagnosticSummary | undefined,
  stale: boolean,
  metrics: TextMetrics,
): string {
  const values = agent
    ? [
        agent.agentId.slice(0, 8),
        agent.kind,
        agent.agent,
        `${agent.state}${stale ? "*" : ""}`,
        String(agent.queueDepth),
        agent.name ?? "-",
        path.basename(agent.cwd) || agent.cwd,
      ]
    : ["AGENT", "KIND", "RUNTIME", "STATE", "Q", "NAME", "WORKSPACE"];
  return [
    columns.id,
    columns.kind,
    columns.runtime,
    columns.state,
    columns.queue,
    columns.name,
    columns.workspace,
  ]
    .map((columnWidth, index) => cell(values[index] ?? "", columnWidth, metrics))
    .join(" ");
}

function timelineStyle(item: DiagnosticConversationItem): TopStyle {
  if (item.kind === "user") {
    return "accent";
  }
  if (item.kind === "assistant") {
    return "normal";
  }
  if (item.kind === "resume") {
    return "muted";
  }
  if (item.kind === "thinking") {
    return "muted";
  }
  if (item.kind === "tool_call") {
    return "accent";
  }
  return item.isError ? "error" : "normal";
}

function stateStyle(agent: AgentDiagnosticSummary, stale: boolean): TopStyle {
  if (stale) {
    return "warning";
  }
  if (agent.state === "failed" || agent.instance.state === "unknown") {
    return "error";
  }
  if (agent.state === "waiting_permission" || agent.instance.state === "stopped") {
    return "warning";
  }
  return agent.kind === "root" || agent.state === "dormant" ? "muted" : "normal";
}

function statusText(state: AgentsTopState): string {
  if (state.message) {
    return state.message;
  }
  if (state.warnings.length > 0) {
    return `warning: ${state.warnings[0]?.message ?? "snapshot unreadable"}`;
  }
  if (state.lastRefreshAt) {
    return `updated ${new Date(state.lastRefreshAt).toLocaleTimeString()}`;
  }
  return state.loading ? "loading..." : "";
}

function statusStyle(state: AgentsTopState): TopStyle {
  if (state.messageKind === "error") {
    return "error";
  }
  if (state.messageKind === "warning" || state.warnings.length > 0) {
    return "warning";
  }
  return "muted";
}

function fit(text: string, width: number, metrics: TextMetrics): string {
  return metrics.truncate(sanitizeTerminalText(text), Math.max(0, width));
}

function cell(text: string, width: number, metrics: TextMetrics): string {
  const truncated = metrics.truncate(sanitizeTerminalText(text), width);
  return `${truncated}${" ".repeat(Math.max(0, width - metrics.measure(truncated)))}`;
}

function segment(text: string, style: TopStyle = "normal"): TopSegment {
  return { text, style };
}

function emptyLines(height: number): TopSegment[][] {
  return Array.from({ length: height }, () => []);
}

function sum(total: number, value: number): number {
  return total + value;
}
