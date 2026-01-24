import type { SessionSetupConfig } from "./sessionSetupTypes";
import {
  DEFAULT_CAKE_OPTIONS_PROMPT,
  DEFAULT_HOST_VOICE,
  DEFAULT_HOST_VOICE_INSTRUCTIONS,
  DEFAULT_PARTICIPANT_EXPERIENCE_PROMPT,
  DEFAULT_SCENARIO_PLANNER_PROMPT,
} from "@/app/agentConfigs/agentSupervisorFacilitatedConversation/hostVoice";
import {
  DEFAULT_ONBOARDING_INSTRUCTIONS,
  DEFAULT_ONBOARDING_VOICE,
} from "@/app/agentConfigs/onboardingProfile";

export const DEFAULT_SESSION_SETUP_ID = "default";

export const DEFAULT_SESSION_SETUP_CONFIG: SessionSetupConfig = {
  id: DEFAULT_SESSION_SETUP_ID,
  name: "Default Session Setup",
  description: "Built-in prompts for host, tools, and onboarding.",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  prompts: {
    hostVoiceInstructions: DEFAULT_HOST_VOICE_INSTRUCTIONS,
    scenarioPlannerSystemPrompt: DEFAULT_SCENARIO_PLANNER_PROMPT,
    participantExperienceSystemPrompt: DEFAULT_PARTICIPANT_EXPERIENCE_PROMPT,
    cakeOptionsSystemPrompt: DEFAULT_CAKE_OPTIONS_PROMPT,
    onboardingInstructions: DEFAULT_ONBOARDING_INSTRUCTIONS,
  },
  voices: {
    hostVoice: DEFAULT_HOST_VOICE,
    onboarding: DEFAULT_ONBOARDING_VOICE,
  },
};
