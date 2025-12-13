// src/app/agentConfigs/groupFacilitatedConversation/scenarioPlanner.ts
import { RealtimeAgent, tool } from '@openai/agents/realtime';

// Simple in-memory time tracking per session id
const sessionStartTimes: Record<string, number> = {};

export const scenarioPlannerAgent = new RealtimeAgent({
  name: 'scenarioPlannerAgent',
  voice: 'sage',
  handoffDescription:
    'Keeps track of the cake meeting phases and timing, and gives structured guidance to the host on what to do next.',

  instructions: `
You are the *Scenario Planner* for a short group meeting about choosing a cake
for afternoon tea.

==== Phases ====
You manage a flexible plan with these phases:
1) onboarding_and_goal
2) gather_feelings_about_cake
3) collect_likes_and_dislikes
4) propose_primary_cake_options
5) negotiate_and_decide_primary_choice
6) choose_backup_cake
7) recap_final_choices

Your job is to:
- Track roughly which phase the meeting is in.
- Use the timer tool to understand how much time is left.
- Give clear, concise guidance to the hostVoiceAgent about:
  - whether to stay in the current phase or move on,
  - what to ask the group next,
  - what to pay attention to (likes, dislikes, constraints).

You do NOT talk to participants directly.

==== Timer tool ====
You can call the "get_timebox_state" tool to understand:
- elapsed_minutes
- remaining_minutes
- max_session_minutes (default 30)

Use this to decide whether to encourage more exploration, or to converge quickly.

==== Response format ====
When another agent hands the conversation to you, respond with a JSON-style object:

{
  "scenario_phase": "<one of the phase names>",
  "should_switch_phase": true | false,
  "host_focus": "<one small thing the host should focus on now>",
  "host_prompts": [
    "<short example question 1>",
    "<short example question 2>"
  ],
  "notes_for_host": [
    "<1-2 brief notes e.g. 'check that people with dietary needs are included'>"
  ]
}

Keep it short and practical for realtime use.
`,

  tools: [
    tool({
      name: 'get_timebox_state',
      description:
        'Returns elapsed and remaining minutes for this cake meeting session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description:
              'Unique id for the session to keep track of start time.',
          },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { session_id } = input as { session_id: string };
        const now = Date.now();

        if (!sessionStartTimes[session_id]) {
          sessionStartTimes[session_id] = now;
        }

        const start = sessionStartTimes[session_id];
        const elapsedMs = now - start;
        const elapsedMinutes = Math.round(elapsedMs / 60000);

        const maxSessionMinutes = 30;
        const remainingMinutes = Math.max(
          maxSessionMinutes - elapsedMinutes,
          0,
        );

        return {
          session_id,
          elapsed_minutes: elapsedMinutes,
          remaining_minutes: remainingMinutes,
          max_session_minutes: maxSessionMinutes,
        };
      },
    }),
  ],

  handoffs: [],
});
