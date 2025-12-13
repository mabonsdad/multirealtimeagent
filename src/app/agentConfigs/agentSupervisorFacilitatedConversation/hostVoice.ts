// src/app/agentConfigs/agentSupervisorFacilitatedConversation/hostVoice.ts
import { RealtimeAgent, tool } from '@openai/agents/realtime';

// Optional: different models for the “sub-roles”
const SCENARIO_PLANNER_MODEL = 'gpt-4.1-mini';
const PARTICIPANT_EXPERIENCE_MODEL = 'gpt-4.1-mini';
const REFERENCE_KNOWLEDGE_MODEL = 'gpt-4.1-mini';

export const hostVoiceAgent = new RealtimeAgent({
  name: 'hostVoiceAgent',
  voice: 'ash',
  handoffDescription:
    'Main host that talks to the group, guides the cake decision, and silently calls planner/participant/knowledge tools when needed.',

  instructions: `
You are the *Host* voice agent for a live group meeting about choosing a cake
for afternoon tea today.

==== Goal of the meeting ====
1) Welcome the group and clearly state the goal: choose a cake for this afternoon's tea.
2) Get everyone's general feelings about cake.
3) Learn what each person LIKES and DISLIKES about cake
   (flavours, textures, ingredients, dietary needs).
4) Help them decide on ONE primary cake choice that:
   - fits the group,
   - avoids things individuals strongly dislike or cannot eat.
5) Challenge them to choose a BACKUP cake in case the shop is out of the first choice.
6) Finally, clearly restate:
   - the primary cake,
   - the backup cake,
   - any key constraints (e.g. "no nuts", "vegan", "gluten-free").

==== Other roles (used via tools only) ====
You call internal tools that talk to:
- a *scenario planner*,
- a *participant experience* analyst,
- a *reference knowledge* cake expert.

You NEVER mention these tools or roles to participants.
They are purely backstage helpers.

You decide when to call tools:
- Sometimes right after a user speaks (e.g. they ask for options).
- Sometimes proactively, to prepare for your next turn.

When a tool returns JSON-like data:
- Treat it as internal guidance.
- Convert it into natural, friendly speech or questions.
- NEVER read raw JSON to participants.

==== Style ====
- Warm, inclusive, a little playful, but respectful.
- Keep your spoken turns short; ask direct questions.
- Frequently summarise.
- Make sure quieter people get a chance to speak.

==== Safety / constraints ====
- Never invent allergies or restrictions; only repeat what participants say.
- Respect dietary needs (vegan, gluten-free, nut allergy, etc.) in all suggestions.

Your voice is the only one the group ever hears.
All tools are used silently behind the scenes.
`,

  tools: [
    // 1) Scenario planner – “what should I do next?”
    tool({
      name: 'plan_meeting_step',
      description:
        'Consults a scenario-planner role to decide the current phase and what the host should focus on next.',
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
        },
        required: ['conversation_summary', 'last_user_utterance'],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { conversation_summary, last_user_utterance } = input as {
          conversation_summary: string;
          last_user_utterance: string;
        };

        // Lightweight heuristic to avoid external calls.
        const hasChoices = /cake|option|choose|pick/i.test(conversation_summary);
        const phase = hasChoices
          ? 'propose_primary_cake_options'
          : 'collect_likes_and_dislikes';

        return {
          scenario_phase: phase,
          should_switch_phase: false,
          host_focus: hasChoices
            ? 'Guide toward primary and backup cakes'
            : 'Elicit likes, dislikes, and constraints',
          host_prompts: hasChoices
            ? [
                'Would you like something fruity, chocolatey, or creamy as the main cake?',
                'Should we also pick a nut-free backup option?',
              ]
            : [
                'Any flavours or textures you really enjoy?',
                'Anything we should avoid for allergies or strong dislikes?',
              ],
          notes_for_host: [
            'Keep turns short; recap frequently.',
            'Invite quieter people to share preferences.',
          ],
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
        },
        required: ['transcript_snippet'],
        additionalProperties: false,
      },
      async execute(input: any) {
        const { transcript_snippet } = input as { transcript_snippet: string };
        // Simple parser for names/likes/dislikes keywords; heuristic only.
        const lower = transcript_snippet.toLowerCase();
        const hasNutConcern = /nut|peanut|allergy/.test(lower);
        const likesChocolate = /chocolate/.test(lower);
        const likesCitrus = /lemon|citrus|orange/.test(lower);

        const participants = [
          {
            id: 'group',
            has_spoken: true,
            likes: [
              likesChocolate ? 'chocolate' : undefined,
              likesCitrus ? 'citrus' : undefined,
            ].filter(Boolean) as string[],
            dislikes: [],
            constraints: hasNutConcern ? ['no nuts'] : [],
            summary: 'Group preferences gathered so far.',
          },
        ];

        return {
          participants,
          group_summary: {
            common_likes: participants[0].likes,
            common_dislikes: participants[0].dislikes,
            constraints_to_respect: participants[0].constraints,
            candidate_cake_directions: [
              likesChocolate ? 'chocolate or black forest' : 'vanilla or fruit',
            ],
          },
          suggestions_for_host: [
            'Invite anyone who has not shared to mention likes/dislikes.',
            hasNutConcern ? 'Confirm nut-free options.' : 'Ask about allergies.',
          ],
        };
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

        const lower = preferences_summary.toLowerCase();
        const avoidsNuts = /nut|peanut/.test(lower);
        const likesChocolate = /chocolate/.test(lower);
        const likesFruit = /fruit/.test(lower);
        const avoidGluten = /flour|gluten/.test(lower);

        const options = [
          {
            name: likesChocolate ? 'Chocolate fudge cake' : 'Vanilla sponge with berries',
            summary: likesChocolate
              ? 'Rich chocolate sponge with ganache.'
              : 'Light vanilla sponge topped with fresh berries.',
            common_allergens: ['gluten', 'eggs', 'dairy'],
            good_for: likesChocolate ? ['chocolate fans'] : ['fruit lovers'],
            avoid_if: avoidsNuts ? [] : ['nut allergy (if toppings include nuts)'],
          },
          {
            name: avoidGluten ? 'Pistachio and Respberry cake' : 'Carrot Cake',
            summary: avoidGluten
              ? 'Raspberry topped nutty cake.'
              : 'Moist Carrot cake with creamcheese icing and walnuts.',
            common_allergens: ['nuts', 'eggs', 'dairy'],
            good_for: avoidGluten ? ['chocolate fans'] : ['fruit lovers'],
            avoid_if: avoidsNuts ? [] : ['nut allergy (as used to avoid flour)'],
          },
          {
            name: avoidsNuts ? 'Lemon drizzle (nut-free)' : 'Carrot cake',
            summary: avoidsNuts
              ? 'Zesty lemon sponge with syrup, prepared nut-free.'
              : 'Moist spiced carrot cake with cream cheese frosting.',
            common_allergens: ['gluten', 'eggs', 'dairy'],
            good_for: ['afternoon tea', 'classic flavours'],
            avoid_if: avoidsNuts ? ['dislike of citrus'] : ['dislike of spice'],
          },
          {
            name: likesFruit ? 'Blueberry Cake (nut-free)' : 'Apple Cake',
            summary: likesFruit
              ? 'Sweet bkueberry cak with cream cheese icing.'
              : 'Healthy wholemeal apple cake with a brown sugar crust.',
            common_allergens: ['gluten', 'eggs', 'dairy'],
            good_for: likesFruit ? ['fruit fans'] : ['jam lovers'],
            avoid_if: avoidGluten ? ['dislike of fruit'] : ['dislike jam filling'],
          },
        ];

        return {
          candidate_cakes: options,
          notes_for_host: [
            `Purpose: ${purpose}`,
            avoidsNuts ? 'Keep options nut-free.' : 'Check for any allergies before serving.',
          ],
        };
      },
    }),
  ],

  handoffs: [], // Host is the only “speaking” agent
});
