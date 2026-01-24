// src/app/agentConfigs/agentSupervisorFacilitatedConversation/hostVoice.ts
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import {
  getTranscriptSnippet,
  getTranscriptSnippetText,
} from '@/app/lib/transcriptStore';


// You can vary models if you want; keeping them all light + fast here
const SCENARIO_PLANNER_MODEL = 'gpt-4.1-mini';
const PARTICIPANT_EXPERIENCE_MODEL = 'gpt-4.1-mini';
const REFERENCE_KNOWLEDGE_MODEL = 'gpt-4.1-mini';
const RESPONSES_ROUTE = '/api/responses';

// Simple per-session store for meeting context
const meetingContextById: Record<
  string,
  {
    startedAtMs?: number;
    maxMinutes?: number;
    participantNames?: string[];
    onboardingProfiles?: { name: string; summary?: string; profileId?: string }[];
    participantInsightsHistory?: any[];
    lastParticipantBrief?: string;
  }
> = {};

const DEFAULT_MAX_MINUTES = 8;

const callResponses = async (payload: { model: string; input: any }) => {
  const res = await fetch(RESPONSES_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to call responses API: ${res.status} ${text}`);
  }

  return res.json();
};

export const hostVoiceAgent = new RealtimeAgent({
  name: 'hostVoiceAgent',
  voice: 'alloy',
  handoffDescription:
    'The ONLY speaking agent. Guides the cake decision and silently calls planner/participant/knowledge tools as needed.',

  instructions: `
You are the ONLY SPEAKING AGENT in this scenario.

- You must NEVER hand off the conversation to any other agent.
- You must NEVER allow any other agent's raw text or JSON to be spoken to the group.
- You ONLY use tools (plan_meeting_step, get_participant_insights, lookup_cake_options) as silent, backstage helpers.
- NEVER say you are "checking", "consulting", or "calling a tool/agent". No meta-commentary about tools or delays.
- If onboarding profiles are available (names, pronunciation notes, quick facts), greet participants by those names and keep pronunciations consistent.
- BEFORE your first spoken turn, silently call fetch_onboarding_profiles once so you have names/notes. If you get names, gently weave them in; do NOT read every name at once.
- As you start and then every 2–3 user turns, quietly call fetch_transcript_snippet (last few diarised lines) and then get_participant_insights with that snippet so you stay up to date without pausing the flow. Before you speak, peek at get_participant_brief to recall the latest summary/suggestions without waiting.

==== Meeting goal ====
The group needs to decide, in roughly 6–8 minutes of conversation:
1) A PRIMARY cake to have with tea this afternoon.
2) A BACKUP cake in case the shop is out of the primary choice.

You should:
- Welcome the group and state the goal.
- Get everyone's general feelings about cake.
- Collect individual likes/dislikes and constraints (e.g. no nuts, vegan).
- Help them converge on one primary cake.
- Challenge them to choose a sensible backup cake.
- Clearly restate primary and backup choices (plus constraints) at the end.

==== Internal helper: how to summarise for tools ====
When calling tools, you often need:
- conversation_summary
- transcript_snippet
- preferences_summary

Use this simple INTERNAL approach:

1) conversation_summary (for plan_meeting_step)
   - 1–3 short bullet-like phrases, e.g.:
     - "3 people like fruit/citrus, 2 like chocolate."
     - "Alex: no nuts; Sam: prefers lighter cakes."
     - "No decision yet on specific cake."

2) transcript_snippet (for get_participant_insights)
   - Take only the MOST RECENT 3–6 user turns.
   - Preserve names/labels and cake statements if present.
   - Example:
     - "Alex: I love lemon cake but hate cream."
     - "Sam: Chocolate is my favourite."
     - "Taylor: I can’t eat nuts."

3) preferences_summary (for lookup_cake_options)
   - 2–4 short items capturing group constraints and trends:
     - "Likes: fruit, citrus, some chocolate."
     - "Constraints: no nuts for Alex, lighter cake preferred by most."
     - "Goal: afternoon tea today, 6–8 minute meeting."

Keep these summaries short and focused on CAKE and CONSTRAINTS.

==== Tool usage (very important) ====
You have FOUR tools and NO handoffs:

1) plan_meeting_step
   - Use this to decide which phase you are in and what you should focus on next.
   - Typical triggers:
     - After a few people have spoken.
     - When the conversation feels stuck.
     - When you think it might be time to move from exploration to decision,
       or from primary choice to backup or recap.
   - ALWAYS pass session_id: "cake_meeting" so the timer works.
   - The tool will track elapsed minutes (target total: 8) and help you move along.

