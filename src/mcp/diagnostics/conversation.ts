import type { SessionRecord, SessionToolResult } from "../../types.js";

export type DiagnosticConversationItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "resume" }
  | { kind: "thinking"; text: string; redacted?: false }
  | { kind: "thinking"; redacted: true }
  | { kind: "tool_call"; toolCallId: string; name: string; input: string }
  | {
      kind: "tool_result";
      toolCallId: string;
      name: string;
      text: string;
      isError: boolean;
    };

export type DiagnosticConversation = {
  schema: "cs-agent-mcp.diagnostics.v1";
  updatedAt: string;
  title?: string;
  items: DiagnosticConversationItem[];
};

export function projectConversation(record: SessionRecord): DiagnosticConversation {
  const items: DiagnosticConversationItem[] = [];
  for (const message of record.messages) {
    if (message === "Resume") {
      items.push({ kind: "resume" });
      continue;
    }
    if ("User" in message) {
      projectUserContent(message.User.content, items);
      continue;
    }
    projectAgentMessage(message.Agent, items);
  }
  return {
    schema: "cs-agent-mcp.diagnostics.v1",
    updatedAt: record.updated_at,
    ...(record.title ? { title: record.title } : {}),
    items,
  };
}

function projectUserContent(
  contentBlocks: Extract<SessionRecord["messages"][number], { User: unknown }>["User"]["content"],
  items: DiagnosticConversationItem[],
): void {
  for (const content of contentBlocks) {
    items.push(projectUserContentBlock(content));
  }
}

function projectUserContentBlock(
  content: Extract<SessionRecord["messages"][number], { User: unknown }>["User"]["content"][number],
): DiagnosticConversationItem {
  if ("Text" in content) {
    return { kind: "user", text: content.Text };
  }
  if ("Mention" in content) {
    return {
      kind: "user",
      text: `[mention ${content.Mention.uri}] ${content.Mention.content}`,
    };
  }
  if ("Image" in content) {
    return {
      kind: "user",
      text: `[image ${content.Image.size?.width ?? "?"}x${content.Image.size?.height ?? "?"}]`,
    };
  }
  return { kind: "user", text: `[audio ${content.Audio.mime_type}]` };
}

function projectAgentMessage(
  message: Extract<SessionRecord["messages"][number], { Agent: unknown }>["Agent"],
  items: DiagnosticConversationItem[],
): void {
  const projectedToolResults = new Set<string>();
  for (const content of message.content) {
    if ("Text" in content) {
      items.push({ kind: "assistant", text: content.Text });
    } else if ("Thinking" in content) {
      items.push({ kind: "thinking", text: content.Thinking.text });
    } else if ("RedactedThinking" in content) {
      items.push({ kind: "thinking", redacted: true });
    } else {
      items.push({
        kind: "tool_call",
        toolCallId: content.ToolUse.id,
        name: content.ToolUse.name,
        input: formatToolInput(
          content.ToolUse.input,
          content.ToolUse.raw_input,
          content.ToolUse.is_input_complete,
        ),
      });
      const result = message.tool_results[content.ToolUse.id];
      if (result) {
        items.push(projectToolResult(result));
        projectedToolResults.add(content.ToolUse.id);
      }
    }
  }
  for (const result of Object.values(message.tool_results)) {
    if (!projectedToolResults.has(result.tool_use_id)) {
      items.push(projectToolResult(result));
    }
  }
}

function projectToolResult(result: SessionToolResult): DiagnosticConversationItem {
  return {
    kind: "tool_result",
    toolCallId: result.tool_use_id,
    name: result.tool_name,
    text: formatToolResult(result),
    isError: result.is_error,
  };
}

function formatToolInput(input: unknown, rawInput: string, complete: boolean): string {
  if (!complete && rawInput) {
    return rawInput;
  }
  return formatStructuredValue(input) || rawInput;
}

// oxlint-disable-next-line complexity -- preserves text/media content and optional structured output
function formatToolResult(result: SessionToolResult): string {
  const content =
    "Text" in result.content
      ? result.content.Text
      : `[image ${result.content.Image.size?.width ?? "?"}x${result.content.Image.size?.height ?? "?"}]`;
  const output = formatStructuredValue(result.output);
  if (!output || output === content) {
    return content;
  }
  return content ? `${content}\n${output}` : output;
}

function formatStructuredValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[unserializable value]";
  }
}
