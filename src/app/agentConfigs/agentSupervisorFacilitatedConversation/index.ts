// src/app/agentConfigs/groupFacilitatedConversation/index.ts
import type { SessionSetupConfig } from '@/app/lib/sessionSetupTypes';
import { buildHostVoiceAgent, hostVoiceAgent } from './hostVoice';

// For this scenario, the host is the only “visible” agent.
// Other roles are called via tools from the host, not via handoffs.
export const agentSupervisorFacilitatedConversationScenario = [
  hostVoiceAgent,
];

export const buildAgentSupervisorScenario = (
  setup?: SessionSetupConfig,
) => [buildHostVoiceAgent(setup)];
