import terminalKit from "terminal-kit";
import type { Terminal } from "terminal-kit";
import type { TerminalEvent, TopFrame, TopStyle, TopTerminal } from "./types.js";

const STYLE_CODES: Record<TopStyle, string> = {
  normal: "\u001b[0m",
  header: "\u001b[1;37;44m",
  accent: "\u001b[1;36m",
  muted: "\u001b[2;37m",
  selected: "\u001b[1;30;46m",
  warning: "\u001b[1;33m",
  error: "\u001b[1;31m",
};

type KeyData = { isCharacter?: boolean };
type MouseData = { x?: number; y?: number };

export class TerminalKitAdapter implements TopTerminal {
  private readonly terminal: Terminal;
  private handler?: (event: TerminalEvent) => void;
  private started = false;
  private stopped = false;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream, error: NodeJS.WriteStream) {
    this.terminal = terminalKit.createTerminal({
      stdin: input,
      stdout: output,
      stderr: error,
      appId: "cs-agent-mcp-agents-top",
      appName: "cs-agent-mcp agents top",
      isTTY: true,
    });
  }

  get width(): number {
    return this.terminal.width;
  }

  get height(): number {
    return this.terminal.height;
  }

  measure(text: string): number {
    return terminalKit.stringWidth(text);
  }

  truncate(text: string, width: number): string {
    if (width <= 0) {
      return "";
    }
    return terminalKit.truncateString(text, width);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.terminal.on("key", this.onKey);
    this.terminal.on("mouse", this.onMouse);
    this.terminal.on("resize", this.onResize);
    this.terminal.fullscreen(true);
    this.terminal.hideCursor();
    this.terminal.grabInput({ mouse: "button" });
  }

  async stop(): Promise<void> {
    if (this.stopped || !this.started) {
      return;
    }
    this.stopped = true;
    this.handler = undefined;
    this.bestEffort(() => this.terminal.removeListener("key", this.onKey));
    this.bestEffort(() => this.terminal.removeListener("mouse", this.onMouse));
    this.bestEffort(() => this.terminal.removeListener("resize", this.onResize));
    this.bestEffort(() => this.terminal.styleReset());
    this.bestEffort(() => this.terminal.mouseSGR(false));
    this.bestEffort(() => this.terminal.fullscreen(false));
    this.bestEffort(() => this.terminal.hideCursor(false));
    try {
      await Promise.resolve(this.terminal.grabInput(false, true));
    } catch {
      // Earlier restoration steps have already returned the terminal to a usable screen.
    }
  }

  setEventHandler(handler?: (event: TerminalEvent) => void): void {
    this.handler = handler;
  }

  draw(frame: TopFrame): void {
    for (let index = 0; index < this.height; index += 1) {
      const line = frame.lines[index] ?? [];
      const rendered = line
        .map((part) => `${STYLE_CODES[part.style ?? "normal"]}${part.text}`)
        .join("");
      this.terminal.moveTo(1, index + 1);
      this.terminal.noFormat(`${rendered}${STYLE_CODES.normal}`);
      this.terminal.eraseLineAfter();
    }
  }

  private readonly onKey = (name: string, _matches: string[], data: KeyData): void => {
    this.handler?.({
      type: "key",
      name,
      ...(data.isCharacter ? { text: name } : {}),
    });
  };

  private readonly onMouse = (name: string, data: MouseData): void => {
    if (typeof data.x !== "number" || typeof data.y !== "number") {
      return;
    }
    this.handler?.({ type: "mouse", name, x: data.x, y: data.y });
  };

  private readonly onResize = (width: number, height: number): void => {
    this.handler?.({ type: "resize", width, height });
  };

  private bestEffort(action: () => unknown): void {
    try {
      action();
    } catch {
      // Continue restoring independent terminal capabilities.
    }
  }
}
