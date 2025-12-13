// src/app/agentConfigs/index.ts
import type { RealtimeAgent } from '@openai/agents/realtime';

import { simpleHandoffScenario } from './simpleHandoff';
import { customerServiceRetailScenario } from './customerServiceRetail';
import { chatSupervisorScenario } from './chatSupervisor';
import { groupFacilitatedConversationScenario } from './groupFacilitatedConversation';
import { agentSupervisorFacilitatedConversationScenario } from './agentSupervisorFacilitatedConversation';


export const allAgentSets: Record<string, RealtimeAgent[]> = {
  simpleHandoff: simpleHandoffScenario,
  customerServiceRetail: customerServiceRetailScenario,
  chatSupervisor: chatSupervisorScenario,

  // ⬇️ NEW scenario key
  groupFacilitatedConversation: groupFacilitatedConversationScenario,
  agentSupervisorFacilitatedConversation: agentSupervisorFacilitatedConversationScenario 

};

// Optional: set the default to your new scenario
export const defaultAgentSetKey = 'agentSupervisorFacilitatedConversation';
