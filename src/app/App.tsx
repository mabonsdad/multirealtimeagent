"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import BottomToolbar from "./components/BottomToolbar";
import FullTranscript from "./components/FullTranscript";
import ProfileManagerModal from "./components/ProfileManagerModal";
import SessionSetupModal from "./components/SessionSetupModal";

// Types
import { SessionStatus } from "@/app/types";
import type { RealtimeAgent } from '@openai/agents/realtime';

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useRealtimeSession } from "./hooks/useRealtimeSession";
import { createModerationGuardrail } from "@/app/agentConfigs/guardrails";
import { useRollingTranscription, FULL_TRANSCRIPT_CHUNK_MS, FULL_TRANSCRIPT_HOP_MS } from "./hooks/useRollingTranscription";
import useAudioDownload from "./hooks/useAudioDownload";
import { useHandleSessionHistory } from "./hooks/useHandleSessionHistory";
import type { SessionSetupConfig } from "@/app/lib/sessionSetupTypes";
import { DEFAULT_SESSION_SETUP_CONFIG } from "@/app/lib/sessionSetupDefaults";
import { getTranscriptSnippetText } from "@/app/lib/transcriptStore";
import { setBackgroundBrief } from "@/app/lib/participantBriefStore";
import type { ProfileRecord } from "@/app/lib/profileTypes";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import { customerServiceRetailScenario } from "@/app/agentConfigs/customerServiceRetail";
import { chatSupervisorScenario } from "@/app/agentConfigs/chatSupervisor";
import { customerServiceRetailCompanyName } from "@/app/agentConfigs/customerServiceRetail";
import { chatSupervisorCompanyName } from "@/app/agentConfigs/chatSupervisor";
import { simpleHandoffScenario } from "@/app/agentConfigs/simpleHandoff";
import { groupFacilitatedConversationScenario } from "@/app/agentConfigs/groupFacilitatedConversation";
import {
  agentSupervisorFacilitatedConversationScenario,
  buildAgentSupervisorScenario,
} from "@/app/agentConfigs/agentSupervisorFacilitatedConversation";
import {
  setMeetingChapterOverride,
  setMeetingKnowledgeBaseFolder,
  setMeetingParticipants,
  setMeetingParticipantSummary,
  setMeetingRealtimeSnippet,
} from "@/app/agentConfigs/agentSupervisorFacilitatedConversation/hostVoice";

