// src/app/agentConfigs/agentSupervisorFacilitatedConversation/hostVoice.ts
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import {
  getTranscriptSnippet,
  getTranscriptSnippetText,
} from '@/app/lib/transcriptStore';
import type {
  SessionSetupChapter,
  SessionSetupConfig,
  SessionSetupScenario,
} from '@/app/lib/sessionSetupTypes';
import { getBackgroundBrief } from '@/app/lib/participantBriefStore';


// You can vary models if you want; keeping them all light + fast here
const SCENARIO_PLANNER_MODEL = 'gpt-4.1-mini';
const PARTICIPANT_EXPERIENCE_MODEL = 'gpt-4.1-mini';
const REFERENCE_KNOWLEDGE_MODEL = 'gpt-4.1-mini';
const RESPONSES_ROUTE = '/api/responses';

// Simple per-session store for meeting context
type MeetingScenario = SessionSetupScenario;
type MeetingChapter = SessionSetupChapter;

const meetingContextById: Record<
  string,
  {
    startedAtMs?: number;
    maxMinutes?: number;
    participantNames?: string[];
    onboardingProfiles?: { name: string; summary?: string; profileId?: string }[];
    participantInsightsHistory?: any[];
    lastParticipantBrief?: string;
    rollingSummary?: string;
    recentRealtimeTranscript?: string;
    lastParticipantInsightSnippet?: string;
    lastParticipantInsightAt?: number;
    knowledgeBaseFolder?: string;
    scenario?: MeetingScenario;
    chapterIndex?: number;
    chapterStartMs?: number;
  }
> = {};

const DEFAULT_MAX_MINUTES = 8;

export const DEFAULT_MEETING_SCENARIO = {
  title: "Choose a cake",
  summary: "Group decides a primary and backup cake for afternoon tea.",
  totalMinutes: DEFAULT_MAX_MINUTES,
  chapters: [
    {
      id: "intro_goal",
      title: "Welcome + goal",
      goal: "Welcome everyone and state the goal of choosing a primary and backup cake.",
      targetMinutes: 1,
      hostPrompt:
        "Welcome! We are choosing a primary and backup cake for afternoon tea. Any dietary needs we must know first?",
      toolCadence: "low",
    },
    {
      id: "feelings",
      title: "General feelings",
      goal: "Get overall preferences and energy around cake styles.",
      targetMinutes: 1,
      hostPrompt:
        "Quick check: do you lean toward light fruit/citrus cakes or richer chocolate styles?",
      toolCadence: "medium",
    },
    {
      id: "likes_dislikes",
      title: "Likes, dislikes, constraints",
      goal: "Collect specific likes/dislikes and constraints from each person.",
      targetMinutes: 2,
      hostPrompt:
        "Let us go around: what cakes you like or dislike, and any constraints (nuts, gluten, dairy)?",
      toolCadence: "high",
    },
    {
      id: "options",
      title: "Propose options",
      goal: "Propose 2-3 concrete cakes that fit the preferences.",
      targetMinutes: 2,
      hostPrompt:
        "Based on what you shared, here are a few options. Which feels best as the primary cake?",
      toolCadence: "high",
    },
    {
      id: "decide_primary",
      title: "Decide primary",
      goal: "Narrow to one primary cake and confirm fit.",
      targetMinutes: 1,
      hostPrompt:
        "Can we agree on the primary cake now? Any strong objections before we lock it in?",
      toolCadence: "medium",
    },
    {
      id: "backup_recap",
      title: "Backup + recap",
      goal: "Pick a backup cake and recap final choices and constraints.",
      targetMinutes: 1,
      hostPrompt:
        "Let us pick a simple backup cake, then I will recap the final choices and constraints.",
      toolCadence: "medium",
    },
  ],
};

const cloneChapters = (chapters: MeetingChapter[] = []): MeetingChapter[] =>
  chapters.map((c) => ({ ...c }));

const normalizeScenario = (
  scenario?: MeetingScenario,
  maxMinutes?: number,
): MeetingScenario => {
  const base = scenario || DEFAULT_MEETING_SCENARIO;
  const chapters = cloneChapters(base.chapters || []);
  const totalMinutes =
    base.totalMinutes ?? maxMinutes ?? DEFAULT_MAX_MINUTES;
  return {
    title: base.title || DEFAULT_MEETING_SCENARIO.title,
    summary: base.summary || DEFAULT_MEETING_SCENARIO.summary,
    totalMinutes,
    chapters: chapters.length
      ? chapters
      : cloneChapters(DEFAULT_MEETING_SCENARIO.chapters),
  };
};

