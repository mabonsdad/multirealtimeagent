"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  SessionSetupChapter,
  SessionSetupConfig,
  SessionSetupScenario,
  SessionSetupSummary,
} from "@/app/lib/sessionSetupTypes";
import { DEFAULT_SESSION_SETUP_CONFIG } from "@/app/lib/sessionSetupDefaults";

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (config: SessionSetupConfig) => void;
  isSessionActive: boolean;
}

const NEW_SETUP_ID = "__new__";
type KnowledgeBaseFile = {
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "session-setup";

const getKnowledgeBaseFolder = (config: SessionSetupConfig) =>
  config.knowledgeBaseFolder || slugify(config.name || config.id);

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
  const [kbFiles, setKbFiles] = useState<KnowledgeBaseFile[]>([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbUploading, setKbUploading] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  const [kbStatus, setKbStatus] = useState<string | null>(null);
  const [kbFile, setKbFile] = useState<File | null>(null);

  const isActive = useMemo(
    () => activeId && currentConfig.id === activeId,
    [activeId, currentConfig.id],
  );
  const knowledgeBaseFolder = useMemo(
    () => getKnowledgeBaseFolder(currentConfig),
    [currentConfig.id, currentConfig.name, currentConfig.knowledgeBaseFolder],
  );

  const buildNewConfig = () => {
    const now = new Date().toISOString();
    const name = "New Session Setup";
    return {
      ...DEFAULT_SESSION_SETUP_CONFIG,
      id: uuidv4().slice(0, 8),
      name,
      createdAt: now,
      updatedAt: now,
      knowledgeBaseFolder: slugify(name),
      prompts: { ...DEFAULT_SESSION_SETUP_CONFIG.prompts },
      voices: { ...DEFAULT_SESSION_SETUP_CONFIG.voices },
      scenario: DEFAULT_SESSION_SETUP_CONFIG.scenario
        ? JSON.parse(JSON.stringify(DEFAULT_SESSION_SETUP_CONFIG.scenario))
        : undefined,
    } as SessionSetupConfig;
  };

  const normalizeConfig = useCallback(
    (config: SessionSetupConfig) => {
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
      const normalized: SessionSetupConfig = {
        ...DEFAULT_SESSION_SETUP_CONFIG,
        ...config,
        prompts: mergedPrompts,
        knowledgeBaseFolder:
          config.knowledgeBaseFolder ||
          getKnowledgeBaseFolder({ ...config, prompts: mergedPrompts }),
      };
      return normalized;
    },
    [],
  );

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
          setCurrentConfig(normalizeConfig(activeConfig));
        } else if (listData.setups?.length) {
          const first = listData.setups[0];
          setSelectedId(first.id);
          const cfgResp = await fetch(`/api/session-setup?id=${encodeURIComponent(first.id)}`);
          const cfgData = await cfgResp.json();
          if (cfgResp.ok && cfgData?.config) {
            setCurrentConfig(normalizeConfig(cfgData.config));
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
      setCurrentConfig(normalizeConfig(data.config));
    } catch (err: any) {
      console.error("load setup", err);
      setError(err?.message || "Failed to load setup");
    } finally {
      setLoading(false);
    }
  };

  const loadKnowledgeBaseFiles = useCallback(async (folder: string) => {
    if (!folder) return;
    setKbLoading(true);
    setKbError(null);
    try {
      const resp = await fetch(
        `/api/knowledge-base?folder=${encodeURIComponent(folder)}`,
      );
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || "Failed to load knowledge base");
      }
      setKbFiles(data.files || []);
    } catch (err: any) {
      console.error("knowledge base load", err);
      setKbError(err?.message || "Failed to load knowledge base docs");
    } finally {
      setKbLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !knowledgeBaseFolder) return;
    loadKnowledgeBaseFiles(knowledgeBaseFolder);
  }, [open, knowledgeBaseFolder, loadKnowledgeBaseFiles]);

  useEffect(() => {
    setKbFile(null);
    setKbStatus(null);
    setKbError(null);
  }, [knowledgeBaseFolder]);

  const handleUploadKnowledgeDoc = async () => {
    if (!kbFile) return;
    setKbUploading(true);
    setKbError(null);
    setKbStatus(null);
    try {
      const formData = new FormData();
      formData.append("folder", knowledgeBaseFolder);
      formData.append("file", kbFile);
      const resp = await fetch("/api/knowledge-base", {
        method: "POST",
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || "Failed to upload document");
      }
      setKbStatus("Document uploaded.");
      setKbFile(null);
      await loadKnowledgeBaseFiles(knowledgeBaseFolder);
    } catch (err: any) {
      console.error("knowledge base upload", err);
      setKbError(err?.message || "Failed to upload document");
    } finally {
      setKbUploading(false);
    }
  };

  const handleDeleteKnowledgeDoc = async (name: string) => {
    setKbError(null);
    setKbStatus(null);
    try {
      const resp = await fetch(
        `/api/knowledge-base?folder=${encodeURIComponent(
          knowledgeBaseFolder,
        )}&name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || "Failed to delete document");
      }
      setKbStatus("Document deleted.");
      await loadKnowledgeBaseFiles(knowledgeBaseFolder);
    } catch (err: any) {
      console.error("knowledge base delete", err);
      setKbError(err?.message || "Failed to delete document");
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
      const baseConfig = currentConfig.scenario
        ? currentConfig
        : { ...currentConfig, scenario: scenarioValue };
      const configToSave = {
        ...baseConfig,
        knowledgeBaseFolder:
          baseConfig.knowledgeBaseFolder || knowledgeBaseFolder,
      };
      const resp = await fetch("/api/session-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: configToSave, setActive }),
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

  const scenarioValue: SessionSetupScenario = useMemo(() => {
    if (currentConfig.scenario) return currentConfig.scenario;
    if (DEFAULT_SESSION_SETUP_CONFIG.scenario) {
      return JSON.parse(
        JSON.stringify(DEFAULT_SESSION_SETUP_CONFIG.scenario),
      ) as SessionSetupScenario;
    }
    return { title: "Scenario", chapters: [] };
  }, [currentConfig.scenario]);

  const chapterTimingStatus = useMemo(() => {
    const totalMinutes = scenarioValue.totalMinutes ?? 0;
    const targets = (scenarioValue.chapters || []).map(
      (chapter) => chapter.targetMinutes || 0,
    );
    const sum = targets.reduce((acc, val) => acc + val, 0);
    const hasTotal = Boolean(scenarioValue.totalMinutes);
    const delta = hasTotal ? sum - totalMinutes : 0;
    return { totalMinutes, sum, delta, hasTotal };
  }, [scenarioValue]);

  const applyScenarioUpdate = (nextScenario: SessionSetupScenario) => {
    setCurrentConfig({ ...currentConfig, scenario: nextScenario });
  };

  const updateScenarioField = <K extends keyof SessionSetupScenario>(
    field: K,
    value: SessionSetupScenario[K],
  ) => {
    applyScenarioUpdate({ ...scenarioValue, [field]: value });
  };

  const updateChapter = (index: number, patch: Partial<SessionSetupChapter>) => {
    const chapters = [...(scenarioValue.chapters || [])];
    const existing = chapters[index] || { id: uuidv4().slice(0, 8) };
    chapters[index] = { ...existing, ...patch };
    applyScenarioUpdate({ ...scenarioValue, chapters });
  };

  const removeChapter = (index: number) => {
    const chapters = [...(scenarioValue.chapters || [])];
    chapters.splice(index, 1);
    applyScenarioUpdate({ ...scenarioValue, chapters });
  };

  const moveChapter = (index: number, direction: number) => {
    const chapters = [...(scenarioValue.chapters || [])];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= chapters.length) return;
    const temp = chapters[index];
    chapters[index] = chapters[nextIndex];
    chapters[nextIndex] = temp;
    applyScenarioUpdate({ ...scenarioValue, chapters });
  };

  const addChapter = () => {
    const chapters = [...(scenarioValue.chapters || [])];
    const nextIndex = chapters.length + 1;
    chapters.push({
      id: `chapter_${nextIndex}`,
      title: `Chapter ${nextIndex}`,
      goal: "",
      targetMinutes: 2,
      hostPrompt: "",
      toolCadence: "medium",
      notes: "",
    });
    applyScenarioUpdate({ ...scenarioValue, chapters });
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
              <div className="text-sm font-semibold">Scenario and chapters</div>
              <div className="text-xs text-gray-500">
                Define the scenario and chapter timing for long or short sessions.
              </div>
              <div className="grid md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-600">Scenario title</label>
                  <input
                    value={scenarioValue.title}
                    onChange={(e) => updateScenarioField("title", e.target.value)}
                    className="w-full border rounded-md px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600">Total minutes</label>
                  <input
                    type="number"
                    min={1}
                    value={scenarioValue.totalMinutes ?? ""}
                    onChange={(e) =>
                      updateScenarioField(
                        "totalMinutes",
                        Number(e.target.value) || undefined,
                      )
                    }
                    className="w-full border rounded-md px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600">Scenario summary</label>
                  <input
                    value={scenarioValue.summary || ""}
                    onChange={(e) =>
                      updateScenarioField("summary", e.target.value || undefined)
                    }
                    className="w-full border rounded-md px-2 py-1 text-sm"
                  />
                </div>
              </div>
              {chapterTimingStatus.hasTotal ? (
                <div
                  className={`text-xs ${
                    chapterTimingStatus.delta === 0
                      ? "text-emerald-700"
                      : "text-amber-700"
                  }`}
                >
                  Chapter targets total {chapterTimingStatus.sum} min.{" "}
                  {chapterTimingStatus.delta === 0
                    ? "Matches the session total."
                    : chapterTimingStatus.delta > 0
                      ? `Over by ${chapterTimingStatus.delta} min.`
                      : `Under by ${Math.abs(
                          chapterTimingStatus.delta,
                        )} min.`}
                </div>
              ) : (
                <div className="text-xs text-gray-500">
                  Set total minutes to check chapter timing.
                </div>
              )}

              <div className="space-y-3">
                {scenarioValue.chapters.map((chapter, index) => (
                  <div
                    key={chapter.id || `${index}`}
                    className="border border-gray-200 rounded-md p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold text-gray-700">
                        Chapter {index + 1}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => moveChapter(index, -1)}
                          className="text-xs px-2 py-1 border rounded-md"
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          onClick={() => moveChapter(index, 1)}
                          className="text-xs px-2 py-1 border rounded-md"
                        >
                          Down
                        </button>
                        <button
                          type="button"
                          onClick={() => removeChapter(index)}
                          className="text-xs px-2 py-1 border rounded-md text-red-600"
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-3 gap-2">
                      <div>
                        <label className="text-xs text-gray-600">ID</label>
                        <input
                          value={chapter.id}
                          onChange={(e) =>
                            updateChapter(index, { id: e.target.value })
                          }
                          className="w-full border rounded-md px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-600">Title</label>
                        <input
                          value={chapter.title || ""}
                          onChange={(e) =>
                            updateChapter(index, { title: e.target.value })
                          }
                          className="w-full border rounded-md px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-600">Target minutes</label>
                        <input
                          type="number"
                          min={0}
                          value={chapter.targetMinutes ?? ""}
                          onChange={(e) =>
                            updateChapter(index, {
                              targetMinutes: Number(e.target.value) || undefined,
                            })
                          }
                          className="w-full border rounded-md px-2 py-1 text-xs"
                        />
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-600">Goal</label>
                        <textarea
                          value={chapter.goal || ""}
                          onChange={(e) =>
                            updateChapter(index, { goal: e.target.value })
                          }
                          className="w-full min-h-[60px] border rounded-md px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-600">Host prompt</label>
                        <textarea
                          value={chapter.hostPrompt || ""}
                          onChange={(e) =>
                            updateChapter(index, { hostPrompt: e.target.value })
                          }
                          className="w-full min-h-[60px] border rounded-md px-2 py-1 text-xs"
                        />
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-600">Tool cadence</label>
                        <select
                          value={chapter.toolCadence || ""}
                          onChange={(e) =>
                            updateChapter(index, { toolCadence: e.target.value })
                          }
                          className="w-full border rounded-md px-2 py-1 text-xs"
                        >
                          <option value="">(unset)</option>
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-600">Notes</label>
                        <textarea
                          value={chapter.notes || ""}
                          onChange={(e) =>
                            updateChapter(index, { notes: e.target.value })
                          }
                          className="w-full min-h-[60px] border rounded-md px-2 py-1 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addChapter}
                className="text-xs px-3 py-2 rounded-md border border-gray-300 bg-white hover:bg-gray-50"
              >
                + Add chapter
              </button>
            </div>

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
              <div className="text-sm font-semibold">Knowledge Base tool prompt</div>
              <div className="text-xs text-gray-500">
                Used to answer factual questions using uploaded docs (and web if needed).
              </div>
              <textarea
                value={currentConfig.prompts.knowledgeBaseSystemPrompt}
                onChange={(e) =>
                  setCurrentConfig({
                    ...currentConfig,
                    prompts: {
                      ...currentConfig.prompts,
                      knowledgeBaseSystemPrompt: e.target.value,
                    },
                  })
                }
                className="w-full min-h-[180px] border rounded-md px-3 py-2 text-xs font-mono"
              />
              <div className="rounded-md border px-3 py-2 space-y-2">
                <div className="text-xs text-gray-500">
                  Folder: <span className="font-mono">knowledgebase/{knowledgeBaseFolder}</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    className="text-xs"
                    onChange={(e) => setKbFile(e.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    onClick={handleUploadKnowledgeDoc}
                    disabled={!kbFile || kbUploading}
                    className="px-3 py-1 rounded-md text-xs border bg-white disabled:opacity-50"
                  >
                    {kbUploading ? "Uploading..." : "Upload"}
                  </button>
                </div>
                <div className="text-xs text-gray-400">
                  Tip: upload text-based files (txt, md, json, csv).
                </div>
                {kbStatus && (
                  <div className="text-xs text-emerald-600">{kbStatus}</div>
                )}
                {kbError && (
                  <div className="text-xs text-red-600">{kbError}</div>
                )}
                <div className="max-h-36 overflow-auto text-xs space-y-1">
                  {kbLoading ? (
                    <div className="text-gray-500">Loading documents...</div>
                  ) : kbFiles.length ? (
                    kbFiles.map((file) => (
                      <div
                        key={file.key}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => handleDeleteKnowledgeDoc(file.name)}
                          className="text-red-600 text-xs"
                        >
                          Delete
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="text-gray-500">No documents uploaded yet.</div>
                  )}
                </div>
              </div>
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
