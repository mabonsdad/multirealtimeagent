"use client";

import React, { useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { SessionSetupConfig, SessionSetupSummary } from "@/app/lib/sessionSetupTypes";
import { DEFAULT_SESSION_SETUP_CONFIG } from "@/app/lib/sessionSetupDefaults";

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (config: SessionSetupConfig) => void;
  isSessionActive: boolean;
}

const NEW_SETUP_ID = "__new__";

export default function SessionSetupModal({
  open,
  onClose,
  onApply,
  isSessionActive,
}: Props) {
  const [setups, setSetups] = useState<SessionSetupSummary[]>([]);
  const [currentConfig, setCurrentConfig] = useState<SessionSetupConfig>(
    DEFAULT_SESSION_SETUP_CONFIG,
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const isActive = useMemo(
    () => activeId && currentConfig.id === activeId,
    [activeId, currentConfig.id],
  );

  const buildNewConfig = () => {
    const now = new Date().toISOString();
    return {
      ...DEFAULT_SESSION_SETUP_CONFIG,
      id: uuidv4().slice(0, 8),
      name: "New Session Setup",
      createdAt: now,
      updatedAt: now,
      prompts: { ...DEFAULT_SESSION_SETUP_CONFIG.prompts },
      voices: { ...DEFAULT_SESSION_SETUP_CONFIG.voices },
    } as SessionSetupConfig;
  };

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      setLoading(true);
      setError(null);
      setStatus(null);
      try {
        const listResp = await fetch("/api/session-setup");
        const listData = await listResp.json();
        if (!listResp.ok) {
          throw new Error(listData?.error || "Failed to load session setups");
        }
        setSetups(listData.setups || []);

        let activeConfig: SessionSetupConfig | null = null;
        try {
          const activeResp = await fetch("/api/session-setup?active=1");
          const activeData = await activeResp.json();
          if (activeResp.ok && activeData?.config) {
            activeConfig = activeData.config;
          }
        } catch {
          activeConfig = null;
        }

        if (activeConfig) {
          setActiveId(activeConfig.id);
          setSelectedId(activeConfig.id);
          setCurrentConfig(activeConfig);
        } else if (listData.setups?.length) {
          const first = listData.setups[0];
          setSelectedId(first.id);
          const cfgResp = await fetch(`/api/session-setup?id=${encodeURIComponent(first.id)}`);
          const cfgData = await cfgResp.json();
          if (cfgResp.ok && cfgData?.config) {
            setCurrentConfig(cfgData.config);
          } else {
            setCurrentConfig(buildNewConfig());
          }
        } else {
          const fresh = buildNewConfig();
          setSelectedId(NEW_SETUP_ID);
          setCurrentConfig(fresh);
        }
      } catch (err: any) {
        console.error("session setup load", err);
        setError(err?.message || "Failed to load session setups");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [open]);

  const loadConfigById = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/session-setup?id=${encodeURIComponent(id)}`);
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || "Failed to load setup");
      }
      setCurrentConfig(data.config);
    } catch (err: any) {
      console.error("load setup", err);
      setError(err?.message || "Failed to load setup");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectChange = async (value: string) => {
    setStatus(null);
    setError(null);
    if (value === NEW_SETUP_ID) {
      const fresh = buildNewConfig();
      setSelectedId(NEW_SETUP_ID);
      setCurrentConfig(fresh);
      return;
    }
    setSelectedId(value);
    await loadConfigById(value);
  };

  const handleSave = async (setActive: boolean) => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const resp = await fetch("/api/session-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: currentConfig, setActive }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || "Failed to save setup");
      }
      const saved = data.config as SessionSetupConfig;
      setCurrentConfig(saved);
      setStatus(setActive ? "Active setup updated." : "Setup saved.");
      if (setActive) {
        setActiveId(saved.id);
        onApply(saved);
      }
      setSelectedId(saved.id);
      setSetups((prev) => {
        const exists = prev.some((p) => p.id === saved.id);
        const summary: SessionSetupSummary = {
          id: saved.id,
          name: saved.name,
          description: saved.description,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        };
        if (exists) {
          return prev.map((p) => (p.id === saved.id ? summary : p));
        }
        return [summary, ...prev];
      });
    } catch (err: any) {
      console.error("save setup", err);
      setError(err?.message || "Failed to save setup");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <div className="font-semibold">Session Setup</div>
            <div className="text-xs text-gray-500">
              Configure host and onboarding prompts before starting a session.
            </div>
          </div>
          <button className="text-sm text-gray-600 hover:text-gray-900" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="p-5 overflow-auto space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label className="text-xs font-semibold text-gray-600">Session setup</label>
              <select
                value={selectedId || currentConfig.id}
                onChange={(e) => handleSelectChange(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm"
              >
                {setups.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value={NEW_SETUP_ID}>+ New setup</option>
              </select>
            </div>
            <button
              disabled={saving || loading}
              onClick={() => handleSave(false)}
              className="text-xs px-3 py-2 rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              Save
            </button>
            <button
              disabled={saving || loading || isSessionActive}
              onClick={() => handleSave(true)}
              className="text-xs px-3 py-2 rounded-md bg-emerald-600 text-white disabled:opacity-50"
              title={isSessionActive ? "Reconnect to apply changes" : undefined}
            >
              Use for session
            </button>
            {isActive && (
              <span className="text-xs px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">
                Active
              </span>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-gray-600">Setup name</label>
              <input
                value={currentConfig.name}
                onChange={(e) =>
                  setCurrentConfig({ ...currentConfig, name: e.target.value })
                }
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600">Description</label>
              <input
                value={currentConfig.description || ""}
                onChange={(e) =>
                  setCurrentConfig({
                    ...currentConfig,
                    description: e.target.value || undefined,
                  })
                }
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </div>
          </div>

          {loading && <div className="text-sm text-gray-500">Loading...</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {status && <div className="text-sm text-emerald-700">{status}</div>}
          {isSessionActive && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              Session is active. Changes apply after disconnect/reconnect.
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-semibold">Host voice prompt</div>
              <div className="text-xs text-gray-500">
                Instructions for the main host AI (tone, flow, constraints).
              </div>
              <textarea
                value={currentConfig.prompts.hostVoiceInstructions}
                onChange={(e) =>
                  setCurrentConfig({
                    ...currentConfig,
                    prompts: {
                      ...currentConfig.prompts,
                      hostVoiceInstructions: e.target.value,
                    },
                  })
                }
                className="w-full min-h-[220px] border rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Scenario planner tool prompt</div>
              <div className="text-xs text-gray-500">
                Used by the planner tool to decide phases and next steps.
              </div>
              <textarea
                value={currentConfig.prompts.scenarioPlannerSystemPrompt}
                onChange={(e) =>
                  setCurrentConfig({
                    ...currentConfig,
                    prompts: {
                      ...currentConfig.prompts,
                      scenarioPlannerSystemPrompt: e.target.value,
                    },
                  })
                }
                className="w-full min-h-[160px] border rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Participant insights tool prompt</div>
              <div className="text-xs text-gray-500">
                Used to track who has spoken, likes/dislikes, and suggestions.
              </div>
              <textarea
                value={currentConfig.prompts.participantExperienceSystemPrompt}
                onChange={(e) =>
                  setCurrentConfig({
                    ...currentConfig,
                    prompts: {
                      ...currentConfig.prompts,
                      participantExperienceSystemPrompt: e.target.value,
                    },
                  })
                }
                className="w-full min-h-[180px] border rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Cake options tool prompt</div>
              <div className="text-xs text-gray-500">
                Used to generate concrete cake suggestions with constraints.
              </div>
              <textarea
                value={currentConfig.prompts.cakeOptionsSystemPrompt}
                onChange={(e) =>
                  setCurrentConfig({
                    ...currentConfig,
                    prompts: {
                      ...currentConfig.prompts,
                      cakeOptionsSystemPrompt: e.target.value,
                    },
                  })
                }
                className="w-full min-h-[180px] border rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Onboarding prompt</div>
              <div className="text-xs text-gray-500">
                Used by the onboarding agent to greet and gather profile info.
              </div>
              <textarea
                value={currentConfig.prompts.onboardingInstructions}
                onChange={(e) =>
                  setCurrentConfig({
                    ...currentConfig,
                    prompts: {
                      ...currentConfig.prompts,
                      onboardingInstructions: e.target.value,
                    },
                  })
                }
                className="w-full min-h-[180px] border rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
