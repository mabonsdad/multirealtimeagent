"use client";

import React, { useEffect, useRef } from "react";
import type { SpeakerBlock } from "@/app/hooks/useRollingTranscription";

interface FullTranscriptProps {
  speakerBlocks: SpeakerBlock[];
  speakerLabels: Record<string, string>;
  isLoading: boolean;
  hasPending: boolean;
  error?: string | null;
}

function FullTranscript({
  speakerBlocks,
  speakerLabels,
  isLoading,
  hasPending,
  error,
}: FullTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [speakerBlocks]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between px-6 py-2 text-xs text-gray-500">
        <div>
          {isLoading
            ? "Updating transcript..."
            : speakerBlocks.length
            ? "Live transcript"
            : "Waiting for first chunk..."}
        </div>
        {error && <div className="text-red-600">{error}</div>}
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto px-6 pb-4 space-y-3 text-sm text-gray-800"
      >
        {speakerBlocks.length === 0 && (
            <p className="text-gray-500 text-sm">
              Start speaking to see a rolling transcript with speaker labels.
            </p>
          )}
          {speakerBlocks.map((block, idx) => {
            const rawLabel = speakerLabels[block.speaker] || block.speaker;
            const friendly =
              rawLabel.startsWith("SPK_") && rawLabel.length <= 8
                ? `Speaker ${rawLabel.split("_")[1] || ""}`.trim()
                : rawLabel.startsWith("User#")
                ? "User"
                : rawLabel.length > 18
                ? `${rawLabel.slice(0, 8)}…`
                : rawLabel;
            const isLast = idx === speakerBlocks.length - 1;
            return (
              <div
                key={`${block.speaker}-${idx}`}
                className="flex gap-3 items-start bg-gray-50 rounded-lg px-3 py-2"
              >
              <div className="mt-0.5 flex-shrink-0 w-24 text-xs font-semibold text-gray-700">
                {friendly}
              </div>
              <div className="text-sm leading-relaxed text-gray-900 whitespace-pre-wrap">
                {block.text}{" "}
                {isLast && hasPending && (
                  <span className="inline-block animate-pulse">…</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default FullTranscript;
