"use client";

import React, { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { buildOnboardingProfileAgent } from "@/app/agentConfigs/onboardingProfile";
import { useRealtimeSession } from "../hooks/useRealtimeSession";
import type { SessionStatus } from "../types";
import { EventProvider } from "../contexts/EventContext";
import { TranscriptProvider } from "../contexts/TranscriptContext";
import { useTranscript } from "../contexts/TranscriptContext";
import type { SessionSetupConfig } from "@/app/lib/sessionSetupTypes";
import { DEFAULT_SESSION_SETUP_CONFIG } from "@/app/lib/sessionSetupDefaults";

type ProfileResult = {
  profileId?: string;
  profileKey?: string;
  speakerName?: string;
  profileSummary?: string;
};

const SUMMARY_MODEL = "gpt-4.1-mini";
const ONBOARDING_TURN_DETECTION = {
  type: "server_vad",
  threshold: 0.95,
  prefix_padding_ms: 300,
  silence_duration_ms: 900,
};
const MIN_USER_WORDS = 3;
const MIN_USER_CHARS = 8;
const FILLER_REGEX = /^(?:\s|[.\-–—]|uh+|um+|erm+|mm+|mmm+|hmm+|ah+|oh+|okay+|ok)+$/i;

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

function OnboardingContent() {
  const [name, setName] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [chatStatus, setChatStatus] = useState<SessionStatus>("DISCONNECTED");
  const [chatMessage, setChatMessage] = useState<string | null>(null);
  const [autoSummary, setAutoSummary] = useState<string>("");
  const [isAutoSubmitting, setIsAutoSubmitting] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [sessionSetupConfig, setSessionSetupConfig] =
    useState<SessionSetupConfig>(DEFAULT_SESSION_SETUP_CONFIG);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const { transcriptItems } = useTranscript();
  const pendingAutoSubmitRef = useRef(false);
  const lastAssistantProcessedRef = useRef<string | null>(null);
  const recordingStartRef = useRef<number | null>(null);
  const firstLongQuestionRef = useRef<number | null>(null);
  const audioBlobRef = useRef<Blob | null>(null);
  const micUnlockRef = useRef(false);
  const responseStartedRef = useRef(false);
  const micCooldownRef = useRef<number | null>(null);
  const assistantSpeakingRef = useRef(false);
  const lastUserProcessedRef = useRef<string | null>(null);
  const pendingUserResponseRef = useRef(false);

  const {
    connect,
    disconnect,
    sendEvent,
    status: rtStatus,
    interrupt,
    setMicEnabled,
  } = useRealtimeSession({
    onConnectionChange: (s) => setChatStatus(s as SessionStatus),
  });

  useEffect(() => {
    if (typeof window !== "undefined" && !audioRef.current) {
      const el = document.createElement("audio");
      el.autoplay = true;
      el.style.display = "none";
      document.body.appendChild(el);
      audioRef.current = el;
    }

    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (micCooldownRef.current) {
        window.clearTimeout(micCooldownRef.current);
      }
      disconnect();
    };
  }, []);

  useEffect(() => {
    const loadActiveSetup = async () => {
      try {
        const resp = await fetch("/api/session-setup?active=1");
        const data = await resp.json();
        if (resp.ok && data?.config) {
          setSessionSetupConfig(data.config);
        }
      } catch (err) {
        console.warn("No active session setup found", err);
      }
    };
    loadActiveSetup();
  }, []);

  const buildTranscriptText = () => {
    const userLines = transcriptItems
      .filter((t) => t.role === "user" && t.title)
      .map((t) => t.title);
    return userLines.join(" ");
  };

  const generateProfileSummary = async () => {
    const transcriptText = buildTranscriptText();
    const fallback = name.trim()
      ? `${name.trim()} is a participant who shared some background and their goals for the session.`
      : "The participant shared background and goals for the session.";

    if (!transcriptText.trim()) {
      setAutoSummary(fallback);
      return fallback;
    }

    try {
      const response = await fetch("/api/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: SUMMARY_MODEL,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text:
                    "Summarize the onboarding conversation in ONE concise sentence. " +
                    "Use the format: \"[name] is a [paraphrased self-description], and their interest in the session is [paraphrased goal].\" " +
                    "Do NOT quote verbatim. If details are missing, say \"they didn't share\" for that part.",
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `Name provided: ${name.trim() || "Unknown"}\nUser transcript: ${transcriptText}`,
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        setAutoSummary(fallback);
        return fallback;
      }
      const data = await response.json();
      const summary =
        data?.output
          ?.find((i: any) => i.type === "message" && i.role === "assistant")
          ?.content?.find((c: any) => c.type === "output_text")?.text ?? "";
      const cleaned = summary.trim();
      setAutoSummary(cleaned || fallback);
      return cleaned || fallback;
    } catch (err) {
      console.warn("Summary generation failed", err);
      setAutoSummary(fallback);
      return fallback;
    }
  };

  const encodeWavFromFloat = (float32: Float32Array, sampleRate: number) => {
    const buffer = new ArrayBuffer(44 + float32.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    const floatTo16BitPCM = (output: DataView, offset: number, input: Float32Array) => {
      for (let i = 0; i < input.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + float32.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, float32.length * 2, true);

    floatTo16BitPCM(view, 44, float32);
    return new Blob([view], { type: "audio/wav" });
  };

  const trimAndCompactSilence = async (
    blob: Blob,
    startOffsetMs?: number,
  ): Promise<Blob> => {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const fullChannel = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const offsetSamples = startOffsetMs
        ? Math.min(fullChannel.length, Math.floor((startOffsetMs / 1000) * sampleRate))
        : 0;
      const channel = fullChannel.subarray(offsetSamples);
      const threshold = 0.01;
      const minSilenceSamples = Math.floor(sampleRate * 0.35);
      const minChunkSamples = Math.floor(sampleRate * 0.2);
      const padSamples = Math.floor(sampleRate * 0.05);

      const segments: Array<{ start: number; end: number }> = [];
      let inSpeech = false;
      let segStart = 0;
      let silenceRun = 0;

      for (let i = 0; i < channel.length; i++) {
        const sample = channel[i];
        const isVoiced = Math.abs(sample) > threshold;
        if (isVoiced) {
          silenceRun = 0;
          if (!inSpeech) {
            inSpeech = true;
            segStart = Math.max(0, i - padSamples);
          }
        } else if (inSpeech) {
          silenceRun++;
          if (silenceRun > minSilenceSamples) {
            const segEnd = Math.min(channel.length, i + padSamples);
            if (segEnd - segStart > minChunkSamples) {
              segments.push({ start: segStart, end: segEnd });
            }
            inSpeech = false;
          }
        }
      }
      if (inSpeech) {
        const segEnd = channel.length;
        if (segEnd - segStart > minChunkSamples) {
          segments.push({ start: segStart, end: segEnd });
        }
      }

      if (!segments.length) {
        return blob;
      }

      const totalLength =
        segments.reduce((acc, s) => acc + (s.end - s.start), 0) +
        (segments.length - 1) * padSamples;
      const out = new Float32Array(totalLength);
      let offset = 0;
      segments.forEach((s, idx) => {
        out.set(channel.subarray(s.start, s.end), offset);
        offset += s.end - s.start;
        if (idx < segments.length - 1) {
          offset += padSamples; // small gap
        }
      });

      return encodeWavFromFloat(out, sampleRate);
    } catch (err) {
      console.warn("Silence trim failed, using original blob", err);
      return blob;
    }
  };

  const startRecording = async () => {
    try {
      setError(null);
      setResult(null);
      setStatus("Requesting microphone...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 128000,
      });
      chunksRef.current = [];
      recordingStartRef.current = Date.now();
      firstLongQuestionRef.current = null;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const rawBlob = new Blob(chunksRef.current, { type: "audio/webm" });
        const offsetMs =
          recordingStartRef.current && firstLongQuestionRef.current
            ? Math.max(0, firstLongQuestionRef.current - recordingStartRef.current)
            : 0;
        const processed = await trimAndCompactSilence(rawBlob, offsetMs);
        setAudioBlob(processed);
        audioBlobRef.current = processed;
        setStatus("Captured sample. Preparing to save...");
        stream.getTracks().forEach((t) => t.stop());
        if (pendingAutoSubmitRef.current) {
          pendingAutoSubmitRef.current = false;
          setStatus("Saving profile...");
          submitProfile(processed);
        }
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
      setStatus("Recording... Answer the prompts in your own words.");
    } catch (err: any) {
      console.error("mic error", err);
      setError("Microphone access failed. Please allow mic permissions.");
      setStatus(null);
    }
  };

  const fetchEphemeralKey = async (): Promise<string | null> => {
    const sessionUrl =
      process.env.NEXT_PUBLIC_SESSION_ENDPOINT || "/api/session";
    try {
      const tokenResponse = await fetch(sessionUrl);
      if (!tokenResponse.ok) {
        const body = await tokenResponse.text();
        console.error("Ephemeral key fetch failed", tokenResponse.status, body);
        setChatMessage("Failed to fetch session token.");
        return null;
      }
      const data = await tokenResponse.json();
      if (!data.client_secret?.value) {
        setChatMessage("No ephemeral key provided by the server.");
        return null;
      }
      return data.client_secret.value;
    } catch (err) {
      console.error("Error fetching ephemeral key", err);
      setChatMessage("Error fetching session token.");
      return null;
    }
  };

  const startGuidedChat = async () => {
    if (!name.trim()) {
      setError("Enter your name first.");
      return;
    }
    try {
      setChatMessage("Connecting to the AI host...");
      const onboardingAgent = buildOnboardingProfileAgent(sessionSetupConfig);
      await connect({
        getEphemeralKey: fetchEphemeralKey,
        initialAgents: [onboardingAgent],
        audioElement: audioRef.current || undefined,
      });
      setChatMessage("Connected. The AI will greet you.");
      micUnlockRef.current = false;
      responseStartedRef.current = false;
      if (audioRef.current) {
        audioRef.current.muted = true;
        audioRef.current.play().catch(() => undefined);
      }
      setMicEnabled(false);
      sendEvent({
        type: "session.update",
        session: {
          turn_detection: {
            ...ONBOARDING_TURN_DETECTION,
            create_response: false,
          },
        },
      });

      const id = uuidv4().slice(0, 32);
      const systemSeed = `
[ONBOARDING CONTEXT]
participant_name: ${name.trim()}
[/ONBOARDING CONTEXT]
`.trim();
      sendEvent({
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: systemSeed }],
        },
      });
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.muted = false;
          audioRef.current.play().catch(() => undefined);
        }
        sendEvent({ type: "input_audio_buffer.clear" });
        if (!responseStartedRef.current) {
          responseStartedRef.current = true;
          sendEvent({ type: "response.create" });
        }
      }, 600);
      if (!isRecording) {
        startRecording();
        setStatus("Recording (waiting for first question)...");
      } else {
        setStatus("Waiting for the first question...");
      }
    } catch (err) {
      console.error("Guided chat start error", err);
      setChatMessage("Failed to start guided chat. Please retry.");
    }
  };

  const stopGuidedChat = () => {
    interrupt();
    disconnect();
    setChatMessage("Chat ended.");
  };

  useEffect(() => {
    const lastAssistant = [...transcriptItems]
      .filter((t) => t.role === "assistant" && t.title)
      .pop();
    if (!lastAssistant || lastAssistant.itemId === lastAssistantProcessedRef.current) return;
    lastAssistantProcessedRef.current = lastAssistant.itemId;

    const text = lastAssistant.title || "";
    const isLongQuestion =
      text.length > 40 &&
      (text.includes("?") ||
        /describe|would you like|get out of the session|briefly/i.test(text));
    const isNameCheck = /name|pronounc/i.test(text);
    if (isLongQuestion && !isNameCheck && !firstLongQuestionRef.current) {
      firstLongQuestionRef.current = Date.now();
      setStatus("Recording answer...");
    }
  }, [transcriptItems]);

  useEffect(() => {
    if (micUnlockRef.current) return;
    const firstCompletedAssistant = transcriptItems.find(
      (t) => t.role === "assistant" && t.status === "DONE"
    );
    if (!firstCompletedAssistant) return;
    micUnlockRef.current = true;
    setTimeout(() => {
      setMicEnabled(true);
    }, 250);
  }, [transcriptItems, setMicEnabled, sendEvent]);

  useEffect(() => {
    const isSpeaking = transcriptItems.some(
      (t) => t.role === "assistant" && t.status === "IN_PROGRESS"
    );
    if (assistantSpeakingRef.current === isSpeaking) return;
    assistantSpeakingRef.current = isSpeaking;
    setAssistantSpeaking(isSpeaking);
    if (!micUnlockRef.current) return;
    if (micCooldownRef.current) {
      window.clearTimeout(micCooldownRef.current);
      micCooldownRef.current = null;
    }
    if (isSpeaking) {
      setMicEnabled(false);
      pendingUserResponseRef.current = false;
    } else {
      micCooldownRef.current = window.setTimeout(() => {
        setMicEnabled(true);
        if (pendingUserResponseRef.current) {
          pendingUserResponseRef.current = false;
          sendEvent({ type: "response.create" });
        }
      }, 400);
    }
  }, [transcriptItems, setMicEnabled, sendEvent]);

  useEffect(() => {
    if (chatStatus !== "CONNECTED" || !micUnlockRef.current) return;
    const latestUser = [...transcriptItems]
      .filter((t) => t.role === "user" && t.status === "DONE")
      .pop();
    if (!latestUser || latestUser.itemId === lastUserProcessedRef.current) return;
    lastUserProcessedRef.current = latestUser.itemId;

    const text = (latestUser.title || "").trim();
    const wordCount = text ? text.split(/\s+/).length : 0;
    if (!text || text.length < MIN_USER_CHARS || wordCount < MIN_USER_WORDS) return;
    if (FILLER_REGEX.test(text)) return;

    if (assistantSpeakingRef.current) {
      pendingUserResponseRef.current = true;
      return;
    }
    sendEvent({ type: "response.create" });
  }, [transcriptItems, chatStatus, sendEvent]);

  const finalizeAndSubmit = () => {
    if (isAutoSubmitting) return;
    setStatus("Finalizing recording and saving...");
    pendingAutoSubmitRef.current = true;
    const blobReady = audioBlobRef.current || audioBlob;
    if (isRecording) {
      stopRecording();
    } else if (blobReady) {
      pendingAutoSubmitRef.current = false;
      submitProfile(blobReady);
    } else {
      // give the recorder a moment to finish
      setTimeout(() => {
        const laterBlob = audioBlobRef.current || audioBlob;
        if (laterBlob) {
          pendingAutoSubmitRef.current = false;
          submitProfile(laterBlob);
        } else {
          pendingAutoSubmitRef.current = false;
          setError("No recording captured yet. Please allow microphone access and try again.");
        }
      }, 600);
    }
    stopGuidedChat();
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const submitProfile = async (blobOverride?: Blob) => {
    const finalBlob = blobOverride || audioBlob;
    if (!finalBlob) {
      setError("Record an audio sample first.");
      return;
    }
    if (!name.trim()) {
      setError("Enter your name first.");
      return;
    }
    try {
      setIsAutoSubmitting(true);
      const derivedSummary = await generateProfileSummary();
      setStatus("Uploading profile to Transkriptor...");
      setError(null);
      const base64 = await blobToBase64(finalBlob);
      const resp = await fetch("/api/transkriptor/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speakerName: name.trim(),
          audioBase64: base64,
          profileSummary: derivedSummary || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data?.error || "Upload failed";
        const details = data?.details ? `: ${data.details}` : "";
        throw new Error(`${msg}${details}`);
      }
      setResult({
        profileId: data.profileId,
        profileKey: data.profileKey,
        speakerName: data.speakerName,
        profileSummary: derivedSummary || undefined,
      });
      setStatus("Profile created and stored.");
    } catch (err: any) {
      console.error("submit error", err);
      setError(err?.message || "Failed to create profile");
      setStatus(null);
    } finally {
      setIsAutoSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
        <div className="bg-white shadow-sm rounded-2xl p-6 space-y-4">
          <h1 className="text-2xl font-semibold">Participant Onboarding</h1>
          <p className="text-sm text-gray-600">
            We’ll capture a short voice sample so the system can recognise you. The AI will greet you, confirm your name pronunciation, and ask two quick questions about you and the session.
          </p>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Alex Rivera"
            />
          </div>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={startGuidedChat}
              disabled={!name.trim() || rtStatus !== "DISCONNECTED"}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm disabled:opacity-60"
            >
              {rtStatus === "CONNECTING" ? "Connecting..." : "Start guided chat"}
            </button>
            <button
              onClick={finalizeAndSubmit}
              disabled={isAutoSubmitting || chatStatus === "DISCONNECTED"}
              className="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm disabled:opacity-50"
            >
              {isAutoSubmitting ? "Saving..." : "Stop & End Chat"}
            </button>
          </div>
          <div className="bg-gray-50 border rounded-lg p-3 text-xs text-gray-700 space-y-1">
            <div className="font-semibold">AI chat status</div>
            <div>Connection: {chatStatus}</div>
            {chatMessage && <div>{chatMessage}</div>}
            {isRecording && <div className="text-emerald-700">Recording mic sample…</div>}
            {assistantSpeaking && <div className="text-gray-600">Assistant speaking…</div>}
          </div>
          {status && <div className="text-sm text-emerald-700">{status}</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {audioBlob && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-gray-700">Preview your recording</div>
              <audio controls src={URL.createObjectURL(audioBlob)} className="w-full" />
            </div>
          )}
          {result && (
            <div className="border rounded-lg p-3 bg-emerald-50 text-sm text-emerald-900">
              <div>Profile stored for {result.speakerName || "participant"}.</div>
              {result.profileId && <div>Transkriptor profile ID: {result.profileId}</div>}
              {result.profileKey && <div>Local profile key: {result.profileKey}</div>}
              {result.profileSummary && <div>Notes: {result.profileSummary}</div>}
            </div>
          )}
          {autoSummary && !result && (
            <div className="border rounded-lg p-3 bg-gray-50 text-sm text-gray-800">
              <div className="font-semibold">Auto summary (preview)</div>
              <div>{autoSummary}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <EventProvider>
      <TranscriptProvider>
        <OnboardingContent />
      </TranscriptProvider>
    </EventProvider>
  );
}