const buildChapterTargets = (
  scenario: MeetingScenario,
  fallbackTotal: number,
) => {
  const totalMinutes =
    scenario.totalMinutes ?? fallbackTotal ?? DEFAULT_MAX_MINUTES;
  const targets = scenario.chapters.map((c) =>
    c.targetMinutes && c.targetMinutes > 0 ? c.targetMinutes : 0,
  );
  const definedSum = targets.reduce((sum, t) => sum + (t || 0), 0);
  const missingCount = targets.filter((t) => !t).length;
  const remaining = Math.max(totalMinutes - definedSum, 0);
  const fill = missingCount > 0 ? remaining / missingCount : 0;
  const finalTargets = targets.map((t) => (t && t > 0 ? t : fill));
  return { totalMinutes, chapterTargets: finalTargets };
};

const getChapterIndexById = (
  scenario: MeetingScenario,
  chapterId?: string,
): number | null => {
  if (!chapterId) return null;
  const idx = scenario.chapters.findIndex((c) => c.id === chapterId);
  return idx >= 0 ? idx : null;
};

const clampChapterIndex = (scenario: MeetingScenario, idx: number) => {
  if (idx < 0) return 0;
  if (idx >= scenario.chapters.length) return scenario.chapters.length - 1;
  return idx;
};

const buildChapterPrompt = (chapter?: MeetingChapter) => {
  if (!chapter) return "";
  const parts = [
    chapter.title ? `Title: ${chapter.title}` : "",
    chapter.goal ? `Goal: ${chapter.goal}` : "",
    chapter.hostPrompt ? `Host prompt: ${chapter.hostPrompt}` : "",
    chapter.notes ? `Notes: ${chapter.notes}` : "",
  ].filter(Boolean);
  return parts.join(" ");
};

const buildScenarioBlock = (scenario: MeetingScenario) => {
  const lines = [
    `Title: ${scenario.title}`,
    scenario.summary ? `Summary: ${scenario.summary}` : "",
    `Total minutes: ${scenario.totalMinutes ?? DEFAULT_MAX_MINUTES}`,
    "Chapters:",
    ...scenario.chapters.map((c, i) => {
      const title = c.title || c.id;
      const mins = c.targetMinutes ? `${c.targetMinutes} min` : "auto minutes";
      const prompt = c.hostPrompt ? `Prompt: ${c.hostPrompt}` : "";
      const goal = c.goal ? `Goal: ${c.goal}` : "";
      const cadence = c.toolCadence ? `Cadence: ${c.toolCadence}` : "";
      const notes = c.notes ? `Notes: ${c.notes}` : "";
      const parts = [goal, prompt, cadence, notes].filter(Boolean).join(" | ");
      return `${i + 1}) ${title} (${c.id}) - ${mins}${
        parts ? ` - ${parts}` : ""
      }`;
    }),
  ].filter(Boolean);
  return lines.join("\n");
};

const computeSuggestedChapterIndex = (
  elapsedMinutes: number,
  chapterTargets: number[],
) => {
  let acc = 0;
  for (let i = 0; i < chapterTargets.length; i += 1) {
    acc += chapterTargets[i];
    if (elapsedMinutes <= acc) return i;
  }
  return Math.max(chapterTargets.length - 1, 0);
};

const sumTargetsToIndex = (targets: number[], index: number) =>
  targets.slice(0, index + 1).reduce((sum, v) => sum + v, 0);

