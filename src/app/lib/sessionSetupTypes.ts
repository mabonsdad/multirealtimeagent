export type SessionSetupPrompts = {
  hostVoiceInstructions: string;
  scenarioPlannerSystemPrompt: string;
  participantExperienceSystemPrompt: string;
  knowledgeBaseSystemPrompt: string;
  onboardingInstructions: string;
};

export type SessionSetupVoices = {
  hostVoice?: string;
  onboarding?: string;
};

export type SessionSetupChapter = {
  id: string;
  title?: string;
  goal?: string;
  targetMinutes?: number;
  hostPrompt?: string;
  toolCadence?: string;
  notes?: string;
};

export type SessionSetupScenario = {
  title: string;
  summary?: string;
  totalMinutes?: number;
  chapters: SessionSetupChapter[];
};

export type SessionSetupConfig = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  prompts: SessionSetupPrompts;
  voices?: SessionSetupVoices;
  knowledgeBaseFolder?: string;
  scenario?: SessionSetupScenario;
};

export type SessionSetupSummary = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};
