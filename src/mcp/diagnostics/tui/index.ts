import type { AgentDiagnostics, AgentDiagnosticSummary } from "../index.js";
import { moveSelection, reconcileSelection, scrollAttach, visibleAgents } from "./model.js";
import { countAttachLines, renderTop } from "./render.js";
import type {
  AgentsTopState,
  AttachViewState,
  TerminalEvent,
  TopFrame,
  TopTerminal,
} from "./types.js";

const DEFAULT_REFRESH_MS = 1_000;
const DEFAULT_HISTORY = 100;

export type AgentsTopOptions = {
  diagnostics: AgentDiagnostics;
  includeAll?: boolean;
  signal?: AbortSignal;
  signalExitCode?: () => number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  errorOutput?: NodeJS.WriteStream;
  refreshMs?: number;
  history?: number;
  terminal?: TopTerminal;
};

// oxlint-disable-next-line complexity -- coordinates TTY setup, injected adapters, and fatal cleanup
export async function runAgentsTop(options: AgentsTopOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  if (!options.terminal && (!input.isTTY || !output.isTTY)) {
    errorOutput.write(
      "[cs-agent-mcp] agents top requires an interactive TTY; use agents list or agents attach for redirected output\n",
    );
    return 1;
  }

  const terminal =
    options.terminal ??
    new (await import("./terminal-kit-adapter.js")).TerminalKitAdapter(input, output, errorOutput);
  const controller = new AgentsTopController({ ...options, terminal });
  try {
    return await controller.run();
  } catch (cause) {
    errorOutput.write(
      `[cs-agent-mcp] agents top failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return 1;
  }
}

class AgentsTopController {
  private readonly diagnostics: AgentDiagnostics;
  private readonly terminal: TopTerminal;
  private readonly signal?: AbortSignal;
  private readonly refreshMs: number;
  private readonly history: number;
  private readonly signalExitCode: () => number;
  private readonly state: AgentsTopState;
  private refreshTimer?: NodeJS.Timeout;
  private refreshing = false;
  private refreshQueued = false;
  private attachAbort?: AbortController;
  private attachPump?: Promise<void>;
  private attachGeneration = 0;
  private conversationRefreshPump?: Promise<void>;
  private conversationRefreshQueued = false;
  private conversationRefreshGeneration = 0;
  private listEpoch = 0;
  private lastFrame: TopFrame = { lines: [], rowAgentIds: new Map() };
  private done = false;
  private resolveDone?: (code: number) => void;

  constructor(options: AgentsTopOptions & { terminal: TopTerminal }) {
    this.diagnostics = options.diagnostics;
    this.terminal = options.terminal;
    this.signal = options.signal;
    this.refreshMs = Math.max(10, options.refreshMs ?? DEFAULT_REFRESH_MS);
    this.history = Math.max(0, options.history ?? DEFAULT_HISTORY);
    this.signalExitCode = options.signalExitCode ?? (() => 0);
    this.state = {
      mode: "list",
      agents: [],
      staleAgentIds: new Set(),
      warnings: [],
      includeAll: Boolean(options.includeAll),
      filter: "",
      filterDraft: "",
      filterEditing: false,
      loading: true,
    };
  }

  async run(): Promise<number> {
    const done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    const onAbort = () => this.finish(this.signalExitCode());
    this.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.terminal.start();
      this.terminal.setEventHandler((event) => {
        void this.handleTerminalEvent(event);
      });
      this.render();
      void this.requestRefresh();
      this.refreshTimer = setInterval(() => {
        if (this.state.mode === "attach") {
          void this.refreshAttachConversation(this.attachGeneration);
        } else {
          void this.requestRefresh();
        }
      }, this.refreshMs);
      if (this.signal?.aborted) {
        this.finish(this.signalExitCode());
      }
      return await done;
    } finally {
      this.signal?.removeEventListener("abort", onAbort);
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
      }
      this.listEpoch += 1;
      this.attachGeneration += 1;
      this.conversationRefreshQueued = false;
      this.attachAbort?.abort();
      this.terminal.setEventHandler(undefined);
      await this.terminal.stop();
      await this.attachPump;
    }
  }

  private async handleTerminalEvent(event: TerminalEvent): Promise<void> {
    if (this.done) {
      return;
    }
    if (event.type === "resize") {
      this.render();
      return;
    }
    if (event.type === "mouse") {
      this.handleMouse(event);
      return;
    }
    await this.handleKey(event.name, event.text);
  }

  // oxlint-disable-next-line complexity -- explicit list-mode key dispatch is easier to audit as one table
  private async handleKey(name: string, text?: string): Promise<void> {
    if (name === "CTRL_C") {
      this.finish(0);
      return;
    }
    if (this.state.mode === "attach") {
      await this.handleAttachKey(name);
      return;
    }
    if (this.state.filterEditing) {
      this.handleFilterKey(name, text);
      return;
    }
    if (name === "q") {
      this.finish(0);
      return;
    }

    const page = Math.max(1, this.terminal.height - 6);
    switch (name) {
      case "UP":
      case "k":
        this.state.selectedAgentId = moveSelection(this.state, -1);
        break;
      case "DOWN":
      case "j":
        this.state.selectedAgentId = moveSelection(this.state, 1);
        break;
      case "PAGE_UP":
        this.state.selectedAgentId = moveSelection(this.state, -page);
        break;
      case "PAGE_DOWN":
        this.state.selectedAgentId = moveSelection(this.state, page);
        break;
      case "HOME":
        this.state.selectedAgentId = moveSelection(this.state, 0, "first");
        break;
      case "END":
        this.state.selectedAgentId = moveSelection(this.state, 0, "last");
        break;
      case "ENTER":
        this.openSelectedAgent();
        return;
      case "a":
        this.state.includeAll = !this.state.includeAll;
        this.listEpoch += 1;
        this.state.message = this.state.includeAll ? "showing all agents" : "showing active agents";
        this.state.messageKind = "normal";
        void this.requestRefresh();
        break;
      case "/":
        this.state.filterEditing = true;
        this.state.filterDraft = this.state.filter;
        this.state.message = undefined;
        break;
      case "r":
        void this.requestRefresh();
        break;
      default:
        return;
    }
    this.render();
  }

  // oxlint-disable-next-line complexity -- explicit Attach-mode key dispatch mirrors the visible controls
  private async handleAttachKey(name: string): Promise<void> {
    const attach = this.state.attach;
    if (!attach) {
      return;
    }
    const page = Math.max(1, this.terminal.height - 5);
    const contentLength = countAttachLines(attach.items, this.terminal.width, this.terminal);
    switch (name) {
      case "q":
        this.finish(0);
        return;
      case "ESCAPE":
        await this.returnToList();
        return;
      case "UP":
      case "k":
        this.state.attach = scrollAttach(attach, 1, false, page, contentLength);
        break;
      case "DOWN":
      case "j":
        this.state.attach = scrollAttach(attach, -1, false, page, contentLength);
        break;
      case "PAGE_UP":
        this.state.attach = scrollAttach(attach, page, false, page, contentLength);
        break;
      case "PAGE_DOWN":
        this.state.attach = scrollAttach(attach, -page, false, page, contentLength);
        break;
      case "HOME":
        this.state.attach = scrollAttach(attach, contentLength, false, page, contentLength);
        break;
      case "END":
        this.state.attach = scrollAttach(attach, 0, true, page, contentLength);
        break;
      default:
        return;
    }
    this.render();
  }

  private handleFilterKey(name: string, text?: string): void {
    if (name === "ESCAPE") {
      this.state.filterEditing = false;
      this.state.filterDraft = this.state.filter;
      this.render();
      return;
    }
    if (name === "ENTER") {
      this.state.filterEditing = false;
      this.state.filter = this.state.filterDraft;
      this.state.selectedAgentId = reconcileSelection(this.state);
      this.render();
      return;
    }
    if (name === "BACKSPACE") {
      this.state.filterDraft = Array.from(this.state.filterDraft).slice(0, -1).join("");
    } else if (name === "CTRL_U") {
      this.state.filterDraft = "";
    } else if (text && !/^\p{C}$/u.test(text)) {
      this.state.filterDraft += text;
    } else {
      return;
    }
    this.state.selectedAgentId = reconcileSelection(this.state);
    this.render();
  }

  // oxlint-disable-next-line complexity -- mouse protocol dispatch is intentionally centralized
  private handleMouse(event: Extract<TerminalEvent, { type: "mouse" }>): void {
    if (this.state.mode === "attach" && this.state.attach) {
      const visibleItems = Math.max(1, this.terminal.height - 5);
      const contentLength = countAttachLines(
        this.state.attach.items,
        this.terminal.width,
        this.terminal,
      );
      if (event.name === "MOUSE_WHEEL_UP") {
        this.state.attach = scrollAttach(this.state.attach, 3, false, visibleItems, contentLength);
      } else if (event.name === "MOUSE_WHEEL_DOWN") {
        this.state.attach = scrollAttach(this.state.attach, -3, false, visibleItems, contentLength);
      } else {
        return;
      }
      this.render();
      return;
    }
    if (event.name === "MOUSE_LEFT_BUTTON_PRESSED") {
      const agentId = this.lastFrame.rowAgentIds.get(event.y);
      if (agentId) {
        this.state.selectedAgentId = agentId;
        this.render();
      }
      return;
    }
    if (event.name === "MOUSE_WHEEL_UP") {
      this.state.selectedAgentId = moveSelection(this.state, -3);
      this.render();
    } else if (event.name === "MOUSE_WHEEL_DOWN") {
      this.state.selectedAgentId = moveSelection(this.state, 3);
      this.render();
    }
  }

  private openSelectedAgent(): void {
    const agent = visibleAgents(this.state).find(
      (candidate) => candidate.agentId === this.state.selectedAgentId,
    );
    if (!agent) {
      return;
    }
    if (agent.kind === "root") {
      this.state.message =
        "root agents are MCP caller identities; select a managed agent to follow runtime output";
      this.state.messageKind = "warning";
      this.render();
      return;
    }
    this.state.mode = "attach";
    this.state.message = undefined;
    this.state.messageKind = undefined;
    this.state.attach = {
      agent,
      items: [],
      conversationState: "loading",
      scrollOffset: 0,
      unreadCount: 0,
      trimmedCount: 0,
    };
    this.render();
    this.startAttach(agent);
    void this.refreshAttachConversation(this.attachGeneration);
  }

  private startAttach(agent: AgentDiagnosticSummary): void {
    this.attachGeneration += 1;
    const generation = this.attachGeneration;
    this.attachAbort?.abort();
    const abort = new AbortController();
    this.attachAbort = abort;
    this.attachPump = this.consumeAttach(agent, generation, abort.signal);
  }

  // oxlint-disable-next-line complexity -- owns the generator lifecycle and all generation checks
  private async consumeAttach(
    agent: AgentDiagnosticSummary,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const stream = this.diagnostics.attachAgent(agent.agentId, {
        history: this.history,
        signal,
      });
      while (true) {
        const next = await stream.next();
        if (next.done) {
          await this.refreshAttachConversation(generation);
          if (this.isCurrentAttach(generation) && !this.state.attach?.terminalReason) {
            this.state.message = `attach ended with exit code ${next.value}`;
            this.state.messageKind = next.value === 0 ? "normal" : "warning";
            this.render();
          }
          return;
        }
        if (!this.isCurrentAttach(generation)) {
          return;
        }
        const attach = this.state.attach;
        if (!attach) {
          return;
        }
        if (next.value.kind === "snapshot") {
          this.state.attach = { ...attach, agent: next.value.agent };
          this.render();
        } else if (next.value.kind === "terminal") {
          this.state.attach = { ...attach, terminalReason: next.value.reason };
          this.render();
        }
      }
    } catch (cause) {
      if (signal.aborted || !this.isCurrentAttach(generation)) {
        return;
      }
      this.state.message = cause instanceof Error ? cause.message : String(cause);
      this.state.messageKind = "error";
      this.render();
    }
  }

  private async returnToList(): Promise<void> {
    const attachAbort = this.attachAbort;
    const attachPump = this.attachPump;
    this.attachGeneration += 1;
    this.conversationRefreshQueued = false;
    attachAbort?.abort();
    this.state.mode = "list";
    this.state.attach = undefined;
    this.state.message = undefined;
    this.state.messageKind = undefined;
    this.state.loading = true;
    this.render();
    await attachPump;
    if (this.attachPump === attachPump) {
      this.attachPump = undefined;
    }
    if (this.attachAbort === attachAbort) {
      this.attachAbort = undefined;
    }
    await this.requestRefresh();
  }

  private isCurrentAttach(generation: number): boolean {
    return this.state.mode === "attach" && generation === this.attachGeneration;
  }

  private refreshAttachConversation(generation: number): Promise<void> {
    if (!this.isCurrentAttach(generation)) {
      return Promise.resolve();
    }
    this.conversationRefreshQueued = true;
    this.conversationRefreshGeneration = generation;
    if (!this.conversationRefreshPump) {
      this.conversationRefreshPump = this.drainConversationRefreshes();
    }
    return this.conversationRefreshPump;
  }

  private async drainConversationRefreshes(): Promise<void> {
    try {
      while (this.conversationRefreshQueued) {
        this.conversationRefreshQueued = false;
        await this.performConversationRefresh(this.conversationRefreshGeneration);
      }
    } finally {
      this.conversationRefreshPump = undefined;
    }
  }

  // oxlint-disable-next-line complexity -- guards async generation state before viewport updates
  private async performConversationRefresh(generation: number): Promise<void> {
    const attach = this.state.attach;
    if (!attach || !this.isCurrentAttach(generation)) {
      return;
    }
    try {
      const conversation = await this.diagnostics.readConversation(attach.agent.agentId);
      if (!this.isCurrentAttach(generation) || !this.state.attach) {
        return;
      }
      const current = this.state.attach;
      if (!conversation) {
        this.state.attach = {
          ...current,
          conversationState:
            current.agent.instance.state === "running" && !current.terminalReason
              ? "waiting"
              : "unavailable",
        };
        this.render();
        return;
      }
      const previousLineCount = countAttachLines(current.items, this.terminal.width, this.terminal);
      const nextLineCount = countAttachLines(
        conversation.items,
        this.terminal.width,
        this.terminal,
      );
      const addedLineCount = Math.max(0, nextLineCount - previousLineCount);
      const addedItemCount = Math.max(0, conversation.items.length - current.items.length);
      const paused = current.scrollOffset > 0;
      const next: AttachViewState = {
        ...current,
        items: conversation.items,
        conversationState: "ready",
        scrollOffset: paused ? current.scrollOffset + addedLineCount : 0,
        unreadCount: paused ? current.unreadCount + addedItemCount : 0,
      };
      this.state.attach = scrollAttach(
        next,
        0,
        false,
        Math.max(1, this.terminal.height - 5),
        nextLineCount,
      );
      this.render();
    } catch (cause) {
      if (!this.isCurrentAttach(generation)) {
        return;
      }
      if (this.state.attach) {
        this.state.attach = { ...this.state.attach, conversationState: "unavailable" };
      }
      this.state.message = cause instanceof Error ? cause.message : String(cause);
      this.state.messageKind = "error";
      this.render();
    }
  }

  // oxlint-disable-next-line complexity -- owns serialized refresh, epoch validation, and stale merge
  private async requestRefresh(): Promise<void> {
    if (this.state.mode !== "list" || this.done) {
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        const epoch = ++this.listEpoch;
        const includeAll = this.state.includeAll;
        const previousAgents = visibleAgents(this.state);
        const previousIndex = Math.max(
          0,
          previousAgents.findIndex((agent) => agent.agentId === this.state.selectedAgentId),
        );
        try {
          const result = await this.diagnostics.listAgents({ includeAll });
          if (this.state.mode !== "list" || this.done) {
            return;
          }
          if (epoch !== this.listEpoch || includeAll !== this.state.includeAll) {
            continue;
          }
          const warningInstances = new Set(
            result.warnings.flatMap((warning) => (warning.instanceId ? [warning.instanceId] : [])),
          );
          const retained = this.state.agents.filter(
            (agent) =>
              warningInstances.has(agent.instance.instanceId) &&
              !result.agents.some((candidate) => candidate.agentId === agent.agentId),
          );
          this.state.agents = [...result.agents, ...retained];
          this.state.staleAgentIds = new Set(retained.map((agent) => agent.agentId));
          this.state.warnings = result.warnings;
          this.state.loading = false;
          this.state.lastRefreshAt = Date.now();
          this.state.selectedAgentId = reconcileSelection(this.state, previousIndex);
          if (this.state.messageKind === "error") {
            this.state.message = undefined;
            this.state.messageKind = undefined;
          }
        } catch (cause) {
          this.state.loading = false;
          this.state.message = cause instanceof Error ? cause.message : String(cause);
          this.state.messageKind = "error";
        }
        this.render();
      } while (this.refreshQueued && this.state.mode === "list" && !this.done);
    } finally {
      this.refreshing = false;
    }
  }

  private render(): void {
    if (this.done) {
      return;
    }
    this.lastFrame = renderTop(
      this.state,
      this.terminal.width,
      this.terminal.height,
      this.terminal,
    );
    this.terminal.draw(this.lastFrame);
  }

  private finish(code: number): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.resolveDone?.(code);
  }
}
