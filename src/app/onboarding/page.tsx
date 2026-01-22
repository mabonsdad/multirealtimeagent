"use client";

import React, { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { onboardingProfileAgent } from "@/app/agentConfigs/onboardingProfile";
import { useRealtimeSession } from "../hooks/useRealtimeSession";
import type { SessionStatus } from "../types";
import { EventProvider } from "../contexts/EventContext";
import { TranscriptProvider } from "../contexts/TranscriptContext";

type ProfileResult = {
  profileId?: string;
  profileKey?: string;
  speakerName?: string;
  profileSummary?: string;
};

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
  const [summary, setSummary] = useState("");
  const [chatStatus, setChatStatus] = useState<SessionStatus>("DISCONNECTED");
  const [chatMessage, setChatMessage] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const {
    connect,
    disconnect,
    sendEvent,
    status: rtStatus,
    interrupt,
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
      disconnect();
    };
  }, []);

  const startRecording = async () => {
    try {
      setError(null);
      setResult(null);
      setStatus("Requesting microphone...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 64000,
      });
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setStatus("Captured sample. You can play it back or submit.");
        stream.getTracks().forEach((t) => t.stop());
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
      await connect({
        getEphemeralKey: fetchEphemeralKey,
        initialAgents: [onboardingProfileAgent],
        audioElement: audioRef.current || undefined,
      });
      setChatMessage("Connected. The AI will greet you.");

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
      sendEvent({ type: "response.create" });

      // Start recording their mic-only sample alongside the chat
      if (!isRecording) {
        startRecording();
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

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const submitProfile = async () => {
    if (!audioBlob) {
      setError("Record an audio sample first.");
      return;
    }
    if (!name.trim()) {
      setError("Enter your name first.");
      return;
    }
    try {
      setStatus("Uploading profile to Transkriptor...");
      setError(null);
      const base64 = await blobToBase64(audioBlob);
      const resp = await fetch("/api/transkriptor/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speakerName: name.trim(),
          audioBase64: base64,
          profileSummary: summary.trim() || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || "Upload failed");
      }
      setResult({
        profileId: data.profileId,
        profileKey: data.profileKey,
        speakerName: data.speakerName,
        profileSummary: summary.trim() || undefined,
      });
      setStatus("Profile created and stored.");
    } catch (err: any) {
      console.error("submit error", err);
      setError(err?.message || "Failed to create profile");
      setStatus(null);
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
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Profile notes (optional)</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              rows={3}
              placeholder="e.g., prefers being called Alex; early-career designer; excited but a bit nervous."
            />
            <p className="text-xs text-gray-500">
              Quick facts to store with your voice (pronouns, interests, life stage, goals for the session).
            </p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={startGuidedChat}
              disabled={rtStatus !== "DISCONNECTED"}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm disabled:opacity-60"
            >
              {rtStatus === "CONNECTING" ? "Connecting..." : "Start guided chat"}
            </button>
            <button
              onClick={stopRecording}
              disabled={!isRecording}
              className="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm disabled:opacity-50"
            >
              Stop
            </button>
            <button
              onClick={submitProfile}
              disabled={!audioBlob || isRecording}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
            >
              Submit to Transkriptor
            </button>
          </div>
          <div className="bg-gray-50 border rounded-lg p-3 text-xs text-gray-700 space-y-1">
            <div className="font-semibold">AI chat status</div>
            <div>Connection: {chatStatus}</div>
            {chatMessage && <div>{chatMessage}</div>}
            {isRecording && <div className="text-emerald-700">Recording mic sample…</div>}
            {rtStatus === "CONNECTED" && (
              <button
                onClick={stopGuidedChat}
                className="mt-2 px-3 py-1.5 rounded bg-gray-200 text-gray-800 text-xs"
              >
                End chat
              </button>
            )}
          </div>
          <div className="bg-gray-50 border rounded-lg p-3 text-xs text-gray-700 space-y-1">
            <div className="font-semibold">Guided chat flow (what the AI will do)</div>
            <ul className="list-disc list-inside space-y-1">
              <li>Greet you by name, check pronunciation; ask you to say your name once.</li>
              <li>Ask: “How would you briefly describe yourself and where you are in life?”</li>
              <li>Ask: “What would you like to get out of the session?” with a light follow-up if short.</li>
              <li>End with a thank you and goodbye. We record only your mic (AI voice excluded).</li>
            </ul>
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
