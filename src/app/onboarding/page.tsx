"use client";

import React, { useEffect, useRef, useState } from "react";

type ProfileResult = {
  profileId?: string;
  profileKey?: string;
  speakerName?: string;
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

export default function OnboardingPage() {
  const [name, setName] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProfileResult | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
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
        body: JSON.stringify({ speakerName: name.trim(), audioBase64: base64 }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || "Upload failed");
      }
      setResult({
        profileId: data.profileId,
        profileKey: data.profileKey,
        speakerName: data.speakerName,
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
            We’ll capture a short voice sample so the system can recognise you. Please speak clearly while you answer:
          </p>
          <ol className="list-decimal list-inside text-sm text-gray-700 space-y-1">
            <li>“How would you briefly describe yourself and where you are in your life?”</li>
            <li>“What would you like to get out of the upcoming session?”</li>
          </ol>
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
              onClick={startRecording}
              disabled={isRecording}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm disabled:opacity-60"
            >
              {isRecording ? "Recording..." : "Start Recording"}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