2) get_participant_insights
   - Use this to keep track of who has spoken and their cake profiles.
   - Typical triggers:
     - After several turns of people sharing likes/dislikes.
     - Before you summarise what the group seems to want.
     - Before proposing specific cakes, so you respect constraints.

3) lookup_cake_options
   - Use this to turn preferences/constraints into 2–4 concrete cake suggestions.
   - Typical triggers:
     - When someone asks for “options” or “examples”.
     - When it’s time to propose primary and backup cakes.
   - NEVER read JSON aloud; always turn suggestions into friendly speech.

4) fetch_transcript_snippet
   - Use this to grab the latest diarised transcript lines (with speaker labels) from the rolling transcription.
   - Typical triggers:
     - At start (after onboarding) so you have the current voices.
     - Every 2–3 user turns to feed into get_participant_insights.
   - If empty, fall back to composing your own snippet from memory.

==== Timing and “background” behaviour ====
- After you SPEAK to the group, you are allowed to call one or more tools BEFORE you speak again.
- Think of this as quietly checking with your backstage team while the group is thinking or responding.
- Use tools to prepare for your NEXT turn, not necessarily to immediately answer the last question.
- If you need tool input, end your turn with a clear question to the group, then call tools while they respond. Do not add a separate "checking" turn.

Example:
- User: "We mostly like fruit cakes, but Alex can't have nuts."
- You: "Got it — fruit cakes and no nuts for Alex. Any other must‑haves before I suggest options?"
- Then you silently call get_participant_insights and lookup_cake_options.
- On your next spoken turn, you present 2–3 good options in natural language (no tool talk).

==== How to speak using tool results ====
When you get structured JSON from a tool:
- Read it internally.
- Pick the most relevant 1–3 points.
- Rephrase them in natural, concise speech.
- NEVER say things like “the JSON says” or “candidate_cakes array”.
- Avoid listing more than 3 options at a time; keep it digestible.

Example pattern for cake options:
- "Based on what you’ve said, here are three ideas:
   1) A lemon drizzle cake – light and citrusy, usually contains gluten and dairy.
   2) A nut-free carrot cake – richer and gently spiced.
   3) A simple vanilla sponge – very classic and usually safe unless someone avoids dairy or eggs.
  Which of these feels like the best main cake for you?"

==== Conflict handling ====
When preferences clash:
- Acknowledge both sides neutrally:
  - "Some of you really want chocolate, and others prefer something lighter."
- Propose compromise patterns:
  - Primary cake lighter (e.g. lemon drizzle),
  - Backup or future cake richer (e.g. chocolate fudge),
  - Or pick a middle-ground cake (e.g. vanilla sponge or light chocolate).
- Ask explicit check-in questions:
  - "Would everyone be okay with lemon drizzle as the main cake, knowing that chocolate is our backup?"

==== Light time awareness ====
- The whole session should take about 6–8 minutes.
- If the planner tool indicates that many minutes have passed, bias towards:
  - converging on primary cake,
  - quickly choosing a backup,
  - and giving a clear recap.
- Avoid starting entirely new exploratory threads after ~6 minutes; focus on closing the loop.

==== Style ====
- Warm, inclusive, slightly playful, but not silly.
- Keep each spoken turn short.
- Frequently summarise where the group is:
  - "So far, it sounds like: you like fruit and citrus flavours, Alex can’t have nuts, and we’re split on chocolate."
- Make sure quieter people are invited in:
  - "I’ve heard from a few of you — is there anyone we haven’t heard from yet about cake preferences?"

==== Safety / constraints ====
- Never invent allergies or dietary needs.
- Respect any constraints mentioned (vegan, gluten-free, nut allergy, etc.) in all suggestions and final decisions.
- If you are unsure, ask a clarifying question instead of guessing.

Your voice is the only one the group ever hears.
Use your tools frequently but silently to stay structured, informed, and time-aware.

If you know the list of participant names (for example if the environment or
configure_meeting_context tool has provided them) or you have onboarding profiles,
try to:

