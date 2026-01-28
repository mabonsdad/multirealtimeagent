"use client";

import React, { useEffect, useMemo, useState } from "react";

import type { ProfileRecord } from "@/app/lib/profileTypes";

interface Props {
  open: boolean;
  onClose: () => void;
  selectedProfiles: ProfileRecord[];
  onSelectionChange: (profiles: ProfileRecord[]) => void;
}

export default function ProfileManagerModal({
  open,
  onClose,
  selectedProfiles,
  onSelectionChange,
}: Props) {
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  const selectedKeys = useMemo(
    () => new Set(selectedProfiles.map((p) => p.profileKey)),
    [selectedProfiles],
  );

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch("/api/transkriptor/profiles");
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || "Load failed");
        setProfiles(data.profiles || []);
      } catch (err: any) {
        console.error("load profiles", err);
        setError(err?.message || "Failed to load profiles");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [open]);

  const handleDelete = async (profileKey: string) => {
    setDeleteBusy(profileKey);
    setError(null);
    try {
      const resp = await fetch(`/api/transkriptor/profiles?profileKey=${encodeURIComponent(profileKey)}`, {
        method: "DELETE",
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || "Delete failed");
      setProfiles((prev) =>
        prev.map((p) =>
          p.profileKey === profileKey ? { ...p, active: false, archivedAt: new Date().toISOString() } : p,
        ),
      );
    } catch (err: any) {
      console.error("delete profile", err);
      setError(err?.message || "Delete failed");
    } finally {
      setDeleteBusy(null);
    }
  };

  const handleToggleSelection = (profile: ProfileRecord) => {
    const exists = selectedKeys.has(profile.profileKey);
    const next = exists
      ? selectedProfiles.filter((p) => p.profileKey !== profile.profileKey)
      : [...selectedProfiles, profile];
    onSelectionChange(next);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <div className="font-semibold">Transkriptor Profiles</div>
            <div className="text-xs text-gray-500">Active on Transkriptor (max 20) vs archived locally.</div>
            <div className="text-xs text-gray-500">
              Selected for session: {selectedProfiles.length}
            </div>
          </div>
          <button className="text-sm text-gray-600 hover:text-gray-900" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="p-5 overflow-auto space-y-3">
          {loading && <div className="text-sm text-gray-600">Loading...</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {!loading && profiles.length === 0 && (
            <div className="text-sm text-gray-500">No profiles stored yet.</div>
          )}
          {profiles.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-gray-600 border-b">
                <tr>
                  <th className="py-2 w-24">In session</th>
                  <th className="py-2">Name</th>
                  <th className="py-2">Profile ID</th>
                  <th className="py-2">Created</th>
                  <th className="py-2">Status</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const isActive = p.active !== false;
                  return (
                    <tr key={p.profileKey} className="border-b last:border-0">
                      <td className="py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={selectedKeys.has(p.profileKey)}
                          onChange={() => handleToggleSelection(p)}
                          aria-label={`Include ${p.speakerName} in session`}
                        />
                      </td>
                      <td className="py-2">{p.speakerName}</td>
                      <td className="py-2">{p.profileId || "—"}</td>
                      <td className="py-2">
                        {p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}
                      </td>
                      <td className="py-2">
                        <span
                          className={`px-2 py-1 rounded-full text-xs ${
                            isActive ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {isActive ? "Active" : "Archived"}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <button
                          disabled={!isActive || deleteBusy === p.profileKey}
                          onClick={() => handleDelete(p.profileKey)}
                          className="text-xs px-3 py-1 rounded-md bg-red-50 text-red-700 disabled:opacity-50"
                        >
                          {deleteBusy === p.profileKey ? "Deleting..." : "Delete remote"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
