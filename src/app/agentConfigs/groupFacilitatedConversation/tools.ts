// src/app/agentConfigs/groupCakeMeeting/tools.ts
import type { ToolLogic } from "@/app/types";

/**
 * Shared tool logic for the "groupCakeMeeting" scenario.
 * We only define ONE custom tool: get_timebox_state.
 */
export const groupCakeToolLogic: ToolLogic = {
  async get_timebox_state({ args, state }) {
    // Very simple timebox implementation for testing.
    // In a real app you’d set state.session_start when the session begins.
    const now = Date.now();
    const sessionStart = state.session_start ?? now;
    const elapsedMs = now - sessionStart;

    const maxSessionMinutes = state.max_session_minutes ?? 30; // default: 30 min cake meeting

    const elapsedMinutes = Math.round(elapsedMs / 60000);
    const remainingMinutes = Math.max(maxSessionMinutes - elapsedMinutes, 0);

    return {
      session_id: args.session_id ?? "default-session",
      elapsed_minutes: elapsedMinutes,
      remaining_minutes: remainingMinutes,
      max_session_minutes: maxSessionMinutes,
    };
  },
};
