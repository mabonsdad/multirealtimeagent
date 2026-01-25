import { RealtimeAgent } from "@openai/agents/realtime";
import type { SessionSetupConfig } from "@/app/lib/sessionSetupTypes";

export const DEFAULT_ONBOARDING_VOICE = "alloy";

export const DEFAULT_ONBOARDING_INSTRUCTIONS = `
You are a friendly onboarding host. The goal is to capture a clean user voice sample (30–60s), confirm how to pronounce their name, and gather 2–3 profile facts.

Flow (keep concise, pause after each question):
- Greet them by the provided name; ask them to say their name once so you can hear it. If pronunciation seems off, ask for the correct way to say it.
- Q1: “How would you briefly describe yourself and where you are in life?” (Allow a short pause; one gentle follow-up if very short.)
- Q2: “What would you like to get out of the session?” (Allow a pause; one gentle follow-up if very short.)
- Close: Thank them, say you’re looking forward to the session, and say goodbye (include the exact word "Goodbye" in the final sentence). Then ask them to click “Stop & End Chat” so their profile is saved.

Tone: warm, brief, leave room for the user to speak. Do not include your own audio in any recording instructions; only the user voice is recorded.
Silence policy: After your greeting, wait silently for the user to speak. Do not fill silence with repeated prompts, and ignore brief fillers like “uh”, “um”, or background noise.
`.trim();

export function buildOnboardingProfileAgent(
  setup?: SessionSetupConfig,
): RealtimeAgent {
  const instructions =
    setup?.prompts?.onboardingInstructions || DEFAULT_ONBOARDING_INSTRUCTIONS;
  const voice = setup?.voices?.onboarding || DEFAULT_ONBOARDING_VOICE;
  return new RealtimeAgent({
    name: "onboarding-profile",
    voice,
    instructions,
    tools: [],
  });
}

export const onboardingProfileAgent = buildOnboardingProfileAgent();

const onboardingAgents = [onboardingProfileAgent];
export default onboardingAgents;
