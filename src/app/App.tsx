"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";
import FullTranscript from "./components/FullTranscript";

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

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import { customerServiceRetailScenario } from "@/app/agentConfigs/customerServiceRetail";
import { chatSupervisorScenario } from "@/app/agentConfigs/chatSupervisor";
import { customerServiceRetailCompanyName } from "@/app/agentConfigs/customerServiceRetail";
import { chatSupervisorCompanyName } from "@/app/agentConfigs/chatSupervisor";
import { simpleHandoffScenario } from "@/app/agentConfigs/simpleHandoff";
import { groupFacilitatedConversationScenario } from "@/app/agentConfigs/groupFacilitatedConversation";
import { agentSupervisorFacilitatedConversationScenario } from "@/app/agentConfigs/agentSupervisorFacilitatedConversation";

// Map used by connect logic for scenarios defined via the SDK.
const sdkScenarioMap: Record<string, RealtimeAgent[]> = {
  simpleHandoff: simpleHandoffScenario,
  customerServiceRetail: customerServiceRetailScenario,
  chatSupervisor: chatSupervisorScenario,
  groupFacilitatedConversation: groupFacilitatedConversationScenario,
  agentSupervisorFacilitatedConversation: agentSupervisorFacilitatedConversationScenario,
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
    addTranscriptMessage,
    addTranscriptBreadcrumb,
  } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    RealtimeAgent[] | null
  >(null);

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  // Ref to identify whether the latest agent switch came from an automatic handoff
  const handoffTriggeredRef = useRef(false);

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
  const [meetingDurationMinutes, setMeetingDurationMinutes] = useState(6);
  const [participantNamesInput, setParticipantNamesInput] = useState("");
  const [sessionStartMs, setSessionStartMs] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hasSentMeetingConfig, setHasSentMeetingConfig] = useState(false);

  const participantNames = useMemo(
    () =>
      participantNamesInput
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    [participantNamesInput],
  );

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] =
    useState<boolean>(() => {
      if (typeof window === 'undefined') return false;
      const stored = localStorage.getItem("logsExpanded");
      if (stored !== null) return stored === "true";
      return false;
    });
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(
    () => {
      if (typeof window === 'undefined') return true;
      const stored = localStorage.getItem('audioPlaybackEnabled');
      return stored ? stored === 'true' : true;
    },
  );
  const [isAIMuted, setIsAIMuted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const stored = localStorage.getItem('aiMuted');
    return stored ? stored === 'true' : false;
  });
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

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    try {
      sendEvent(eventObj);
      logClientEvent(eventObj, eventNameSuffix);
    } catch (err) {
      console.error('Failed to send via SDK', err);
    }
  };

  useHandleSessionHistory();

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
  }, [isPTTActive]);

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
    if (sdkScenarioMap[agentSetKey]) {
      if (sessionStatus !== "DISCONNECTED") return;
      setSessionStatus("CONNECTING");

      try {
        const EPHEMERAL_KEY = await fetchEphemeralKey();
        if (!EPHEMERAL_KEY) return;

        const idForSession = sessionId ?? uuidv4();
        setSessionId(idForSession);
        setHasSentMeetingConfig(false);

        // Ensure the selectedAgentName is first so that it becomes the root
        const reorderedAgents = [...sdkScenarioMap[agentSetKey]];
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

        if (
          agentSetKey === "agentSupervisorFacilitatedConversation" &&
          !hasSentMeetingConfig
        ) {
          const configText = `
[MEETING CONFIG]
session_id: ${idForSession}
duration_minutes: ${meetingDurationMinutes}
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
    setIsPTTUserSpeaking(false);
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
    sendClientEvent({ type: 'response.create' }, '(simulated user text message)');
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    // Reflect Push-to-Talk UI state by (de)activating server VAD on the
    // backend. The Realtime SDK supports live session updates via the
    // `session.update` event.
    const turnDetection = isPTTActive
      ? null
      : {
          type: 'server_vad',
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: !isAIMuted,
        };

    sendEvent({
      type: 'session.update',
      session: {
        turn_detection: turnDetection,
      },
    });

    // Send an initial 'hi' message to trigger the agent to greet the user
    if (shouldTriggerResponse && !isAIMuted && !isMicMuted && !isPTTActive) {
      sendSimulatedUserMessage('hi');
    }
    return;
  }

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

  const handleTalkButtonDown = () => {
    if (sessionStatus !== 'CONNECTED') return;
    interrupt();

    setIsPTTUserSpeaking(true);
    if (!isMicMuted) {
      sendClientEvent({ type: 'input_audio_buffer.clear' }, 'clear PTT buffer');
    }

    // No placeholder; we'll rely on server transcript once ready.
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== 'CONNECTED' || !isPTTUserSpeaking)
      return;

    setIsPTTUserSpeaking(false);
    if (!isMicMuted) {
      sendClientEvent({ type: 'input_audio_buffer.commit' }, 'commit PTT');
      if (!isAIMuted) {
        sendClientEvent({ type: 'response.create' }, 'trigger response PTT');
      }
    }
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const onToggleMuteAI = () => {
    setIsAIMuted((prev) => {
      const next = !prev;
      if (!prev) {
        // Stop any current speech instantly.
        interrupt();
      }
      return next;
    });
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
    const storedPushToTalkUI = localStorage.getItem("pushToTalkUI");
    if (storedPushToTalkUI) {
      setIsPTTActive(storedPushToTalkUI === "true");
    }
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    localStorage.setItem("aiMuted", isAIMuted.toString());
  }, [isAIMuted]);

  useEffect(() => {
    localStorage.setItem("micMuted", isMicMuted.toString());
  }, [isMicMuted]);

  useEffect(() => {
    const shouldPlay = isAudioPlaybackEnabled && !isAIMuted;

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
  }, [isAudioPlaybackEnabled, isAIMuted]);

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

  // If PTT mode is enabled, stop any ongoing speech and clear buffers so it only responds on press.
  useEffect(() => {
    if (sessionStatus !== "CONNECTED") return;
    if (isPTTActive) {
      interrupt();
      sendClientEvent({ type: 'input_audio_buffer.clear' }, 'ptt mode on clear buffer');
    }
  }, [isPTTActive, sessionStatus]);

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

  // Re-apply session settings when AI mute or mic mute toggles.
  const prevAIMutedRef = useRef<boolean>(isAIMuted);
  const prevMicMutedRef = useRef<boolean>(isMicMuted);
  useEffect(() => {
    const prevAIMuted = prevAIMutedRef.current;
    const prevMicMuted = prevMicMutedRef.current;
    prevAIMutedRef.current = isAIMuted;
    prevMicMutedRef.current = isMicMuted;

    if (sessionStatus !== "CONNECTED") return;

    // Reconfigure turn detection only when AI mute changes.
    if (prevAIMuted !== isAIMuted) {
      updateSession(false);
    }

    // If unmuting AI, optionally nudge a response so it resumes speaking.
    if (!isAIMuted && prevAIMuted) {
      sendClientEvent({ type: 'response.create' }, 'unmute ai resume');
    }

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
  }, [isAIMuted, isMicMuted, sessionStatus, startRecording, stopRecording, handleAudioChunk, getPlaybackStream]);

  // Ensure WebRTC mic track state matches UI mute state after connect/toggles.
  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      setMicEnabled(!isMicMuted);
    }
  }, [sessionStatus, isMicMuted, setMicEnabled]);

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
          <label className="flex items-center gap-2 text-sm">
            Duration (min)
            <input
              type="number"
              min={3}
              max={30}
              value={meetingDurationMinutes}
              onChange={(e) =>
                setMeetingDurationMinutes(Number(e.target.value) || 6)
              }
              className="w-16 border rounded px-1 py-0.5 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            Participants
            <input
              type="text"
              placeholder="Alex, Sam, Taylor"
              value={participantNamesInput}
              onChange={(e) => setParticipantNamesInput(e.target.value)}
              className="border rounded px-2 py-0.5 text-sm min-w-[220px]"
            />
          </label>

          {participantNames.length > 0 && (
            <div className="flex flex-wrap gap-1 text-xs text-gray-600">
              {participantNames.map((name) => (
                <span
                  key={name}
                  className="px-2 py-0.5 rounded-full border border-gray-300 bg-gray-50"
                >
                  {name}
                </span>
              ))}
            </div>
          )}

          {/* Scenario/Agent selectors temporarily hidden */}

          {sessionStartMs && (
            <div className="text-sm font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1 text-right whitespace-nowrap">
              Time: {Math.floor(elapsedSeconds / 60)}:
              {(elapsedSeconds % 60).toString().padStart(2, "0")} elapsed{" · "}
              ~{Math.max(
                meetingDurationMinutes - Math.floor(elapsedSeconds / 60),
                0,
              )}{" "}
              min remaining
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED"
          }
        />

        <div className="w-1/2 transition-all duration-200 ease-in-out overflow-hidden flex flex-col gap-2">
          <div
            className={`bg-white rounded-xl flex flex-col min-h-0 ${
              isEventsPaneExpanded ? "flex-[2]" : "flex-1"
            }`}
          >
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
              error={transcriptionError}
            />
          </div>
          {isEventsPaneExpanded && (
            <div className="flex-[1] min-h-0">
              <Events isExpanded={isEventsPaneExpanded} />
            </div>
          )}
        </div>
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        isAIMuted={isAIMuted}
        onToggleAIMute={onToggleMuteAI}
        isMicMuted={isMicMuted}
        onToggleMicMute={onToggleMuteMic}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default App;
