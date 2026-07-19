import type { Message, Permission, Turn, WaitManyReadyItem } from "./types.js";

export type WaitManyProjectionInput = {
  turn: Turn;
  message?: Message;
  permission?: Permission;
  terminal: boolean;
};

export type WaitManyProjection = {
  ready: WaitManyReadyItem[];
  pendingTurnIds: string[];
  hasActionRequired: boolean;
};

export function projectWaitMany(inputs: WaitManyProjectionInput[]): WaitManyProjection {
  const ready: WaitManyReadyItem[] = [];
  const pendingTurnIds: string[] = [];
  let hasActionRequired = false;

  for (const input of inputs) {
    if (input.message) {
      ready.push({ status: "message", message: input.message, turn: input.turn });
    } else if (input.terminal) {
      ready.push({ status: "terminal_without_message", turn: input.turn });
    } else if (input.permission) {
      ready.push({ status: "action_required", turn: input.turn, permission: input.permission });
      hasActionRequired = true;
    }

    if (!input.terminal) {
      pendingTurnIds.push(input.turn.turnId);
    }
  }

  return { ready, pendingTurnIds, hasActionRequired };
}