// Map used by connect logic for scenarios defined via the SDK.
const sdkScenarioMap: Record<string, RealtimeAgent[]> = {
  simpleHandoff: simpleHandoffScenario,
  customerServiceRetail: customerServiceRetailScenario,
  chatSupervisor: chatSupervisorScenario,
  groupFacilitatedConversation: groupFacilitatedConversationScenario,
  agentSupervisorFacilitatedConversation: agentSupervisorFacilitatedConversationScenario,
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "session-setup";

const normalizeSessionSetupConfig = (config: SessionSetupConfig) => {
  const prompts = config.prompts || DEFAULT_SESSION_SETUP_CONFIG.prompts;
  const legacyCakePrompt = (prompts as any).cakeOptionsSystemPrompt;
  const mergedPrompts = {
    ...DEFAULT_SESSION_SETUP_CONFIG.prompts,
    ...prompts,
    knowledgeBaseSystemPrompt:
      prompts.knowledgeBaseSystemPrompt ||
      legacyCakePrompt ||
      DEFAULT_SESSION_SETUP_CONFIG.prompts.knowledgeBaseSystemPrompt,
  };
  return {
    ...DEFAULT_SESSION_SETUP_CONFIG,
    ...config,
    prompts: mergedPrompts,
    knowledgeBaseFolder:
      config.knowledgeBaseFolder ||
      slugify(config.name || config.id || "session-setup"),
  };
};

function App() {
  const searchParams = useSearchParams()!;

  // ---------------------------------------------------------------------
  // Codec selector – lets you toggle between wide-band Opus (48 kHz)
  // and narrow-band PCMU/PCMA (8 kHz) to hear what the agent sounds like on
  // a traditional phone line and to validate ASR / VAD behaviour under that
  // constraint.
  //
  // We read the `?codec=` query-param and rely on the `changePeerConnection`
  // hook (configured in `useRealtimeSession`) to set the preferred codec
  // before the offer/answer negotiation.
  // ---------------------------------------------------------------------
  const urlCodec = searchParams.get("codec") || "opus";

  // Agents SDK doesn't currently support codec selection so it is now forced 
  // via global codecPatch at module load 

  const {
    transcriptItems,
    addTranscriptMessage,
    addTranscriptBreadcrumb,
  } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    RealtimeAgent[] | null
  >(null);
  const [sessionSetupConfig, setSessionSetupConfig] =
    useState<SessionSetupConfig>(DEFAULT_SESSION_SETUP_CONFIG);
  const knowledgeBaseFolder = useMemo(
    () =>
      sessionSetupConfig.knowledgeBaseFolder ||
      slugify(sessionSetupConfig.name || sessionSetupConfig.id || "session-setup"),
    [
      sessionSetupConfig.knowledgeBaseFolder,
      sessionSetupConfig.name,
      sessionSetupConfig.id,
    ],
  );
  const [isSessionSetupModalOpen, setIsSessionSetupModalOpen] =
    useState<boolean>(false);
  const [isAITalkHeld, setIsAITalkHeld] = useState(false);
  const [backgroundBrief, setBackgroundBriefState] = useState<string>("");
  const [backgroundBriefAt, setBackgroundBriefAt] = useState<string>("");
  const [meetingNotes, setMeetingNotes] = useState<string>("");
  const [meetingNotesAt, setMeetingNotesAt] = useState<string>("");
  const [manualChapterIndex, setManualChapterIndex] = useState<number | null>(
    null,
  );
  const [manualChapterAt, setManualChapterAt] = useState<number | null>(null);

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  // Ref to identify whether the latest agent switch came from an automatic handoff
  const handoffTriggeredRef = useRef(false);
  const greetingGateRef = useRef(false);
  const aiFirstUtteranceLockRef = useRef(false);
  const aiTalkStartMsRef = useRef<number | null>(null);
  const backgroundInsightsBusyRef = useRef(false);
  const lastDiarisedSnippetRef = useRef<string>("");
  const lastRealtimeSnippetRef = useRef<string>("");
  const lastParticipantSummaryRef = useRef<string>("");
  const lastParticipantsUpdateRef = useRef<string>("");
  const lastHostNotesInjectedRef = useRef<string>("");

  const sdkAudioElement = React.useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }, []);

  // Attach SDK audio element once it exists (after first render in browser)
  useEffect(() => {
    if (sdkAudioElement && !audioElementRef.current) {
      audioElementRef.current = sdkAudioElement;
    }
  }, [sdkAudioElement]);

  // Prefer captureStream to ensure we record what is actually played.
  const getPlaybackStream = useCallback((): MediaStream | null => {
    const el = audioElementRef.current;
    if (!el) return null;
    const srcObj = el.srcObject as MediaStream | null;
    if (srcObj && srcObj.getAudioTracks().length > 0) {
      return srcObj;
    }
    try {
      if (typeof (el as any).captureStream === "function") {
        return (el as any).captureStream() as MediaStream;
      }
      if (typeof (el as any).mozCaptureStream === "function") {
        return (el as any).mozCaptureStream() as MediaStream;
      }
    } catch (err) {
      console.warn("captureStream failed, falling back to srcObject", err);
    }
    return srcObj || null;
  }, []);

  const {
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    interrupt,
    mute,
    setMicEnabled,
  } = useRealtimeSession({
    onConnectionChange: (s) => setSessionStatus(s as SessionStatus),
    onAgentHandoff: (agentName: string) => {
      handoffTriggeredRef.current = true;
      setSelectedAgentName(agentName);
    },
  });

  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");
  const [selectedProfiles, setSelectedProfiles] = useState<ProfileRecord[]>([]);
  const [sessionStartMs, setSessionStartMs] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hasSentMeetingConfig, setHasSentMeetingConfig] = useState(false);

  const participantNames = useMemo(
    () =>
      selectedProfiles
        .map((p) => p.speakerName)
        .filter((name): name is string => Boolean(name)),
    [selectedProfiles],
  );

  const [isProfileModalOpen, setIsProfileModalOpen] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(
    () => {
      if (typeof window === 'undefined') return true;
      const stored = localStorage.getItem('audioPlaybackEnabled');
      return stored ? stored === 'true' : true;
    },
  );
  const [isMicMuted, setIsMicMuted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const stored = localStorage.getItem('micMuted');
    return stored ? stored === 'true' : false;
  });
  const {
    handleAudioChunk,
    speakerBlocks,
    speakerLabels,
    hasPending,
    error: transcriptionError,
  } = useRollingTranscription(sessionId);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = useCallback((eventObj: any, eventNameSuffix = "") => {
    try {
      sendEvent(eventObj);
      logClientEvent(eventObj, eventNameSuffix);
    } catch (err) {
      console.error('Failed to send via SDK', err);
    }
  }, [sendEvent, logClientEvent]);

  useHandleSessionHistory();

  useEffect(() => {
    setMeetingParticipants("cake_meeting", participantNames);

    if (sessionStatus !== "CONNECTED") return;
    const participantsText = participantNames.length
      ? participantNames.join(", ")
      : "(none)";
    if (participantsText === lastParticipantsUpdateRef.current) return;
    lastParticipantsUpdateRef.current = participantsText;
    const id = uuidv4().slice(0, 32);
    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `[PARTICIPANTS UPDATE]\n${participantsText}\n[/PARTICIPANTS UPDATE]`,
            },
          ],
        },
      },
      "participants_update",
    );
  }, [participantNames, sessionStatus, sendClientEvent]);

  useEffect(() => {
    if (!knowledgeBaseFolder) return;
    setMeetingKnowledgeBaseFolder("cake_meeting", knowledgeBaseFolder);
  }, [knowledgeBaseFolder]);

  const BACKGROUND_INSIGHTS_INTERVAL_MS = 15000;
  const BACKGROUND_SNIPPET_MAX = 50;
  const BACKGROUND_MIN_CHARS = 120;
  const MEETING_NOTES_INTERVAL_MS = 15000;

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    const loadActiveSetup = async () => {
      try {
        const resp = await fetch("/api/session-setup?active=1");
        const data = await resp.json();
        if (resp.ok && data?.config) {
          setSessionSetupConfig(normalizeSessionSetupConfig(data.config));
        }
      } catch (err) {
        console.warn("No active session setup found", err);
      }
    };
    loadActiveSetup();
  }, []);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(!handoffTriggeredRef.current);
      // Reset flag after handling so subsequent effects behave normally
      handoffTriggeredRef.current = false;
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isAITalkHeld]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      const now = Date.now();
      setSessionStartMs(now);
      setElapsedSeconds(0);
    } else if (sessionStatus === "DISCONNECTED") {
      setSessionStartMs(null);
      setElapsedSeconds(0);
    }
  }, [sessionStatus]);

  useEffect(() => {
    if (!sessionStartMs) return;

    const interval = setInterval(() => {
      const now = Date.now();
      setElapsedSeconds(Math.floor((now - sessionStartMs) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [sessionStartMs]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    const sessionUrl =
      process.env.NEXT_PUBLIC_SESSION_ENDPOINT || "/api/session";
    logClientEvent({ url: sessionUrl }, "fetch_session_token_request");

    try {
      const tokenResponse = await fetch(sessionUrl);
      if (!tokenResponse.ok) {
        const body = await tokenResponse.text();
        console.error("Ephemeral key fetch failed", tokenResponse.status, body);
        setSessionStatus("DISCONNECTED");
        return null;
      }

      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return null;
      }

      return data.client_secret.value;
    } catch (err) {
      console.error("Error fetching ephemeral key", err);
      setSessionStatus("DISCONNECTED");
      return null;
    }
  };

  const connectToRealtime = async () => {
    const agentSetKey = searchParams.get("agentConfig") || "default";
    const scenarioAgents =
      agentSetKey === "agentSupervisorFacilitatedConversation"
        ? buildAgentSupervisorScenario(sessionSetupConfig || DEFAULT_SESSION_SETUP_CONFIG)
        : sdkScenarioMap[agentSetKey];
    if (scenarioAgents) {
      if (sessionStatus !== "DISCONNECTED") return;
      setSessionStatus("CONNECTING");
      greetingGateRef.current =
        agentSetKey === "agentSupervisorFacilitatedConversation";

      try {
        const EPHEMERAL_KEY = await fetchEphemeralKey();
        if (!EPHEMERAL_KEY) return;

        const idForSession = sessionId ?? uuidv4();
        setSessionId(idForSession);
        setHasSentMeetingConfig(false);

        // Ensure the selectedAgentName is first so that it becomes the root
        const reorderedAgents = [...scenarioAgents];
        const idx = reorderedAgents.findIndex((a) => a.name === selectedAgentName);
        if (idx > 0) {
          const [agent] = reorderedAgents.splice(idx, 1);
          reorderedAgents.unshift(agent);
        }

        const companyNameMap: Record<string, string> = {
          customerServiceRetail: customerServiceRetailCompanyName,
          chatSupervisor: chatSupervisorCompanyName,
        };
        const companyName = companyNameMap[agentSetKey] ?? "";
        const guardrail = companyName
          ? createModerationGuardrail(companyName)
          : null;

        await connect({
          getEphemeralKey: async () => EPHEMERAL_KEY,
          initialAgents: reorderedAgents,
          audioElement: sdkAudioElement,
          outputGuardrails: guardrail ? [guardrail] : [],
          extraContext: {
            addTranscriptBreadcrumb,
          },
        });

        if (greetingGateRef.current) {
          setMicEnabled(false);
          sendClientEvent(
            { type: "input_audio_buffer.clear" },
            "greeting gate clear"
          );
        }

        if (
          agentSetKey === "agentSupervisorFacilitatedConversation" &&
          !hasSentMeetingConfig
        ) {
          const totalMinutesForConfig =
            sessionSetupConfig?.scenario?.totalMinutes ||
            DEFAULT_SESSION_SETUP_CONFIG.scenario?.totalMinutes ||
            0;
          const configText = `
[MEETING CONFIG]
session_id: ${idForSession}
duration_minutes: ${totalMinutesForConfig || "unknown"}
participants: ${participantNames.length ? participantNames.join(", ") : "unknown"}
[/MEETING CONFIG]
`.trim();

          const id = uuidv4().slice(0, 32);
          sendClientEvent(
            {
              type: "conversation.item.create",
              item: {
                id,
                type: "message",
                role: "system",
                content: [{ type: "input_text", text: configText }],
              },
            },
            "meeting_config_seed",
          );

          setHasSentMeetingConfig(true);
        }
      } catch (err) {
        console.error("Error connecting via SDK:", err);
        setSessionStatus("DISCONNECTED");
        // Clear any stale session so subsequent attempts can retry.
        disconnect();
      }
      return;
    }
  };

  const disconnectFromRealtime = () => {
    disconnect();
    setSessionStatus("DISCONNECTED");
    setHasSentMeetingConfig(false);
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent({
      type: 'conversation.item.create',
      item: {
        id,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    if (isAITalkHeld) {
      sendClientEvent({ type: 'response.create' }, '(simulated user text message)');
    }
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    // Reflect Push-to-Talk UI state by (de)activating server VAD on the
    // backend. The Realtime SDK supports live session updates via the
    // `session.update` event.
    const allowAutoResponse = !greetingGateRef.current && isAITalkHeld;
    const turnDetection = {
      type: 'server_vad',
      threshold: 0.9,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      create_response: allowAutoResponse,
    };

    sendEvent({
      type: 'session.update',
      session: {
        turn_detection: turnDetection,
      },
    });

    // Send an initial 'hi' message to trigger the agent to greet the user
    if (
      shouldTriggerResponse &&
      !isMicMuted &&
      isAITalkHeld
    ) {
      sendSimulatedUserMessage('hi');
    }
    return;
  }

  useEffect(() => {
    if (!greetingGateRef.current || sessionStatus !== "CONNECTED") return;
    const firstCompletedAssistant = transcriptItems.find(
      (t) => t.role === "assistant" && t.status === "DONE"
    );
    if (!firstCompletedAssistant) return;
    greetingGateRef.current = false;
    if (!isMicMuted) {
      setMicEnabled(true);
    }
    updateSession(false);
  }, [transcriptItems, sessionStatus, isMicMuted, setMicEnabled, updateSession]);

  useEffect(() => {
    if (!aiFirstUtteranceLockRef.current || !aiTalkStartMsRef.current) return;
    const firstAssistantDone = transcriptItems.find(
      (t) =>
        t.role === "assistant" &&
        t.status === "DONE" &&
        (t.createdAtMs || 0) >= (aiTalkStartMsRef.current || 0)
    );
    if (!firstAssistantDone) return;
    aiFirstUtteranceLockRef.current = false;
    aiTalkStartMsRef.current = null;
    if (!isMicMuted) {
      setMicEnabled(true);
    }
  }, [transcriptItems, isMicMuted, setMicEnabled]);

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    interrupt();

    try {
      sendUserText(userText.trim());
    } catch (err) {
      console.error('Failed to send via SDK', err);
    }

    setUserText("");
  };

  const computeChapterTargets = useCallback(
    (
      scenario: NonNullable<SessionSetupConfig["scenario"]>,
      totalMinutes: number,
    ) => {
      const chapters = scenario.chapters || [];
      const rawTargets = chapters.map((c) =>
        c.targetMinutes && c.targetMinutes > 0 ? c.targetMinutes : 0,
      );
      const definedSum = rawTargets.reduce((sum, v) => sum + (v || 0), 0);
      const missingCount = rawTargets.filter((v) => !v).length;
      const remaining = Math.max(totalMinutes - definedSum, 0);
      const fill = missingCount > 0 ? remaining / missingCount : 0;
      const targets = rawTargets.map((v) => (v && v > 0 ? v : fill));
      return { chapters, targets };
    },
    [],
  );

  const buildMeetingNotes = useCallback(() => {
    if (!sessionStartMs) return "";
    const scenario =
      sessionSetupConfig?.scenario || DEFAULT_SESSION_SETUP_CONFIG.scenario;
    if (!scenario || !scenario.chapters || scenario.chapters.length === 0) {
      return "";
    }

    const totalMinutes =
      scenario.totalMinutes ||
      DEFAULT_SESSION_SETUP_CONFIG.scenario?.totalMinutes ||
      0;
    const { chapters, targets } = computeChapterTargets(scenario, totalMinutes);
    const rawTargetSum = chapters.reduce(
      (sum, chapter) => sum + (chapter.targetMinutes || 0),
      0,
    );
    const hasTargetMinutes = chapters.some((c) => c.targetMinutes);

    const now = Date.now();
    const elapsedMinutes = Math.max(
      Math.floor((now - sessionStartMs) / 60000),
      0,
    );
    const remainingMinutesRaw = totalMinutes - elapsedMinutes;
    const remainingMinutes = Math.max(remainingMinutesRaw, 0);

    let acc = 0;
    let chapterIndex = 0;
    for (let i = 0; i < targets.length; i += 1) {
      acc += targets[i];
      if (elapsedMinutes <= acc) {
        chapterIndex = i;
        break;
      }
      chapterIndex = i;
    }

    const activeChapterIndex =
      manualChapterIndex !== null ? manualChapterIndex : chapterIndex;
    const chapter = chapters[activeChapterIndex];
    const chapterTarget = targets[activeChapterIndex] ?? 0;
    const chapterStartOffset =
      targets.slice(0, activeChapterIndex).reduce((sum, v) => sum + v, 0);
    const defaultChapterStartMs =
      sessionStartMs + chapterStartOffset * 60000;
    const chapterStartMs = manualChapterAt ?? defaultChapterStartMs;
    const chapterElapsed = Math.max(
      Math.floor((now - chapterStartMs) / 60000),
      0,
    );
    const chapterRemainingRaw = chapterTarget - chapterElapsed;
    const chapterRemaining = Math.max(chapterRemainingRaw, 0);
    const nextChapter =
      activeChapterIndex + 1 < chapters.length
        ? chapters[activeChapterIndex + 1]
        : null;

    const lines = [
      `Elapsed: ${elapsedMinutes} min / ${totalMinutes} min total.`,
      `Current chapter: ${chapter?.title || chapter?.id || "Chapter"} (${chapter?.id || "n/a"}).`,
      `Chapter timing: ${chapterElapsed} min elapsed / ${chapterTarget} min target (${chapterRemaining} min remaining).`,
      hasTargetMinutes && rawTargetSum !== totalMinutes
        ? `Chapter targets total ${rawTargetSum} min (auto-balanced to ${totalMinutes} min).`
        : "",
      chapter?.goal ? `Goal: ${chapter.goal}` : "",
      chapter?.hostPrompt ? `Host prompt: ${chapter.hostPrompt}` : "",
      nextChapter
        ? `Next chapter: ${nextChapter.title || nextChapter.id} (${nextChapter.id}).`
        : "Next chapter: (final chapter).",
    ].filter(Boolean);

    if (manualChapterIndex !== null) {
      lines.push("Manual override active.");
    }
    if (chapterRemainingRaw < 0) {
      lines.push(
        `Chapter overrun: ${Math.abs(chapterRemainingRaw)} min past target.`,
      );
    }
    if (chapterRemaining <= 0 && nextChapter) {
      lines.push(
        `Recommendation: move to ${nextChapter.title || nextChapter.id} now.`,
      );
    }
    if (remainingMinutesRaw < 0) {
      lines.push(
        `Session overtime: ${Math.abs(remainingMinutesRaw)} min past end.`,
      );
    } else if (remainingMinutes <= 2) {
      lines.push(
        "Session ending soon: focus on decisions and recap.",
      );
    }

    return lines.join("\n");
  }, [
    sessionStartMs,
    sessionSetupConfig,
    manualChapterIndex,
    manualChapterAt,
    computeChapterTargets,
  ]);

  const getRecentRealtimeSnippet = useCallback(() => {
    const recent = transcriptItems
      .filter(
        (item) =>
          item.type === "MESSAGE" &&
          item.role === "user" &&
          item.status === "DONE" &&
          !item.isHidden,
      )
      .filter(
        (item) =>
          Boolean(item.title) && !item.title?.startsWith("[Transcribing"),
      );
    const last = recent[recent.length - 1];
    return last?.title?.trim() || "";
  }, [transcriptItems]);

  const runBackgroundInsights = useCallback(async () => {
    if (backgroundInsightsBusyRef.current) return;
    if (sessionStatus !== "CONNECTED") return;
    const agentSetKey = searchParams.get("agentConfig") || "default";
    if (agentSetKey !== "agentSupervisorFacilitatedConversation") return;
    if (isAITalkHeld) return;
    if (!sessionId) return;

    const diarisedSnippet = getTranscriptSnippetText(
      sessionId,
      BACKGROUND_SNIPPET_MAX,
    );
    const realtimeSnippet = getRecentRealtimeSnippet();
    if (realtimeSnippet) {
      setMeetingRealtimeSnippet("cake_meeting", realtimeSnippet);
    }
    const hasNewDiarised =
      diarisedSnippet &&
      diarisedSnippet !== lastDiarisedSnippetRef.current;
    const hasNewRealtime =
      realtimeSnippet &&
      realtimeSnippet !== lastRealtimeSnippetRef.current;

    if (!hasNewDiarised && !hasNewRealtime) return;

    if (hasNewDiarised) {
      lastDiarisedSnippetRef.current = diarisedSnippet;
    }
    if (hasNewRealtime) {
      lastRealtimeSnippetRef.current = realtimeSnippet;
    }

    const selectedSnippet = hasNewDiarised
      ? diarisedSnippet
      : realtimeSnippet;
    if (
      !selectedSnippet ||
      (!hasNewDiarised && selectedSnippet.length < BACKGROUND_MIN_CHARS)
    ) {
      return;
    }

    backgroundInsightsBusyRef.current = true;

    try {
      const namesText =
        participantNames.length > 0
          ? `Known participants: ${participantNames.join(", ")}.`
          : "Known participants: (not provided).";
      const profileLines = selectedProfiles.map((p) => {
        const summary = p.profileSummary ? ` — ${p.profileSummary}` : "";
        return `- ${p.speakerName || "Unknown"}${summary}`;
      });
      const onboardingText =
        profileLines.length > 0
          ? `Onboarding facts:\n${profileLines.join("\n")}`
          : "Onboarding facts: none loaded.";
      const systemPrompt = `${sessionSetupConfig.prompts.participantExperienceSystemPrompt}

You are maintaining a rolling participant insight summary across the whole session.
- Update the summary using the newest transcript content.
- Prioritize the most recent live transcript for near-term cues.
- Use the diarised transcript for accuracy and attribution.
- If the summary grows long, compress older chapters more aggressively.
- Keep the rolling summary under ~1200 characters.

Return JSON that includes:
- rolling_summary (string)
- recent_highlights (string, 1-3 bullets)
- participants (array, optional)
- group_summary (optional)
- suggestions_for_host (optional)`.trim()
        .replace("{NAMES_TEXT}", namesText)
        .replace("{ONBOARDING_TEXT}", onboardingText);

      const resp = await fetch("/api/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: systemPrompt }],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `Existing summary:\n${lastParticipantSummaryRef.current || "(none)"}\n\n` +
                    `Recent live transcript (most recent, may be rough):\n${realtimeSnippet || "(none)"}\n\n` +
                    `New diarised transcript (more accurate):\n${diarisedSnippet || "(none)"}\n\n` +
                    "Update the rolling summary and participant insights based on the newest information.",
                },
              ],
            },
          ],
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt || "Background insights failed");
      }
      const data = await resp.json();
      const contentText =
        data?.output
          ?.find((i: any) => i.type === "message" && i.role === "assistant")
          ?.content?.find((c: any) => c.type === "output_text")?.text ?? "";
      let parsed: any = null;
      try {
        parsed = contentText ? JSON.parse(contentText) : null;
      } catch {
        parsed = null;
      }

      const buildBrief = (output: any) => {
        if (!output || typeof output !== "object") {
          return contentText.trim();
        }
        const participants = output.participants || [];
        const summaries = participants
          .slice(0, 4)
          .map((p: any) => `${p.id || p.name || "Someone"}: ${p.summary || ""}`.trim())
          .filter(Boolean);
        const suggestions = (output.suggestions_for_host || []).slice(0, 2);
        const group = output.group_summary || {};
        const commonLikes = group.common_likes?.slice(0, 2) || [];
        return [
          summaries.length ? `People: ${summaries.join("; ")}` : "",
          commonLikes.length ? `Common likes: ${commonLikes.join(", ")}` : "",
          suggestions.length ? `Next: ${suggestions.join(" | ")}` : "",
        ]
          .filter(Boolean)
          .join(" — ");
      };

      const rollingSummary =
        (parsed && (parsed.rolling_summary || parsed.summary)) || "";
      const recentHighlights =
        (parsed && (parsed.recent_highlights || parsed.recent_updates)) || "";
      const brief = buildBrief(parsed) || contentText.trim();
      const displayText = [
        rollingSummary ? `Summary:\n${rollingSummary}` : "",
        recentHighlights ? `Recent:\n${recentHighlights}` : "",
        brief && brief !== rollingSummary ? `Quick cues:\n${brief}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (displayText) {
        const updatedAt = new Date().toISOString();
        if (rollingSummary) {
          lastParticipantSummaryRef.current = rollingSummary;
        } else if (displayText) {
          lastParticipantSummaryRef.current = displayText;
        }
        const summaryForContext = rollingSummary || displayText;
        setMeetingParticipantSummary("cake_meeting", summaryForContext);
        setBackgroundBriefState(displayText);
        setBackgroundBriefAt(updatedAt);
        setBackgroundBrief(sessionId, {
          text: displayText,
          updatedAt,
          source: hasNewDiarised ? "transkriptor" : "realtime",
          raw: parsed || contentText,
        });
        setBackgroundBrief("cake_meeting", {
          text: displayText,
          updatedAt,
          source: hasNewDiarised ? "transkriptor" : "realtime",
          raw: parsed || contentText,
        });
      }
    } catch (err) {
      console.error("background insights error", err);
    } finally {
      backgroundInsightsBusyRef.current = false;
    }
  }, [
    sessionStatus,
    searchParams,
    sessionId,
    participantNames,
    selectedProfiles,
    sessionSetupConfig,
    isAITalkHeld,
    getRecentRealtimeSnippet,
  ]);

  useEffect(() => {
    if (sessionStatus !== "CONNECTED") return;
    const agentSetKey = searchParams.get("agentConfig") || "default";
    if (agentSetKey !== "agentSupervisorFacilitatedConversation") return;
    const interval = setInterval(() => {
      runBackgroundInsights();
    }, BACKGROUND_INSIGHTS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sessionStatus, searchParams, runBackgroundInsights]);

  useEffect(() => {
    if (sessionStatus !== "CONNECTED") return;
    const updateNotes = () => {
      const notes = buildMeetingNotes();
      if (notes) {
        setMeetingNotes(notes);
        setMeetingNotesAt(new Date().toISOString());
      }
    };
    updateNotes();
    const interval = setInterval(updateNotes, MEETING_NOTES_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sessionStatus, buildMeetingNotes]);

  useEffect(() => {
    if (sessionStatus === "DISCONNECTED") {
      setMeetingNotes("");
      setMeetingNotesAt("");
      setManualChapterIndex(null);
      setManualChapterAt(null);
      setBackgroundBriefState("");
      setBackgroundBriefAt("");
      lastDiarisedSnippetRef.current = "";
      lastRealtimeSnippetRef.current = "";
      lastParticipantSummaryRef.current = "";
      lastParticipantsUpdateRef.current = "";
      lastHostNotesInjectedRef.current = "";
    }
  }, [sessionStatus]);

  const handleAITalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED") return;
    setIsAITalkHeld(true);
    aiFirstUtteranceLockRef.current = true;
    aiTalkStartMsRef.current = Date.now();
    setMicEnabled(false);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "ai talk clear");
    updateSession(false);
    const hostNotesChunks = [];
    if (participantNames.length > 0) {
      hostNotesChunks.push(`Participants: ${participantNames.join(", ")}`);
    }
    const recentRealtime = getRecentRealtimeSnippet();
    if (recentRealtime) {
      hostNotesChunks.push(`Recent live transcript:\n${recentRealtime}`);
    }
    if (meetingNotes) {
      hostNotesChunks.push(`Schedule notes:\n${meetingNotes}`);
    }
    if (backgroundBrief) {
      hostNotesChunks.push(`Participant notes:\n${backgroundBrief}`);
    }
    if (hostNotesChunks.length > 0) {
      const hostNotesText = `[HOST NOTES]\n${hostNotesChunks.join("\n\n")}\n[/HOST NOTES]`;
      if (hostNotesText !== lastHostNotesInjectedRef.current) {
        lastHostNotesInjectedRef.current = hostNotesText;
        const noteId = uuidv4().slice(0, 32);
        sendClientEvent(
          {
            type: "conversation.item.create",
            item: {
              id: noteId,
              type: "message",
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: hostNotesText,
                },
              ],
            },
          },
          "host_notes_seed",
        );
      }
    }
    sendClientEvent({ type: "response.create" }, "ai talk start");
  };

  const handleAITalkButtonUp = () => {
    setIsAITalkHeld(false);
    aiFirstUtteranceLockRef.current = false;
    aiTalkStartMsRef.current = null;
    updateSession(false);
    interrupt();
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const onToggleMuteMic = () => {
    setIsMicMuted((prev) => {
      const next = !prev;
      setMicEnabled(!next);
      return next;
    });
  };

  // Because we need a new connection, refresh the page when codec changes
  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  useEffect(() => {
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    localStorage.setItem("micMuted", isMicMuted.toString());
  }, [isMicMuted]);

  useEffect(() => {
    const shouldPlay = isAudioPlaybackEnabled;

    if (audioElementRef.current) {
      audioElementRef.current.muted = !shouldPlay;
      if (shouldPlay) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }

    // Toggle server-side audio stream mute so bandwidth is saved when the
    // user disables playback (AI mute leaves stream flowing for transcripts).
    try {
      mute(!isAudioPlaybackEnabled);
    } catch (err) {
      console.warn('Failed to toggle SDK mute', err);
    }
  }, [isAudioPlaybackEnabled]);

  // Ensure mute state is propagated to transport right after we connect or
  // whenever the SDK client reference becomes available.
  useEffect(() => {
    if (sessionStatus === 'CONNECTED') {
      try {
        mute(!isAudioPlaybackEnabled);
      } catch (err) {
        console.warn('mute sync after connect failed', err);
      }
    }
  }, [sessionStatus, isAudioPlaybackEnabled]);

  // Start/stop combined recording as session status changes.
  const prevSessionStatusRef = useRef<SessionStatus | null>(null);
  useEffect(() => {
    const prevStatus = prevSessionStatusRef.current;
    prevSessionStatusRef.current = sessionStatus;

    if (
      sessionStatus === "CONNECTED" &&
      getPlaybackStream() &&
      prevStatus !== "CONNECTED"
    ) {
      const remoteStream = getPlaybackStream();
      if (!remoteStream) return;
      startRecording(remoteStream, {
        chunkDurationMs: FULL_TRANSCRIPT_CHUNK_MS,
        chunkHopMs: FULL_TRANSCRIPT_HOP_MS,
        includeMic: !isMicMuted,
        onChunk: handleAudioChunk,
      });
    }

    if (sessionStatus === "DISCONNECTED" && prevStatus !== "DISCONNECTED") {
      stopRecording();
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus, startRecording, handleAudioChunk, stopRecording, getPlaybackStream, isMicMuted]);

  // Re-apply session settings when mic mute toggles.
  const prevMicMutedRef = useRef<boolean>(isMicMuted);
  useEffect(() => {
    const prevMicMuted = prevMicMutedRef.current;
    prevMicMutedRef.current = isMicMuted;

    if (sessionStatus !== "CONNECTED") return;

    // Restart local recording pipeline when mic mute toggles so Assembly stream resumes correctly.
    if (prevMicMuted !== isMicMuted) {
      const remoteStream = getPlaybackStream();
      if (remoteStream) {
        stopRecording();
        startRecording(remoteStream, {
          chunkDurationMs: FULL_TRANSCRIPT_CHUNK_MS,
          chunkHopMs: FULL_TRANSCRIPT_HOP_MS,
          includeMic: !isMicMuted,
          onChunk: handleAudioChunk,
        });
      }
    }
  }, [isMicMuted, sessionStatus, startRecording, stopRecording, handleAudioChunk, getPlaybackStream]);

  // Ensure WebRTC mic track state matches UI mute state after connect/toggles.
  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      setMicEnabled(!isMicMuted);
    }
  }, [sessionStatus, isMicMuted, setMicEnabled]);

  const hostNotesUpdatedAt = meetingNotesAt || backgroundBriefAt;
  const scenarioConfig =
    sessionSetupConfig?.scenario || DEFAULT_SESSION_SETUP_CONFIG.scenario;
  const scenarioChapters = scenarioConfig?.chapters || [];
  const scenarioTotalMinutes =
    scenarioConfig?.totalMinutes ||
    DEFAULT_SESSION_SETUP_CONFIG.scenario?.totalMinutes ||
    0;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const remainingMinutesRaw = scenarioTotalMinutes - elapsedMinutes;
  const timeBadgeClass =
    remainingMinutesRaw <= 0
      ? "text-red-700 bg-red-50 border-red-200"
      : remainingMinutesRaw <= 5
        ? "text-amber-700 bg-amber-50 border-amber-200"
        : "text-emerald-700 bg-emerald-50 border-emerald-200";
  const { targets: chapterTargets } =
    scenarioChapters.length && scenarioTotalMinutes
      ? computeChapterTargets(
          { ...scenarioConfig!, chapters: scenarioChapters },
          scenarioTotalMinutes,
        )
      : { targets: [] as number[] };
  const computedChapterIndex = useMemo(() => {
    if (!sessionStartMs || chapterTargets.length === 0) return 0;
    const elapsedMinutes = Math.max(
      Math.floor((Date.now() - sessionStartMs) / 60000),
      0,
    );
    let acc = 0;
    let idx = 0;
    for (let i = 0; i < chapterTargets.length; i += 1) {
      acc += chapterTargets[i];
      if (elapsedMinutes <= acc) {
        idx = i;
        break;
      }
      idx = i;
    }
    return idx;
  }, [sessionStartMs, chapterTargets]);
  const activeChapterIndex =
    manualChapterIndex !== null ? manualChapterIndex : computedChapterIndex;
  const activeChapter = scenarioChapters[activeChapterIndex];
  const chapterLabel = activeChapter
    ? `${activeChapter.title || activeChapter.id}`
    : "Chapter";

  const applyChapterOverride = (nextIndex: number) => {
    if (!scenarioChapters.length) return;
    const clamped = Math.max(0, Math.min(nextIndex, scenarioChapters.length - 1));
    setManualChapterIndex(clamped);
    setManualChapterAt(Date.now());
    setMeetingChapterOverride("cake_meeting", clamped, scenarioConfig);
  };

  const clearChapterOverride = () => {
    if (!scenarioChapters.length) return;
    setManualChapterIndex(null);
    setManualChapterAt(null);
    setMeetingChapterOverride(
      "cake_meeting",
      computedChapterIndex,
      scenarioConfig,
    );
  };

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/openai-logomark.svg"
              alt="OpenAI Logo"
              width={20}
              height={20}
              className="mr-2"
            />
          </div>
          <div>
            Multi-Agent AI
          </div>
        </div>
        <div className="flex flex-wrap md:flex-nowrap items-center justify-end gap-3">
          {/* Scenario/Agent selectors temporarily hidden */}

          <button
            onClick={() => setIsProfileModalOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-gray-300 bg-white hover:bg-gray-50 whitespace-nowrap"
          >
            Manage Profiles
          </button>

          <button
            onClick={() => setIsSessionSetupModalOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-gray-300 bg-white hover:bg-gray-50 whitespace-nowrap"
          >
            Session Setup
          </button>

          {sessionSetupConfig?.name && (
            <div className="text-xs text-gray-600 whitespace-nowrap">
              Setup: {sessionSetupConfig.name}
            </div>
          )}

          {sessionStartMs && (
            <div className={`text-sm font-semibold rounded px-3 py-1 text-right whitespace-nowrap border ${timeBadgeClass}`}>
              Time: {elapsedMinutes}:
              {(elapsedSeconds % 60).toString().padStart(2, "0")} elapsed{" · "}
              ~{Math.max(
                remainingMinutesRaw,
                0,
              )}{" "}
              min remaining
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden">
        <div className="w-1/2 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0">
            <Transcript
              userText={userText}
              setUserText={setUserText}
              onSendMessage={handleSendTextMessage}
              downloadRecording={downloadRecording}
              canSend={
                sessionStatus === "CONNECTED"
              }
            />
          </div>
        </div>

        <div className="w-1/2 min-h-0 transition-all duration-200 ease-in-out overflow-hidden flex flex-col gap-2">
          <div className="bg-white rounded-xl flex flex-col min-h-0 flex-1">
            <div className="flex items-center justify-between px-6 py-3.5 text-base border-b bg-white rounded-t-xl">
              <span className="font-semibold">Full Transcript</span>
              <span className="text-xs text-gray-500">
                {hasPending
                  ? "Updating..."
                  : speakerBlocks.length
                  ? "Live"
                  : "Waiting for audio..."}
              </span>
            </div>
            <FullTranscript
              speakerBlocks={speakerBlocks}
              speakerLabels={speakerLabels}
              isLoading={hasPending}
              hasPending={hasPending}
              error={transcriptionError}
            />
          </div>

          <div className="flex-1 min-h-0 bg-white rounded-xl border border-amber-100 flex flex-col">
            <div className="px-6 py-3 text-base border-b bg-white rounded-t-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-amber-700">Host Notes</span>
                <span className="text-xs text-gray-500">
                  {hostNotesUpdatedAt
                    ? `Updated ${new Date(hostNotesUpdatedAt).toLocaleTimeString()}`
                    : "Listening..."}
                </span>
              </div>
              {scenarioChapters.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-600">Chapter</span>
                  <button
                    type="button"
                    onClick={() => applyChapterOverride(activeChapterIndex - 1)}
                    disabled={activeChapterIndex <= 0}
                    className="px-2 py-1 rounded border border-gray-300 bg-white disabled:opacity-40"
                    aria-label="Previous chapter"
                  >
                    ◀
                  </button>
                  <div
                    className={`px-2 py-1 rounded border text-xs ${
                      manualChapterIndex !== null
                        ? "border-amber-300 bg-amber-50 text-amber-800"
                        : "border-gray-200 bg-white text-gray-700"
                    }`}
                  >
                    {activeChapterIndex + 1}/{scenarioChapters.length}: {chapterLabel}
                  </div>
                  <button
                    type="button"
                    onClick={() => applyChapterOverride(activeChapterIndex + 1)}
                    disabled={activeChapterIndex >= scenarioChapters.length - 1}
                    className="px-2 py-1 rounded border border-gray-300 bg-white disabled:opacity-40"
                    aria-label="Next chapter"
                  >
                    ▶
                  </button>
                  {manualChapterIndex !== null && (
                    <button
                      type="button"
                      onClick={clearChapterOverride}
                      className="px-2 py-1 rounded border border-amber-300 text-amber-700 bg-amber-50"
                    >
                      Auto
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="p-4 overflow-auto text-sm text-gray-700 whitespace-pre-wrap space-y-4">
              <div>
                <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
                  Participants
                </div>
                <div className="mt-1 whitespace-pre-wrap">
                  {participantNames.length > 0 ? (
                    participantNames.join(", ")
                  ) : (
                    <span className="text-gray-400 italic">
                      No participants selected.
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
                  Schedule and chapters
                </div>
                {participantNames.length > 0 && (
                  <div className="mt-1 text-xs text-gray-600">
                    Participants: {participantNames.join(", ")}
                  </div>
                )}
                <div className="mt-1 whitespace-pre-wrap">
                  {meetingNotes || (
                    <span className="text-gray-400 italic">
                      No schedule notes yet.
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
                  Participant insights
                </div>
                <div className="mt-1 whitespace-pre-wrap">
                  {backgroundBrief || (
                    <span className="text-gray-400 italic">
                      No participant notes yet.
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isAITalkHeld={isAITalkHeld}
        handleAITalkButtonDown={handleAITalkButtonDown}
        handleAITalkButtonUp={handleAITalkButtonUp}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        isMicMuted={isMicMuted}
        onToggleMicMute={onToggleMuteMic}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
      <ProfileManagerModal
        open={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        selectedProfiles={selectedProfiles}
        onSelectionChange={setSelectedProfiles}
      />
      <SessionSetupModal
        open={isSessionSetupModalOpen}
        onClose={() => setIsSessionSetupModalOpen(false)}
        onApply={(config) =>
          setSessionSetupConfig(normalizeSessionSetupConfig(config))
        }
        isSessionActive={
          sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING"
        }
      />
    </div>
  );
}

export default App;