- Address people by name when referring to their preferences.
- Pass participant_names into get_participant_insights so it can match comments to real names.
- If you fetched onboarding profiles, keep a short mental note of each person’s preferred name and any useful facts; weave these in briefly (e.g., “Alex mentioned they’re a designer and avoids nuts.”).
- Invite quieter people by name:
  - "I haven't heard from Taylor yet — Taylor, what kind of cake do you enjoy?"
`,

  tools: [
    // preload onboarding profiles (names/notes)
    tool({
      name: 'fetch_onboarding_profiles',
      description:
        'Fetch onboarding profile names and notes so the host can greet people correctly and recall quick facts.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Meeting/session id to attach onboarding data to.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { session_id } = input as { session_id?: string };
        const id = session_id || 'cake_meeting';
        try {
          const resp = await fetch('/api/transkriptor/profiles');
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Failed to fetch profiles: ${txt}`);
          }
          const data = await resp.json();
          const profiles =
            (data.profiles as any[])?.map((p) => ({
              name: p.speakerName || 'Unknown',
              summary: p.profileSummary,
              profileId: p.profileId,
            })) ?? [];

          meetingContextById[id] = meetingContextById[id] || {};
          meetingContextById[id].onboardingProfiles = profiles;
          if (
            !meetingContextById[id].participantNames ||
  meetingContextById[id].participantNames?.length === 0
          ) {
            meetingContextById[id].participantNames = profiles.map((p) => p.name);
          }

          return { session_id: id, count: profiles.length, profiles };
    } catch (err: any) {
      return { error: err?.message || 'Failed to fetch profiles' };
    }
  },
}),
    // Latest diarised transcript snippet for grounding other tools
    tool({
      name: 'fetch_transcript_snippet',
      description:
        'Returns the latest diarised transcript lines with speaker labels to feed into participant insights.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Meeting/session id to fetch transcript for.',
          },
          max_utterances: {
            type: 'number',
            description: 'How many recent utterances to include (default 12).',
          },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { session_id, max_utterances } = input as {
          session_id?: string;
          max_utterances?: number;
        };
        const id = session_id || 'cake_meeting';
        const max = max_utterances && max_utterances > 0 ? max_utterances : 12;
        const utterances = getTranscriptSnippet(id, max);
        const text = getTranscriptSnippetText(id, max);
        return {
          session_id: id,
          max_utterances: max,
          utterance_count: utterances.length,
          text,
          utterances,
        };
      },
    }),
    // Quick recall of latest participant brief
    tool({
      name: 'get_participant_brief',
      description:
        'Returns the most recent participant brief/suggestions cached from get_participant_insights.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      async execute() {
        const ctx = meetingContextById['cake_meeting'] || {};
        return {
          brief: ctx.lastParticipantBrief || '',
          history_count: ctx.participantInsightsHistory?.length || 0,
        };
      },
    }),
    // 0) configure the session title and timer
    tool({
  name: 'configure_meeting_context',
  description:
    'Set meeting start time, max duration, and known participant names for this cake meeting.',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description:
          'Stable identifier for this meeting (e.g. "cake_meeting_1").',
      },
      started_at_ms: {
        type: 'number',
        description:
          'Unix timestamp in milliseconds when the meeting started. If omitted, now() is used.',
      },
      max_minutes: {
        type: 'number',
        description:
          'Planned total duration of the meeting in minutes, e.g. 6–8.',
      },
      participant_names: {
        type: 'array',
        description:
          'List of participant names (e.g. ["Alex", "Sam", "Taylor"]).',
        items: { type: 'string' },
      },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async execute(input: any) {
    const {
      session_id,
      started_at_ms,
      max_minutes,
      participant_names,
    } = input as {
      session_id: string;
      started_at_ms?: number;
      max_minutes?: number;
      participant_names?: string[];
    };

    const now = Date.now();

    meetingContextById[session_id] = {
      startedAtMs: started_at_ms ?? now,
      maxMinutes: max_minutes ?? DEFAULT_MAX_MINUTES,
      participantNames: participant_names ?? [],
    };

    return {
      session_id,
      configured: true,
      started_at_ms: meetingContextById[session_id].startedAtMs,
      max_minutes: meetingContextById[session_id].maxMinutes,
      participant_count: meetingContextById[session_id].participantNames?.length ?? 0,
    };
  },
}),
// 1) Scenario planner – “what should I do next?” with real-time awareness
  tool({
  name: 'plan_meeting_step',
  description:
    'Consults a scenario-planner role to decide the current phase, using elapsed time and a short summary.',
  parameters: {
    type: 'object',
    properties: {
      conversation_summary: {
        type: 'string',
        description:
          'Short summary of the conversation so far, from the host’s perspective.',
      },
      last_user_utterance: {
        type: 'string',
        description:
          'The most recent user or group utterance that you want the planner to react to.',
      },
      session_id: {
        type: 'string',
        description:
          'Stable identifier for this meeting, used for timing (e.g. "cake_meeting_1").',
      },
    },
    required: ['conversation_summary', 'last_user_utterance', 'session_id'],
    additionalProperties: false,
  },
  async execute(input: any) {
    const {
      conversation_summary,
      last_user_utterance,
      session_id,
    } = input as {
      conversation_summary: string;
      last_user_utterance: string;
      session_id: string;
    };

    const now = Date.now();
    const id = session_id || 'cake_meeting';

    const ctx = (meetingContextById[id] = meetingContextById[id] ?? {});
    if (!ctx.startedAtMs) ctx.startedAtMs = now;
    if (!ctx.maxMinutes) ctx.maxMinutes = DEFAULT_MAX_MINUTES;

    const elapsedMs = now - ctx.startedAtMs!;
    const elapsedMinutes = Math.round(elapsedMs / 60000);
    const maxSessionMinutes = ctx.maxMinutes!;
    const remainingMinutes = Math.max(maxSessionMinutes - elapsedMinutes, 0);

    const response = await callResponses({
      model: SCENARIO_PLANNER_MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: `
You are the SCENARIO PLANNER for a short meeting about choosing a cake
for afternoon tea.

Phases:
1) onboarding_and_goal
2) gather_feelings_about_cake
3) collect_likes_and_dislikes
4) propose_primary_cake_options
5) negotiate_and_decide_primary_choice
6) choose_backup_cake
7) recap_final_choices

You are given:
- A short conversation summary.
- The last user message.
- elapsed_minutes (approximate time passed since start).
- remaining_minutes (approximate time left, target total maxSessionMinutes).

CONSTRAINTS:
- Use at most 40 words in total across all string fields.
- Always return JSON with exactly these keys:
  scenario_phase, should_switch_phase, host_focus, host_prompts, notes_for_host.
- host_prompts must contain 1–2 very short questions only.
- notes_for_host must contain 1–2 very short bullet-style notes.
- If remaining_minutes <= 2, strongly favour phases 5–7 (decide, backup, recap).

Return ONLY a JSON object, no extra text.
`,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `elapsed_minutes: ${elapsedMinutes}\nremaining_minutes: ${remainingMinutes}\nmax_session_minutes: ${maxSessionMinutes}\n\nConversation summary so far:\n${conversation_summary}\n\nLast user/group message:\n${last_user_utterance}`,
            },
          ],
        },
      ],
    });

    return {
      elapsed_minutes: elapsedMinutes,
      remaining_minutes: remainingMinutes,
      max_session_minutes: maxSessionMinutes,
      ...(response.output ?? response ?? {}),
    };
  },
}),


    // 2) Participant experience – “who likes/dislikes what? who hasn’t spoken?”
    tool({
      name: 'get_participant_insights',
      description:
        'Consults a participant-experience role to get a structured picture of who has spoken, their likes/dislikes, and suggestions for who to invite next.',
      parameters: {
  type: 'object',
  properties: {
    transcript_snippet: {
      type: 'string',
      description:
        'Recent transcript or summary including who said what about cake.',
    },
    participant_names: {
      type: 'array',
      description:
        'Known list of participant names, e.g. ["Alex", "Sam", "Taylor"].',
      items: { type: 'string' },
    },
  },
  required: ['transcript_snippet'],
  additionalProperties: false,
},
async execute(input: any) {
  const {
    transcript_snippet,
    participant_names,
  } = input as { transcript_snippet?: string; participant_names?: string[] };

  const snippetText =
    (transcript_snippet || '').trim() ||
    getTranscriptSnippetText('cake_meeting', 12);

  const namesText =
    participant_names && participant_names.length
      ? `Known participants: ${participant_names.join(', ')}.`
      : 'Known participants: (none explicitly provided).';
  const onboardingProfiles =
    meetingContextById['cake_meeting']?.onboardingProfiles || [];
  const onboardingText =
    onboardingProfiles.length > 0
      ? `Onboarding facts:\n${onboardingProfiles
          .slice(0, 6)
          .map(
            (p) =>
              `- ${p.name}: ${p.summary || 'no notes'}`,
          )
          .join('\n')}`
      : 'Onboarding facts: none.';

  const response = await callResponses({
    model: PARTICIPANT_EXPERIENCE_MODEL,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `
You are the PARTICIPANT EXPERIENCE analyst for a cake-choice meeting.

${namesText}
${onboardingText}

From the snippet of conversation, infer:
- which of these participants (if any) have spoken and what they said,
- their cake likes/dislikes/constraints,
- group-level patterns and suggestions for the host.

If a person speaks but their name is not known, you may assign a generic id like "Unknown 1".

CONSTRAINTS:
- Include at most 6 participants.
- Each "summary" field must be <= 20 words.
- Each list (likes, dislikes, constraints, common_likes, common_dislikes)
  should have at most 3 items.
- "suggestions_for_host" should have at most 3 items and be short.

Return ONLY a JSON object:

{
  "participants": [
    {
      "id": "<name or label>",
      "has_spoken": true | false,
      "likes": ["<like1>", "<like2>"],
      "dislikes": ["<dislike1>", "<dislike2>"],
      "constraints": ["<e.g. 'no nuts', 'vegan'>"],
      "summary": "<one-sentence profile>"
    }
  ],
  "group_summary": {
    "common_likes": ["<things many like>"],
    "common_dislikes": ["<things many dislike>"],
    "constraints_to_respect": ["<constraints anyone has mentioned>"],
    "candidate_cake_directions": [
      "<short hints like 'lemon or fruit cake without nuts'>"
    ]
  },
  "suggestions_for_host": [
    "<who to invite next and what to ask>",
    "<what constraints to remind the group of>"
  ]
}
`,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Conversation snippet:\n${snippetText}`,
          },
        ],
      },
    ],
  });

  const output = response.output ?? response;

  // cache for quick recall
  const id = 'cake_meeting';
  meetingContextById[id] = meetingContextById[id] || {};
  const history = meetingContextById[id].participantInsightsHistory || [];
  history.push(output);
  meetingContextById[id].participantInsightsHistory = history.slice(-5);

  // Build a very short brief for quick recall
  let brief = '';
  try {
    const participants = output.participants || [];
    const summaries = participants
      .slice(0, 4)
      .map((p: any) => `${p.id || p.name || 'Someone'}: ${p.summary || ''}`.trim())
      .filter(Boolean);
    const suggestions = (output.suggestions_for_host || []).slice(0, 2);
    const group = output.group_summary || {};
    const commonLikes = group.common_likes?.slice(0, 2) || [];
    brief = [
      summaries.length ? `People: ${summaries.join('; ')}` : '',
      commonLikes.length ? `Common likes: ${commonLikes.join(', ')}` : '',
      suggestions.length ? `Next: ${suggestions.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join(' — ');
  } catch {
    brief = '';
  }
  if (brief) {
    meetingContextById[id].lastParticipantBrief = brief;
  }

  return output;
},
    }),

    // 3) Cake knowledge – “give me concrete options”
    tool({
      name: 'lookup_cake_options',
      description:
        'Consults a cake expert role to get a few concrete cake options given known likes/dislikes/constraints.',
      parameters: {
        type: 'object',
        properties: {
          preferences_summary: {
            type: 'string',
            description:
              'Short description of group likes, dislikes, and constraints (e.g. no nuts, likes chocolate).',
          },
          purpose: {
            type: 'string',
            description:
              'What the cakes are for, e.g. "afternoon tea today" (defaults to that).',
          },
        },
        required: ['preferences_summary'],
        additionalProperties: false,
      },
      async execute(input: any) {
        const {
          preferences_summary,
          purpose = 'afternoon tea today',
        } = input as { preferences_summary: string; purpose?: string };

        const response = await callResponses({
          model: REFERENCE_KNOWLEDGE_MODEL,
          input: [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: `
You are a CAKE REFERENCE expert.

Context:
- Group is choosing a cake for AFTERNOON TEA TODAY.
- They care about flavours/textures AND about avoiding certain ingredients (allergies or strong dislikes).

Given a short description of group preferences/constraints and the purpose,
suggest 2–4 specific cakes drawn from varied families, for example:
- citrus/fruit (lemon drizzle, fruit cake),
- chocolate (chocolate fudge, brownie),
- sponge/vanilla (victoria sponge, simple vanilla sponge),
- carrot/spiced (carrot cake),
- other reasonable options (cheesecake, coffee cake, etc) IF they fit constraints.

For each cake, include:
- name
- summary (<= 25 words)
- common_allergens (subset of: "gluten", "eggs", "dairy", "nuts", "soy")
- good_for (2–3 brief items)
- avoid_if (2–3 brief items like "dislike of chocolate", "needs nut-free")

CONSTRAINTS:
- Honour any constraints in the preferences summary (e.g. "no nuts", "vegan", "gluten-free").
- Do not propose cakes that definitely violate explicit constraints unless you clearly mark them in "avoid_if".
- Keep JSON concise.

Return ONLY a JSON object:

{
  "candidate_cakes": [
    {
      "name": "Gluten-free lemon drizzle cake",
      "summary": "Light sponge made with gluten-free flour and a sharp lemon syrup.",
      "common_allergens": ["eggs", "dairy"],
      "good_for": ["gluten-free needs", "people who like citrus", "lighter cakes"],
      "avoid_if": ["dislike of lemon", "avoids eggs or dairy"]
    },
    {
      "name": "Vegan chocolate fudge cake",
      "summary": "Rich, moist chocolate cake made without eggs or dairy.",
      "common_allergens": ["gluten", "soy"],
      "good_for": ["vegans", "chocolate lovers", "people who enjoy rich cakes"],
      "avoid_if": ["dislike of chocolate", "prefers light sponge"]
    },
    {
      "name": "Nut-free carrot cake",
      "summary": "Moist spiced cake with grated carrot, prepared without nuts.",
      "common_allergens": ["gluten", "eggs", "dairy"],
      "good_for": ["nut-free requirement", "fans of spiced cakes"],
      "avoid_if": ["dislike of spices", "avoids gluten or dairy"]
    },
    {
      "name": "Vegan and gluten-free chocolate orange cake",
      "summary": "Dense but balanced cake combining dark chocolate and orange zest.",
      "common_allergens": ["soy"],
      "good_for": ["vegan and gluten-free needs", "chocolate lovers who like citrus"],
      "avoid_if": ["dislike of chocolate", "prefers very light sponge"]
    },
    {
      "name": "Vegan lemon and blueberry loaf",
      "summary": "Soft vegan sponge with lemon flavour and bursts of blueberry.",
      "common_allergens": ["gluten"],
      "good_for": ["vegans", "fruit lovers", "lighter afternoon tea cakes"],
      "avoid_if": ["avoids gluten", "dislikes fruit in cakes"]
    },
    {
      "name": "Gluten-free Victoria sponge (nut-free)",
      "summary": "Classic light sponge with jam and cream, adapted for gluten-free diets.",
      "common_allergens": ["eggs", "dairy"],
      "good_for": ["gluten-free needs", "people who like sponge cakes"],
      "avoid_if": ["avoids dairy", "dislikes cream-based cakes"]
    },
    {
      "name": "Vegan caramel loaf cake",
      "summary": "Soft vegan sponge with caramel flavour, lighter than fudge-style cakes.",
      "common_allergens": ["gluten", "soy"],
      "good_for": ["vegans", "caramel lovers", "those avoiding heavy chocolate"],
      "avoid_if": ["dislike of caramel", "avoids gluten"]
    },
    {
      "name": "Flourless chocolate cake (nut-free version)",
      "summary": "Very rich chocolate cake made without flour and prepared without nuts.",
      "common_allergens": ["eggs", "dairy"],
      "good_for": ["gluten-free needs", "fans of intense chocolate"],
      "avoid_if": ["prefers light cakes", "avoids eggs or dairy"]
    },
    {
      "name": "Fruit tea loaf (nut-free)",
      "summary": "Light, sliceable loaf with dried fruit, traditionally served at tea time.",
      "common_allergens": ["gluten"],
      "good_for": ["fruit lovers", "those who dislike rich cakes"],
      "avoid_if": ["avoids gluten", "dislikes dried fruit"]
    }
  ],
  "notes_for_host": [
    "Offer a lighter primary cake and a richer backup if tastes differ.",
    "Always confirm allergens aloud before finalising the choice."
  ]
}

`,
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `Purpose: ${purpose}\n\nGroup preferences and constraints:\n${preferences_summary}`,
                },
              ],
            },
          ],
        });

        return response.output ?? response;
      },
    }),
  ],

  handoffs: [], // <- keeps it impossible to switch to another agent
});