const getMeetingStatusPayload = (
  ctx: {
    startedAtMs?: number;
    maxMinutes?: number;
    scenario?: MeetingScenario;
    chapterIndex?: number;
    chapterStartMs?: number;
  },
  now: number,
) => {
  const scenario = normalizeScenario(ctx.scenario, ctx.maxMinutes);
  const { totalMinutes, chapterTargets } = buildChapterTargets(
    scenario,
    ctx.maxMinutes ?? DEFAULT_MAX_MINUTES,
  );

  const startedAtMs = ctx.startedAtMs ?? now;
  const chapterIndex = clampChapterIndex(
    scenario,
    ctx.chapterIndex ?? 0,
  );
  const chapterStartMs = ctx.chapterStartMs ?? startedAtMs;

  const elapsedMinutes = Math.max(
    Math.floor((now - startedAtMs) / 60000),
    0,
  );
  const remainingMinutes = Math.max(totalMinutes - elapsedMinutes, 0);

  const chapterElapsedMinutes = Math.max(
    Math.floor((now - chapterStartMs) / 60000),
    0,
  );
  const chapterTargetMinutes = chapterTargets[chapterIndex] ?? 0;
  const chapterRemainingMinutes = Math.max(
    chapterTargetMinutes - chapterElapsedMinutes,
    0,
  );
  const suggestedChapterIndex = computeSuggestedChapterIndex(
    elapsedMinutes,
    chapterTargets,
  );
  const behindByMinutes = Math.max(
    elapsedMinutes - sumTargetsToIndex(chapterTargets, chapterIndex),
    0,
  );

  const currentChapter = scenario.chapters[chapterIndex];
  const nextChapter =
    chapterIndex + 1 < scenario.chapters.length
      ? scenario.chapters[chapterIndex + 1]
      : undefined;

  return {
    scenario,
    totalMinutes,
    elapsedMinutes,
    remainingMinutes,
    chapterIndex,
    chapterStartMs,
    chapterTargetMinutes,
    chapterElapsedMinutes,
    chapterRemainingMinutes,
    suggestedChapterIndex,
    behindByMinutes,
    shouldAdvance: suggestedChapterIndex > chapterIndex || behindByMinutes > 0,
    currentChapter,
    nextChapter,
    chapterPrompt: buildChapterPrompt(currentChapter),
    nextChapterPrompt: buildChapterPrompt(nextChapter),
  };
};

