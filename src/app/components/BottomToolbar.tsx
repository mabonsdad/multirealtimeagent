import React, { useState } from "react";
import { SessionStatus } from "@/app/types";

interface BottomToolbarProps {
  sessionStatus: SessionStatus;
  onToggleConnection: () => void;
  isPTTActive: boolean;
  setIsPTTActive: (val: boolean) => void;
  isPTTUserSpeaking: boolean;
  handleTalkButtonDown: () => void;
  handleTalkButtonUp: () => void;
  isAITalkHeld: boolean;
  handleAITalkButtonDown: () => void;
  handleAITalkButtonUp: () => void;
  isEventsPaneExpanded: boolean;
  setIsEventsPaneExpanded: (val: boolean) => void;
  isAudioPlaybackEnabled: boolean;
  setIsAudioPlaybackEnabled: (val: boolean) => void;
  isAIMuted: boolean;
  onToggleAIMute: () => void;
  isMicMuted: boolean;
  onToggleMicMute: () => void;
  codec: string;
  onCodecChange: (newCodec: string) => void;
}

function BottomToolbar({
  sessionStatus,
  onToggleConnection,
  isPTTActive,
  setIsPTTActive,
  isPTTUserSpeaking,
  handleTalkButtonDown,
  handleTalkButtonUp,
  isAITalkHeld,
  handleAITalkButtonDown,
  handleAITalkButtonUp,
  isEventsPaneExpanded,
  setIsEventsPaneExpanded,
  isAudioPlaybackEnabled,
  setIsAudioPlaybackEnabled,
  isAIMuted,
  onToggleAIMute,
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

  const modeSwitch = (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs uppercase tracking-wide text-gray-600">Mode</span>
      <button
        onClick={() => setIsPTTActive(!isPTTActive)}
        className={`relative inline-flex h-6 w-14 items-center rounded-full transition ${
          isPTTActive ? "bg-gray-900" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
            isPTTActive ? "translate-x-8" : "translate-x-1"
          }`}
        />
      </button>
      <span className="text-xs text-gray-600">
        {isPTTActive ? "Push to Talk" : "Hands-free"}
      </span>
    </div>
  );

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

        <div className="flex flex-row items-center gap-4">
          <div
            className={`flex flex-col gap-2 p-3 rounded-lg border min-w-[240px] ${
              isPTTActive
                ? "bg-gray-100 border-gray-200 opacity-60"
                : "bg-white border-gray-200"
            }`}
          >
            <div className="text-sm font-semibold text-gray-800">
              Hands-free controls
            </div>
            <div className="flex flex-row flex-wrap gap-2">
              <button
                onClick={onToggleAIMute}
                className={`text-white text-sm px-3 py-2 rounded-md ${
                  isAIMuted
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-gray-600 hover:bg-gray-700"
                } ${isPTTActive ? "opacity-50 cursor-not-allowed" : ""}`}
                disabled={isPTTActive}
              >
                {isAIMuted ? "AI Muted" : "Mute AI"}
              </button>
              <button
                onClick={onToggleMicMute}
                className={`text-white text-sm px-3 py-2 rounded-md ${
                  isMicMuted
                    ? "bg-red-500 hover:bg-red-600"
                    : "bg-gray-600 hover:bg-gray-700"
                } ${isPTTActive ? "opacity-50 cursor-not-allowed" : ""}`}
                disabled={!isConnected || isPTTActive}
              >
                {isMicMuted ? "Mic Muted" : "Mute Mic"}
              </button>
            </div>
          </div>

          {modeSwitch}

          <div
            className={`flex flex-col gap-2 p-3 rounded-lg border min-w-[240px] ${
              isPTTActive
                ? "bg-white border-gray-200"
                : "bg-gray-100 border-gray-200 opacity-60"
            }`}
          >
            <div className="text-sm font-semibold text-gray-800">
              Push to talk
            </div>
          <button
            onMouseDown={handleTalkButtonDown}
            onMouseUp={handleTalkButtonUp}
            onTouchStart={handleTalkButtonDown}
            onTouchEnd={handleTalkButtonUp}
            disabled={!isPTTActive}
            className={
              "py-2 px-4 rounded-md text-base transition-colors " +
              (isPTTActive
                ? isPTTUserSpeaking
                  ? "bg-green-600 text-white"
                  : "bg-gray-900 text-white hover:bg-black"
                : "bg-gray-100 text-gray-400 cursor-not-allowed")
            }
          >
            Push to Talk
          </button>
        </div>

        <div className="flex flex-col gap-2 p-3 rounded-lg border min-w-[240px] bg-white border-gray-200">
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
            className={
              "py-2 px-4 rounded-md text-base transition-colors " +
              (isAITalkHeld
                ? "bg-emerald-600 text-white"
                : "bg-gray-900 text-white hover:bg-black")
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

              <label className="flex items-center gap-2 text-sm">
                <input
                  id="logs"
                  type="checkbox"
                  checked={isEventsPaneExpanded}
                  onChange={(e) => setIsEventsPaneExpanded(e.target.checked)}
                  className="w-4 h-4"
                />
                Logs
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
