// src/app/agentConfigs/groupFacilitatedConversation/index.ts
import { hostVoiceAgent } from './hostVoice';
import { scenarioPlannerAgent } from './scenarioPlanner';
import { participantExperienceAgent } from './participantExperience';
import { referenceKnowledgeAgent } from './referenceKnowledge';

// Wire up handoffs (who can transfer to whom).
// Cast to `any` to satisfy TS like in customerServiceRetail.
(hostVoiceAgent.handoffs as any).push(
  scenarioPlannerAgent,
  participantExperienceAgent,
  referenceKnowledgeAgent,
);

(scenarioPlannerAgent.handoffs as any).push(
  hostVoiceAgent,
  participantExperienceAgent,
  referenceKnowledgeAgent,
);

(participantExperienceAgent.handoffs as any).push(
  hostVoiceAgent,
  scenarioPlannerAgent,
  referenceKnowledgeAgent,
);

(referenceKnowledgeAgent.handoffs as any).push(
  hostVoiceAgent,
  scenarioPlannerAgent,
  participantExperienceAgent,
);

// Export in the same way as customerServiceRetailScenario
export const groupFacilitatedConversationScenario = [
  hostVoiceAgent,
  scenarioPlannerAgent,
  participantExperienceAgent,
  referenceKnowledgeAgent,
];
