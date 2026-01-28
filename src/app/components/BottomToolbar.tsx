import React, { useState } from "react";
import { SessionStatus } from "@/app/types";

interface BottomToolbarProps {
  sessionStatus: SessionStatus;
  onToggleConnection: () => void;
  isAITalkHeld: boolean;
  handleAITalkButtonDown: () => void;
  handleAITalkButtonUp: () => void;
  isAudioPlaybackEnabled: boolean;
  setIsAudioPlaybackEnabled: (val: boolean) => void;
  isMicMuted: boolean;
  onToggleMicMute: () => void;
  codec: string;
  onCodecChange: (newCodec: string) => void;
}

function BottomToolbar({
  sessionStatus,
  onToggleConnection,
  isAITalkHeld,
  handleAITalkButtonDown,
  handleAITalkButtonUp,
  isAudioPlaybackEnabled,
  setIsAudioPlaybackEnabled,
  isMicMuted,
  onToggleMicMute,
  codec,
  onCodecChange,
}: BottomToolbarProps) {
  const isConnected = sessionStatus === "CONNECTED";
  const isConnecting = sessionStatus === "CONNECTING";
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleCodecChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newCodec = e.target.value;
    onCodecChange(newCodec);
  };

  function getConnectionButtonLabel() {
    if (isConnected) return "Disconnect";
    if (isConnecting) return "Connecting...";
    return "Connect";
  }

  function getConnectionButtonClasses() {
    const baseClasses = "text-white text-base p-2 w-36 rounded-md h-full";
    const cursorClass = isConnecting ? "cursor-not-allowed" : "cursor-pointer";

    if (isConnected) {
      // Connected -> label "Disconnect" -> green
      return `bg-green-600 hover:bg-green-700 ${cursorClass} ${baseClasses}`;
    }
    // Disconnected or connecting -> label is either "Connect" or "Connecting" -> black
    return `bg-black hover:bg-gray-900 ${cursorClass} ${baseClasses}`;
  }

  return (
    <div className="p-4 flex flex-wrap items-center gap-4 justify-between">
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onToggleConnection}
          className={getConnectionButtonClasses()}
          disabled={isConnecting}
        >
          {getConnectionButtonLabel()}
        </button>

        <div className="flex flex-row items-center gap-3">
          <button
            onClick={onToggleMicMute}
            className={`text-xs px-3 py-1.5 rounded-md border ${
              isMicMuted
                ? "bg-red-600 text-white border-red-600"
                : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
            } ${!isConnected ? "opacity-50 cursor-not-allowed" : ""}`}
            disabled={!isConnected}
          >
            {isMicMuted ? "Mic Muted" : "Mic On"}
          </button>

          <div className="flex flex-col gap-2 p-3 rounded-lg border min-w-[220px] bg-white border-gray-200">
            <div className="text-sm font-semibold text-gray-800">
              AI speak control
            </div>
            <div className="text-xs text-gray-600">
              {isAITalkHeld ? "Speaking enabled" : "Listen-only (silent)"}
            </div>
            <button
              onMouseDown={handleAITalkButtonDown}
              onMouseUp={handleAITalkButtonUp}
              onMouseLeave={handleAITalkButtonUp}
              onTouchStart={handleAITalkButtonDown}
              onTouchEnd={handleAITalkButtonUp}
              disabled={!isConnected}
              className={
                "py-2 px-4 rounded-md text-base transition-colors " +
                (isAITalkHeld
                  ? "bg-emerald-600 text-white"
                  : "bg-gray-900 text-white hover:bg-black") +
                (isConnected ? "" : " opacity-50 cursor-not-allowed")
              }
            >
              Hold to let AI speak
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={() => setIsSettingsOpen(true)}
        className="ml-auto flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-5 w-5"
        >
          <path d="M11.983 1.566a2 2 0 0 0-3.966 0l-.123.986a6.045 6.045 0 0 0-1.213.508l-.91-.546a2 2 0 0 0-2.732.732l-.5.866a2 2 0 0 0 .732 2.732l.847.508a6.08 6.08 0 0 0 0 1.417l-.847.508a2 2 0 0 0-.732 2.732l.5.866a2 2 0 0 0 2.732.732l.91-.546c.389.22.796.402 1.213.55l.123.986a2 2 0 0 0 3.966 0l.123-.986c.417-.148.824-.33 1.213-.55l.91.546a2 2 0 0 0 2.732-.732l.5-.866a2 2 0 0 0-.732-2.732l-.847-.508a6.08 6.08 0 0 0 0-1.417l.847-.508a2 2 0 0 0 .732-2.732l-.5-.866a2 2 0 0 0-2.732-.732l-.91.546a6.045 6.045 0 0 0-1.213-.508l-.123-.986Z" />
          <path d="M10 13.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
        </svg>
        Settings
      </button>

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-xl shadow-xl p-5 w-[360px] max-w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-800">Settings</h3>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="text-gray-500 hover:text-gray-800"
                aria-label="Close settings"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="audio-playback"
                  type="checkbox"
                  checked={isAudioPlaybackEnabled}
                  onChange={(e) => setIsAudioPlaybackEnabled(e.target.checked)}
                  disabled={!isConnected}
                  className="w-4 h-4"
                />
                Audio playback
              </label>

              <div className="flex flex-col gap-1 text-sm">
                <span>Codec</span>
                <select
                  id="codec-select"
                  value={codec}
                  onChange={handleCodecChange}
                  className="border border-gray-300 rounded-md px-2 py-1 focus:outline-none cursor-pointer"
                >
                  <option value="opus">Opus (48 kHz)</option>
                  <option value="pcmu">PCMU (8 kHz)</option>
                  <option value="pcma">PCMA (8 kHz)</option>
                </select>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="px-4 py-2 text-sm rounded-md bg-gray-900 text-white hover:bg-black"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default BottomToolbar;