const callResponses = async (payload: {
  model: string;
  input: any;
  tools?: any;
  tool_choice?: any;
}) => {
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

export const DEFAULT_HOST_VOICE = 'alloy';

export const DEFAULT_HOST_VOICE_INSTRUCTIONS = `
You are the ONLY SPEAKING AGENT in this scenario.

- You must NEVER hand off the conversation to any other agent.
- You must NEVER allow any other agent's raw text or JSON to be spoken to the group.
- You ONLY use tools (plan_meeting_step, get_participant_insights, knowledge_base) as silent, backstage helpers.
- NEVER say you are "checking", "consulting", or "calling a tool/agent". No meta-commentary about tools or delays.
- If onboarding profiles are available (names, pronunciation notes, quick facts), greet participants by those names and keep pronunciations consistent.
- BEFORE your first spoken turn, silently call fetch_onboarding_profiles once so you have names/notes. If you get names, gently weave them in; do NOT read every name at once.
- Participant insights are maintained in the background. Before you speak, peek at get_participant_brief to recall the latest summary/suggestions without waiting.
- Only call fetch_transcript_snippet + get_participant_insights if you are missing recent context or the summary feels stale.

==== Meeting goal ====
The group needs to decide within the session time set by the host:
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
- knowledge_query

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

3) knowledge_query (for knowledge_base)
   - 1–2 lines describing what the host needs to know.
     - "What are good nut-free options for afternoon tea?"
     - "Do we have any constraints about allergens in the supplied docs?"

Keep these summaries short and focused on the scenario and constraints.

==== Tool usage (very important) ====
You have SIX tools and NO handoffs:

1) configure_meeting_context
   - Call ONCE at the start (before the main facilitation begins).
   - Pass session_id "cake_meeting", started_at_ms, max_minutes, participant_names,
     and the scenario config. This stores timing and chapters.

2) get_meeting_status
   - Use this to pull current chapter, timing, and suggested next step.
   - Typical triggers:
     - Before you speak.
     - When timing matters.
     - When you think it is time to move to the next chapter.

3) advance_chapter (or set_chapter)
   - Use to move the chapter when the group is ready or you are behind schedule.
   - Do this after a decision or when a chapter runs long.

4) get_participant_insights
   - Use this to keep track of who has spoken and their cake profiles.
   - Typical triggers:
     - After several turns of people sharing likes/dislikes.
     - Before you summarise what the group seems to want.
     - Before proposing specific cakes, so you respect constraints.

5) knowledge_base
   - Use this to answer factual questions using the uploaded knowledge base.
   - It should prefer knowledge base docs and only use web search if needed.
   - NEVER read JSON aloud; always turn key points into friendly speech.

6) fetch_transcript_snippet
   - Use this to grab the latest diarised transcript lines (with speaker labels) from the rolling transcription.
   - Typical triggers:
     - At start (after onboarding) so you have the current voices.
     - Every 2–3 user turns to feed into get_participant_insights.
   - If empty, fall back to composing your own snippet from memory.

Optional: plan_meeting_step
   - Use if you want an extra narrative nudge.
   - Pass session_id and a short summary. Keep it brief.

==== Timing and “background” behaviour ====
- After you SPEAK to the group, you are allowed to call one or more tools BEFORE you speak again.
- Think of this as quietly checking with your backstage team while the group is thinking or responding.
- Use tools to prepare for your NEXT turn, not necessarily to immediately answer the last question.
- If you need tool input, end your turn with a clear question to the group, then call tools while they respond. Do not add a separate "checking" turn.

Example:
- User: "We mostly like fruit cakes, but Alex can't have nuts."
- You: "Got it — fruit cakes and no nuts for Alex. Any other must‑haves before I suggest options?"
- Then you silently call get_participant_insights and knowledge_base.
- On your next spoken turn, you present 2–3 good options in natural language (no tool talk).

==== How to speak using tool results ====
When you get structured JSON from a tool:
- Read it internally.
- Pick the most relevant 1–3 points.
- Rephrase them in natural, concise speech.
- NEVER say things like “the JSON says” or “candidate_cakes array”.
- Avoid listing more than 3 options at a time; keep it digestible.

Example pattern for knowledge base use:
- "Based on our notes, here’s a concise answer. If you want, I can share a couple of options next."

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

==== Timing and chapter awareness ====
- Use get_meeting_status to monitor elapsed time and the current chapter target.
- If a chapter is running long or should_advance is true, move on and call advance_chapter.
- Avoid starting new exploratory threads near the end; bias toward decisions and recap.

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
`.trim();

export const DEFAULT_SCENARIO_PLANNER_PROMPT = `
You are the SCENARIO PLANNER for a meeting about choosing a cake.

You are given:
- The scenario title and summary.
- A chapter list (id, goal, prompt, target minutes).
- The current chapter id and index.
- A short conversation summary.
- The last user message.
- elapsed_minutes (approximate time passed since start).
- remaining_minutes (approximate time left, target total maxSessionMinutes).

CONSTRAINTS:
- Use at most 40 words in total across all string fields.
- Always return JSON with exactly these keys:
  scenario_phase, should_switch_phase, host_focus, host_prompts, notes_for_host.
- host_prompts must contain 1-2 very short questions only.
- notes_for_host must contain 1-2 very short bullet-style notes.
- If remaining_minutes <= 2, strongly favour decision and recap.

Return ONLY a JSON object, no extra text.
`.trim();

export const DEFAULT_PARTICIPANT_EXPERIENCE_PROMPT = `
You are the PARTICIPANT EXPERIENCE analyst for a cake-choice meeting.

{NAMES_TEXT}
{ONBOARDING_TEXT}

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
`.trim();

export const DEFAULT_KNOWLEDGE_BASE_PROMPT = `
You are a KNOWLEDGE BASE assistant for a facilitated live session.

You will receive:
- A question or task.
- A set of knowledge base documents (if any).

Priority:
1) Use the knowledge base documents first.
2) If they do not contain the answer, perform a web search.
3) If you use web info, note that it came from the web.

Constraints:
- Be concise and action-oriented for a live facilitator.
- If the answer is uncertain, say so.
- Keep output as short JSON so it can be read silently.

Return ONLY a JSON object:
{
  "answer": "<short response the host can use>",
  "sources": [
    { "type": "knowledge_base", "title": "<doc name>", "note": "<what it supported>" },
    { "type": "web", "title": "<source name>", "url": "<url>", "note": "<what it supported>" }
  ],
  "notes_for_host": ["<optional caution or follow-up question>"]
}
`.trim();

export function buildHostVoiceAgent(
  setup?: SessionSetupConfig,
): RealtimeAgent {
  const hostInstructions =
    setup?.prompts?.hostVoiceInstructions || DEFAULT_HOST_VOICE_INSTRUCTIONS;
  const scenarioPlannerPrompt =
    setup?.prompts?.scenarioPlannerSystemPrompt || DEFAULT_SCENARIO_PLANNER_PROMPT;
  const participantExperiencePrompt =
    setup?.prompts?.participantExperienceSystemPrompt ||
    DEFAULT_PARTICIPANT_EXPERIENCE_PROMPT;
  const knowledgeBasePrompt =
    setup?.prompts?.knowledgeBaseSystemPrompt || DEFAULT_KNOWLEDGE_BASE_PROMPT;
  const voice = setup?.voices?.hostVoice || DEFAULT_HOST_VOICE;
  const scenarioConfig = normalizeScenario(
    setup?.scenario,
    setup?.scenario?.totalMinutes,
  );
  const scenarioBlock = buildScenarioBlock(scenarioConfig);
  const meetingToolsNote = `
==== Meeting context tools (required) ====
- At the start of the session, call configure_meeting_context once with session_id "cake_meeting"
  and the scenario config below. This stores timing and chapters.
- Before you speak (or when timing matters), call get_meeting_status to pull chapter + timing.
- If the host wants to move on, call advance_chapter (or set_chapter) to update the current chapter.
- Do NOT read this config aloud; it is for internal guidance only.
`.trim();

  return new RealtimeAgent({
    name: 'hostVoiceAgent',
    voice,
    handoffDescription:
      'The ONLY speaking agent. Guides the cake decision and silently calls planner/participant/knowledge tools as needed.',

    instructions: `${hostInstructions}\n\n${meetingToolsNote}\n\n==== Scenario config (internal) ====\n${scenarioBlock}`,

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
        const background = getBackgroundBrief('cake_meeting');
        const combined = [ctx.rollingSummary, ctx.lastParticipantBrief, background?.text]
          .filter(Boolean)
          .join(' | ');
        return {
          brief: combined || '',
          rolling_summary: ctx.rollingSummary || '',
          recent_realtime_transcript: ctx.recentRealtimeTranscript || '',
          background_brief: background?.text || '',
          background_updated_at: background?.updatedAt || '',
          history_count: ctx.participantInsightsHistory?.length || 0,
        };
      },
    }),
    // 0) configure the session title and timer
    tool({
      name: 'configure_meeting_context',
      description:
        'Set meeting start time, max duration, scenario chapters, and participant names.',
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
              'Planned total duration of the meeting in minutes (fallback for scenario).',
          },
          participant_names: {
            type: 'array',
            description:
              'List of participant names (e.g. ["Alex", "Sam", "Taylor"]).',
            items: { type: 'string' },
          },
          scenario: {
            type: 'object',
            description: 'Scenario title, summary, and chapters.',
            properties: {
              title: { type: 'string' },
              summary: { type: 'string' },
              totalMinutes: { type: 'number' },
              chapters: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    goal: { type: 'string' },
                    targetMinutes: { type: 'number' },
                    hostPrompt: { type: 'string' },
                    toolCadence: { type: 'string' },
                    notes: { type: 'string' },
                  },
                  required: ['id'],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          current_chapter_id: {
            type: 'string',
            description: 'Optional chapter id to start with.',
          },
          current_chapter_index: {
            type: 'number',
            description: 'Optional chapter index to start with.',
          },
          knowledge_base_folder: {
            type: 'string',
            description: 'Optional knowledge base folder for this session.',
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
          scenario,
          current_chapter_id,
          current_chapter_index,
          knowledge_base_folder,
        } = input as {
          session_id: string;
          started_at_ms?: number;
          max_minutes?: number;
          participant_names?: string[];
          scenario?: MeetingScenario;
          current_chapter_id?: string;
          current_chapter_index?: number;
          knowledge_base_folder?: string;
        };

        const now = Date.now();
        const normalizedScenario = normalizeScenario(
          scenario,
          max_minutes ?? DEFAULT_MAX_MINUTES,
        );
        const idFromChapter = getChapterIndexById(
          normalizedScenario,
          current_chapter_id,
        );
        const chapterIndex = clampChapterIndex(
          normalizedScenario,
          idFromChapter ??
            (typeof current_chapter_index === 'number'
              ? current_chapter_index
              : 0),
        );

        meetingContextById[session_id] = {
          ...(meetingContextById[session_id] || {}),
          startedAtMs: started_at_ms ?? now,
          maxMinutes: max_minutes ?? normalizedScenario.totalMinutes,
          participantNames:
            participant_names ??
            meetingContextById[session_id]?.participantNames ??
            [],
          knowledgeBaseFolder:
            knowledge_base_folder ??
            meetingContextById[session_id]?.knowledgeBaseFolder,
          scenario: normalizedScenario,
          chapterIndex,
          chapterStartMs: started_at_ms ?? now,
        };

        const status = getMeetingStatusPayload(
          meetingContextById[session_id],
          now,
        );

        return {
          session_id,
          configured: true,
          started_at_ms: meetingContextById[session_id].startedAtMs,
          max_minutes: meetingContextById[session_id].maxMinutes,
          participant_count:
            meetingContextById[session_id].participantNames?.length ?? 0,
          knowledge_base_folder: meetingContextById[session_id].knowledgeBaseFolder,
          current_chapter_id: status.currentChapter?.id,
          current_chapter_index: status.chapterIndex,
          chapter_prompt: status.chapterPrompt,
        };
      },
    }),
    tool({
      name: 'get_meeting_status',
      description:
        'Returns current chapter, timing, and a suggested next step from meeting context.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Meeting/session id (default "cake_meeting").',
          },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { session_id } = input as { session_id?: string };
        const id = session_id || 'cake_meeting';
        const now = Date.now();
        meetingContextById[id] = meetingContextById[id] || {};
        if (!meetingContextById[id].scenario) {
          meetingContextById[id].scenario = normalizeScenario(
            undefined,
            meetingContextById[id].maxMinutes ?? DEFAULT_MAX_MINUTES,
          );
        }
        if (!meetingContextById[id].startedAtMs) {
          meetingContextById[id].startedAtMs = now;
        }
        if (!meetingContextById[id].chapterStartMs) {
          meetingContextById[id].chapterStartMs = meetingContextById[id].startedAtMs;
        }
        const status = getMeetingStatusPayload(meetingContextById[id], now);
        return {
          session_id: id,
          scenario_title: status.scenario.title,
          scenario_summary: status.scenario.summary || '',
          total_minutes: status.totalMinutes,
          elapsed_minutes: status.elapsedMinutes,
          remaining_minutes: status.remainingMinutes,
          chapter_index: status.chapterIndex,
          current_chapter: status.currentChapter,
          chapter_prompt: status.chapterPrompt,
          chapter_elapsed_minutes: status.chapterElapsedMinutes,
          chapter_remaining_minutes: status.chapterRemainingMinutes,
          behind_by_minutes: status.behindByMinutes,
          suggested_chapter_index: status.suggestedChapterIndex,
          suggested_chapter_id:
            status.scenario.chapters[status.suggestedChapterIndex]?.id || '',
          should_advance: status.shouldAdvance,
          next_chapter: status.nextChapter,
          next_chapter_prompt: status.nextChapterPrompt,
        };
      },
    }),
    tool({
      name: 'advance_chapter',
      description:
        'Advance to the next chapter (or jump to a chapter id) and return updated meeting status.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          reason: { type: 'string' },
          target_chapter_id: {
            type: 'string',
            description: 'Optional chapter id to jump to.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { session_id, target_chapter_id } = input as {
          session_id?: string;
          target_chapter_id?: string;
        };
        const id = session_id || 'cake_meeting';
        const now = Date.now();
        meetingContextById[id] = meetingContextById[id] || {};
        const ctx = meetingContextById[id];
        const scenario = normalizeScenario(ctx.scenario, ctx.maxMinutes);
        ctx.scenario = scenario;
        const currentIndex = clampChapterIndex(
          scenario,
          ctx.chapterIndex ?? 0,
        );
        const targetIndex = target_chapter_id
          ? getChapterIndexById(scenario, target_chapter_id)
          : null;
        ctx.chapterIndex =
          targetIndex !== null ? targetIndex : clampChapterIndex(
            scenario,
            currentIndex + 1,
          );
        ctx.chapterStartMs = now;
        const status = getMeetingStatusPayload(ctx, now);
        return {
          session_id: id,
          chapter_index: status.chapterIndex,
          current_chapter: status.currentChapter,
          chapter_prompt: status.chapterPrompt,
          chapter_start_ms: ctx.chapterStartMs,
        };
      },
    }),
    tool({
      name: 'set_chapter',
      description:
        'Set the current chapter by id or index and return updated meeting status.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          chapter_id: { type: 'string' },
          chapter_index: { type: 'number' },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { session_id, chapter_id, chapter_index } = input as {
          session_id?: string;
          chapter_id?: string;
          chapter_index?: number;
        };
        const id = session_id || 'cake_meeting';
        const now = Date.now();
        meetingContextById[id] = meetingContextById[id] || {};
        const ctx = meetingContextById[id];
        const scenario = normalizeScenario(ctx.scenario, ctx.maxMinutes);
        ctx.scenario = scenario;
        const byId = getChapterIndexById(scenario, chapter_id);
        const idx =
          byId !== null
            ? byId
            : typeof chapter_index === 'number'
            ? chapter_index
            : ctx.chapterIndex ?? 0;
        ctx.chapterIndex = clampChapterIndex(scenario, idx);
        ctx.chapterStartMs = now;
        const status = getMeetingStatusPayload(ctx, now);
        return {
          session_id: id,
          chapter_index: status.chapterIndex,
          current_chapter: status.currentChapter,
          chapter_prompt: status.chapterPrompt,
          chapter_start_ms: ctx.chapterStartMs,
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
    if (!ctx.scenario) {
      ctx.scenario = normalizeScenario(ctx.scenario, ctx.maxMinutes);
    }
    if (!ctx.chapterStartMs) ctx.chapterStartMs = ctx.startedAtMs;

    const status = getMeetingStatusPayload(ctx, now);
    const scenarioText = buildScenarioBlock(status.scenario);

    const response = await callResponses({
      model: SCENARIO_PLANNER_MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: scenarioPlannerPrompt,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                `Scenario:\n${scenarioText}\n\n` +
                `Current chapter: ${status.currentChapter?.id || ''}\n` +
                `Chapter prompt: ${status.chapterPrompt}\n\n` +
                `elapsed_minutes: ${status.elapsedMinutes}\n` +
                `remaining_minutes: ${status.remainingMinutes}\n` +
                `max_session_minutes: ${status.totalMinutes}\n\n` +
                `Conversation summary so far:\n${conversation_summary}\n\n` +
                `Last user/group message:\n${last_user_utterance}`,
            },
          ],
        },
      ],
    });

    return {
      elapsed_minutes: status.elapsedMinutes,
      remaining_minutes: status.remainingMinutes,
      max_session_minutes: status.totalMinutes,
      current_chapter_id: status.currentChapter?.id || '',
      chapter_prompt: status.chapterPrompt,
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

  const id = 'cake_meeting';
  meetingContextById[id] = meetingContextById[id] || {};
  const ctx = meetingContextById[id];

  const snippetText =
    (transcript_snippet || '').trim() ||
    getTranscriptSnippetText('cake_meeting', 12);

  const fallbackNames =
    ctx.participantNames || [];
  const resolvedNames =
    participant_names && participant_names.length
      ? participant_names
      : fallbackNames;
  const namesText =
    resolvedNames.length > 0
      ? `Known participants: ${resolvedNames.join(', ')}.`
      : 'Known participants: (none explicitly provided).';
  const onboardingProfiles = ctx.onboardingProfiles || [];
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

  const recentRealtime = ctx.recentRealtimeTranscript || '';
  const existingSummary =
    ctx.rollingSummary ||
    ctx.lastParticipantBrief ||
    '';

  if (
    snippetText &&
    ctx.lastParticipantInsightSnippet === snippetText &&
    ctx.participantInsightsHistory?.length
  ) {
    return {
      cached: true,
      rolling_summary: existingSummary,
      recent_realtime: recentRealtime,
      ...(ctx.participantInsightsHistory[ctx.participantInsightsHistory.length - 1] || {}),
    };
  }

  const response = await callResponses({
    model: PARTICIPANT_EXPERIENCE_MODEL,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `${participantExperiencePrompt}

Include a "rolling_summary" field (short paragraph) and "recent_highlights" (1-3 bullets).`
              .replace("{NAMES_TEXT}", namesText)
              .replace("{ONBOARDING_TEXT}", onboardingText),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              `Existing summary:\n${existingSummary || '(none)'}\n\n` +
              `Recent live transcript (rough):\n${recentRealtime || '(none)'}\n\n` +
              `Diarised transcript (more accurate):\n${snippetText || '(none)'}\n\n` +
              'Update the rolling summary and participant insights.',
          },
        ],
      },
    ],
  });

  const outputText =
    response?.output
      ?.find((i: any) => i.type === 'message' && i.role === 'assistant')
      ?.content?.find((c: any) => c.type === 'output_text')?.text ?? '';
  let output: any = null;
  try {
    output = outputText ? JSON.parse(outputText) : null;
  } catch {
    output = null;
  }
  if (!output) {
    output = { raw_text: outputText || response };
  }

  // cache for quick recall
  const history = ctx.participantInsightsHistory || [];
  history.push(output);
  ctx.participantInsightsHistory = history.slice(-5);
  ctx.lastParticipantInsightSnippet = snippetText;

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
    ctx.lastParticipantBrief = brief;
  }

  if (output.rolling_summary || output.summary) {
    ctx.rollingSummary = output.rolling_summary || output.summary;
  }

  return output;
},
    }),

    // 3) Knowledge base – “give me facts or guidance”
    tool({
      name: 'knowledge_base',
      description:
        'Consults the knowledge base (and web if needed) to answer a question for the host.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Question or task the host needs answered.',
          },
          context: {
            type: 'string',
            description: 'Optional extra context (session goal, constraints, etc).',
          },
          knowledge_base_folder: {
            type: 'string',
            description:
              'Optional knowledge base folder override (defaults to active session setup).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { query, context, knowledge_base_folder } = input as {
          query: string;
          context?: string;
          knowledge_base_folder?: string;
        };

        const meetingFolder =
          meetingContextById['cake_meeting']?.knowledgeBaseFolder;
        const folder =
          knowledge_base_folder ||
          meetingFolder ||
          setup?.knowledgeBaseFolder ||
          'default-session-setup';
        let files: Array<{ name: string; content?: string }> = [];
        try {
          const kbResp = await fetch(
            `/api/knowledge-base?folder=${encodeURIComponent(folder)}&include=content&max=6`,
          );
          const kbData = await kbResp.json();
          if (kbResp.ok) {
            files = kbData.files || [];
          }
        } catch {
          files = [];
        }

        const docsBlock = files.length
          ? files
              .map((f) =>
                `# ${f.name}\n${(f.content || '').trim()}`.trim(),
              )
              .filter(Boolean)
              .join('\n\n')
          : 'No knowledge base documents available.';

        const response = await callResponses({
          model: REFERENCE_KNOWLEDGE_MODEL,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: knowledgeBasePrompt }],
            },
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: `Knowledge base documents:\n${docsBlock}`,
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: context ? `${query}\n\nContext: ${context}` : query,
                },
              ],
            },
          ],
          tools: [{ type: 'web_search' }],
          tool_choice: 'auto',
        });

        return response.output ?? response;
      },
    }),
  ],

  handoffs: [], // <- keeps it impossible to switch to another agent
});
}

