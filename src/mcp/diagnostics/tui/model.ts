import type { AgentDiagnosticSummary, DiagnosticTimelineItem } from "../index.js";
import type { AgentsTopState, AttachViewState } from "./types.js";

export const MAX_TIMELINE_ITEMS = 2_000;

const STATE_PRIORITY: Record<AgentDiagnosticSummary["state"], number> = {
  waiting_permission: 0,
  failed: 1,
  running: 2,
  creating: 3,
  idle: 4,
  dormant: 5,
  destroying: 6,
  destroyed: 7,
};

export function visibleAgents(state: AgentsTopState): AgentDiagnosticSummary[] {
  const filter = (state.filterEditing ? state.filterDraft : state.filter)
    .trim()
    .toLocaleLowerCase();
  return state.agents
    .filter((agent) => {
      if (!filter) {
        return true;
      }
      return [
        agent.agentId,
        agent.kind,
        agent.agent,
        agent.name ?? "",
        agent.state,
        agent.cwd,
        agent.instance.instanceId,
      ].some((value) => value.toLocaleLowerCase().includes(filter));
    })
    .toSorted(compareAgents);
}

export function reconcileSelection(state: AgentsTopState, previousIndex = 0): string | undefined {
  const agents = visibleAgents(state);
  if (agents.length === 0) {
    return undefined;
  }
  if (state.selectedAgentId && agents.some((agent) => agent.agentId === state.selectedAgentId)) {
    return state.selectedAgentId;
  }
  return agents[Math.min(Math.max(previousIndex, 0), agents.length - 1)]?.agentId;
}

export function moveSelection(
  state: AgentsTopState,
  delta: number,
  absolute?: "first" | "last",
): string | undefined {
  const agents = visibleAgents(state);
  if (agents.length === 0) {
    return undefined;
  }
  if (absolute === "first") {
    return agents[0]?.agentId;
  }
  if (absolute === "last") {
    return agents.at(-1)?.agentId;
  }
  const current = Math.max(
    0,
    agents.findIndex((agent) => agent.agentId === state.selectedAgentId),
  );
  return agents[Math.min(Math.max(current + delta, 0), agents.length - 1)]?.agentId;
}

export function appendTimelineItem(
  attach: AttachViewState,
  item: DiagnosticTimelineItem,
  maxItems = MAX_TIMELINE_ITEMS,
): AttachViewState {
  const wasPaused = attach.scrollOffset > 0;
  const items = [...attach.items, item];
  const trimCount = Math.max(0, items.length - maxItems);
  const nextItems = trimCount > 0 ? items.slice(trimCount) : items;
  const maxOffset = Math.max(0, nextItems.length - 1);
  const scrollOffset = wasPaused
    ? Math.max(0, Math.min(maxOffset, attach.scrollOffset + 1 - trimCount))
    : 0;
  return {
    ...attach,
    items: nextItems,
    scrollOffset,
    unreadCount: wasPaused ? attach.unreadCount + 1 : 0,
    trimmedCount: attach.trimmedCount + trimCount,
    ...(item.kind === "terminal" ? { terminalReason: item.reason } : {}),
  };
}

export function scrollAttach(
  attach: AttachViewState,
  delta: number,
  toEnd = false,
  visibleItems = 1,
): AttachViewState {
  if (toEnd) {
    return { ...attach, scrollOffset: 0, unreadCount: 0 };
  }
  const maxOffset = Math.max(0, attach.items.length - Math.max(1, visibleItems));
  const scrollOffset = Math.min(Math.max(attach.scrollOffset + delta, 0), maxOffset);
  return {
    ...attach,
    scrollOffset,
    ...(scrollOffset === 0 ? { unreadCount: 0 } : {}),
  };
}

function compareAgents(left: AgentDiagnosticSummary, right: AgentDiagnosticSummary): number {
  return (
    STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state] ||
    left.cwd.localeCompare(right.cwd) ||
    (left.name ?? "").localeCompare(right.name ?? "") ||
    left.agentId.localeCompare(right.agentId)
  );
}
