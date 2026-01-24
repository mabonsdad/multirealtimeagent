export type SessionSetupPrompts = {
  hostVoiceInstructions: string;
  scenarioPlannerSystemPrompt: string;
  participantExperienceSystemPrompt: string;
  cakeOptionsSystemPrompt: string;
  onboardingInstructions: string;
};

export type SessionSetupVoices = {
  hostVoice?: string;
  onboarding?: string;
};

export type SessionSetupConfig = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  prompts: SessionSetupPrompts;
  voices?: SessionSetupVoices;
};

export type SessionSetupSummary = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};