export const hostVoiceAgent = buildHostVoiceAgent();

export const setMeetingChapterOverride = (
  sessionId: string,
  chapterIndex: number,
  scenario?: MeetingScenario,
) => {
  const now = Date.now();
  meetingContextById[sessionId] = meetingContextById[sessionId] || {};
  const ctx = meetingContextById[sessionId];
  if (scenario) {
    ctx.scenario = normalizeScenario(scenario, scenario.totalMinutes);
  }
  if (!ctx.scenario) {
    ctx.scenario = normalizeScenario(undefined, ctx.maxMinutes);
  }
  if (!ctx.startedAtMs) ctx.startedAtMs = now;
  if (!ctx.maxMinutes) {
    ctx.maxMinutes = ctx.scenario.totalMinutes ?? DEFAULT_MAX_MINUTES;
  }
  ctx.chapterIndex = clampChapterIndex(ctx.scenario, chapterIndex);
  ctx.chapterStartMs = now;
  return getMeetingStatusPayload(ctx, now);
};

export const setMeetingParticipants = (
  sessionId: string,
  participantNames: string[],
) => {
  meetingContextById[sessionId] = meetingContextById[sessionId] || {};
  meetingContextById[sessionId].participantNames = participantNames;
  return {
    session_id: sessionId,
    participant_count: participantNames.length,
  };
};

export const setMeetingKnowledgeBaseFolder = (
  sessionId: string,
  folder: string,
) => {
  meetingContextById[sessionId] = meetingContextById[sessionId] || {};
  meetingContextById[sessionId].knowledgeBaseFolder = folder;
  return {
    session_id: sessionId,
    knowledge_base_folder: folder,
  };
};

export const setMeetingRealtimeSnippet = (
  sessionId: string,
  transcriptText: string,
) => {
  meetingContextById[sessionId] = meetingContextById[sessionId] || {};
  meetingContextById[sessionId].recentRealtimeTranscript = transcriptText;
  return {
    session_id: sessionId,
    transcript_length: transcriptText.length,
  };
};

export const setMeetingParticipantSummary = (
  sessionId: string,
  summary: string,
) => {
  meetingContextById[sessionId] = meetingContextById[sessionId] || {};
  meetingContextById[sessionId].rollingSummary = summary;
  meetingContextById[sessionId].lastParticipantBrief = summary;
  meetingContextById[sessionId].lastParticipantInsightAt = Date.now();
  return {
    session_id: sessionId,
    summary_length: summary.length,
  };
};
