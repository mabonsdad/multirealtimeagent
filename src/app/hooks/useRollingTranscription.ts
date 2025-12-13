"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { convertWebMBlobToWav } from "../lib/audioUtils";

type Utterance = {
  speaker: string;
  start: number;
  end: number;
  text: string;
};

type JobStatus = "queued" | "processing" | "completed" | "error" | "unknown";

interface Job {
  jobId: string;
  status: JobStatus;
  chunkStartMs?: number;
  chunkEndMs?: number;
  utterances: Utterance[];
  error?: string;
}

export type SpeakerBlock = { speaker: string; text: string };

const DEFAULT_LAMBDA_BASE =
  process.env.NEXT_PUBLIC_TRANSCRIPT_LAMBDA_BASE_URL ||
  "https://7dbkxxj6b1.execute-api.eu-west-2.amazonaws.com/default";

const POLL_INTERVAL_MS = 5000;
export const FULL_TRANSCRIPT_CHUNK_MS = 30_000; // duration of each chunk sent to Lambda
export const FULL_TRANSCRIPT_HOP_MS = 20_000; // stride between chunks (10s overlap for stability)

// Helper: convert blob to base64 (no prefix)
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export function useRollingTranscription() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lambdaBase = useMemo(() => {
    const trimmed = DEFAULT_LAMBDA_BASE.trim().replace(/\/$/, "");
    return trimmed.endsWith("/default") ? trimmed : `${trimmed}/default`;
  }, []);

  const handleAudioChunk = useCallback(
    async (blob: Blob, chunkIndex: number) => {
      try {
        if (!blob || blob.size < 2000) {
          console.warn("Skipping tiny/empty audio chunk", {
            chunkIndex,
            bytes: blob?.size ?? 0,
          });
          return;
        }
        let uploadBlob = blob;
        // Try to normalize to WAV to satisfy AssemblyAI when browser emits octet-stream chunks.
        try {
          uploadBlob = await convertWebMBlobToWav(blob);
        } catch (err) {
          console.warn("Falling back to raw chunk; wav conversion failed", err);
          uploadBlob = blob;
        }

        const base64 = await blobToBase64(uploadBlob);
        const chunkStartMs = chunkIndex * FULL_TRANSCRIPT_HOP_MS;
        const chunkEndMs = chunkStartMs + FULL_TRANSCRIPT_CHUNK_MS;

        const url = `${lambdaBase}/diarise-chunk`;
        let rawText: string | undefined;

        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audio_base64: base64,
            chunkStartMs,
            chunkEndMs,
          }),
        });

        if (!resp.ok) {
          rawText = await resp.text().catch(() => "");
          let errBody: any = {};
          try {
            errBody = rawText ? JSON.parse(rawText) : {};
          } catch {
            errBody = { message: rawText };
          }
          console.error(
            `Failed to send chunk (status ${resp.status} ${resp.statusText})`,
            {
              body: errBody,
              raw: rawText,
              url,
              chunkIndex,
              chunkBytes: blob.size,
              uploadBytes: uploadBlob.size,
              uploadType: uploadBlob.type,
              chunkStartMs,
              chunkEndMs,
            }
          );
          setError(
            `Failed to send audio chunk (${resp.status} ${resp.statusText || ""}).`
          );
          return;
        }

        const data = await resp.json();
        const jobId: string = data.jobId;

        setJobs((prev) => [
          ...prev,
          {
            jobId,
            status: "queued",
            chunkStartMs: data.chunkStartMs,
            chunkEndMs: data.chunkEndMs,
            utterances: [],
          },
        ]);
      } catch (err) {
        console.error("Error handling audio chunk", err);
        setError("Error preparing or sending audio chunk.");
      }
    },
    [lambdaBase]
  );

  const pollPendingJobs = useCallback(async () => {
    setJobs((currentJobs) => {
      const pendingJobs = currentJobs.filter(
        (j) =>
          j.status === "queued" ||
          j.status === "processing" ||
          j.status === "unknown"
      );
      if (pendingJobs.length === 0) return currentJobs;

      Promise.all(
        pendingJobs.map(async (job) => {
          try {
            const url = new URL(`${lambdaBase}/diarisation-status`);
            url.searchParams.set("jobId", job.jobId);

            const resp = await fetch(url.toString());
            if (!resp.ok) {
              console.error("Status check failed for job", job.jobId, resp.status);
              return { ...job, status: "error" as JobStatus };
            }
            const data = await resp.json();
            const status = (data.status as JobStatus) || "unknown";
            const utterances = (data.utterances || []) as Utterance[];

            return {
              ...job,
              status,
              utterances,
              error: data.error,
            };
          } catch (err) {
            console.error("Polling error", err);
            return { ...job, status: "error" as JobStatus };
          }
        })
      ).then((updatedJobs) => {
        setJobs((latestJobs) =>
          latestJobs.map((job) => {
            const updatedJob = updatedJobs.find((u) => u.jobId === job.jobId);
            return updatedJob ? updatedJob : job;
          })
        );
      });

      return currentJobs;
    });
  }, [lambdaBase]);

  useEffect(() => {
    const hasPending = jobs.some(
      (j) =>
        j.status === "queued" ||
        j.status === "processing" ||
        j.status === "unknown"
    );
    if (!hasPending) return;

    // Kick off an immediate poll so UI updates quickly.
    pollPendingJobs();

    const interval = setInterval(() => {
      pollPendingJobs();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [jobs, pollPendingJobs]);

  const allUtterances: Utterance[] = useMemo(() => {
    const completedJobs = jobs.filter((j) => j.status === "completed");
    const utterancesWithJobOffset = completedJobs.flatMap((job) =>
      job.utterances.map((u) => ({
        ...u,
        start: (job.chunkStartMs ?? 0) + (u.start || 0),
        end: (job.chunkStartMs ?? 0) + (u.end || 0),
      }))
    );
    const sorted = utterancesWithJobOffset.sort((a, b) => a.start - b.start);

    // Drop overlapping utterances to avoid duplicate text from overlapped chunks.
    const merged: Utterance[] = [];
    let lastEnd = 0;
    for (const u of sorted) {
      if (u.start >= lastEnd - 200) {
        merged.push(u);
        lastEnd = Math.max(lastEnd, u.end);
      }
    }
    // Smooth speaker labels across jobs: remap speakers consistently by order of appearance.
    const seenMap = new Map<string, string>();
    let nextId = 1;
    return merged.map((u) => {
      if (!seenMap.has(u.speaker)) {
        seenMap.set(u.speaker, `spk_${nextId++}`);
      }
      return { ...u, speaker: seenMap.get(u.speaker) as string };
    });
  }, [jobs]);

  const speakerLabels = useMemo(() => {
    const speakers = Array.from(new Set(allUtterances.map((u) => u.speaker))).sort();
    const map: Record<string, string> = {};
    speakers.forEach((speaker, idx) => {
      map[speaker] = `Speaker ${idx + 1}`;
    });
    return map;
  }, [allUtterances]);

  const speakerBlocks: SpeakerBlock[] = useMemo(() => {
    const blocks: SpeakerBlock[] = [];
    let currentSpeaker: string | null = null;
    let currentText: string[] = [];

    for (const utterance of allUtterances) {
      if (utterance.speaker !== currentSpeaker) {
        if (currentSpeaker !== null) {
          blocks.push({
            speaker: currentSpeaker,
            text: currentText.join(" "),
          });
        }
        currentSpeaker = utterance.speaker;
        currentText = [utterance.text];
      } else {
        currentText.push(utterance.text);
      }
    }

    if (currentSpeaker !== null) {
      blocks.push({
        speaker: currentSpeaker,
        text: currentText.join(" "),
      });
    }

    return blocks;
  }, [allUtterances]);

  const hasPending = jobs.some(
    (j) =>
      j.status === "queued" ||
      j.status === "processing" ||
      j.status === "unknown"
  );

  const resetTranscription = useCallback(() => {
    setJobs([]);
    setError(null);
  }, []);

  return {
    handleAudioChunk,
    speakerBlocks,
    speakerLabels,
    hasPending,
    error,
    resetTranscription,
  };
}
