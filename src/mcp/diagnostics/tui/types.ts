import type {
  AgentDiagnosticSummary,
  DiagnosticTimelineItem,
  DiagnosticWarning,
} from "../index.js";

export type TopStyle = "normal" | "header" | "accent" | "muted" | "selected" | "warning" | "error";

export type TopSegment = {
  text: string;
  style?: TopStyle;
};

export type TopFrame = {
  lines: TopSegment[][];
  rowAgentIds: Map<number, string>;
};

export type TerminalEvent =
  | { type: "key"; name: string; text?: string }
  | { type: "mouse"; name: string; x: number; y: number }
  | { type: "resize"; width: number; height: number };

export type TextMetrics = {
  measure(text: string): number;
  truncate(text: string, width: number): string;
};

export type TopTerminal = TextMetrics & {
  readonly width: number;
  readonly height: number;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  setEventHandler(handler?: (event: TerminalEvent) => void): void;
  draw(frame: TopFrame): void;
};

export type AttachViewState = {
  agent: AgentDiagnosticSummary;
  items: DiagnosticTimelineItem[];
  scrollOffset: number;
  unreadCount: number;
  trimmedCount: number;
  terminalReason?: string;
};

export type AgentsTopState = {
  mode: "list" | "attach";
  agents: AgentDiagnosticSummary[];
  staleAgentIds: Set<string>;
  warnings: DiagnosticWarning[];
  includeAll: boolean;
  filter: string;
  filterDraft: string;
  filterEditing: boolean;
  selectedAgentId?: string;
  attach?: AttachViewState;
  loading: boolean;
  lastRefreshAt?: number;
  message?: string;
  messageKind?: "normal" | "warning" | "error";
};
