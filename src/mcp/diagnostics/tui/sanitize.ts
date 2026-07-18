/* oxlint-disable no-control-regex -- these expressions intentionally remove terminal control bytes */
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu;
const STRING_SEQUENCE =
  /(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ESCAPE_SEQUENCE = /\u001b(?:[@-_]|[^\u0000-\u007f]?)/gu;
const C0_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const C1_CONTROLS = /[\u0080-\u009f]/gu;
const BIDI_OVERRIDES = /[\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeTerminalText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(C0_CONTROLS, "")
    .replace(C1_CONTROLS, "")
    .replace(BIDI_OVERRIDES, "")
    .replace(/[\t\r\n]+/gu, " ");
}
/* oxlint-enable no-control-regex */
