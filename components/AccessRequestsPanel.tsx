"use client";

import { useCallback, useEffect, useState } from "react";

type AccessRequestStatus = "pending" | "approved" | "denied";

type AccessRequest = {
  id: string;
  name: string;
  email: string;
  message: string;
  status: AccessRequestStatus;
  created_at: string;
};

export function AccessRequestsPanel() {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/admin/access-requests");
      const { data } = await res.json();
      setRequests(Array.isArray(data) ? data : []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  async function updateStatus(id: string, status: "approved" | "denied") {
    setUpdatingId(id);
    try {
      const res = await fetch("/api/admin/access-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status })
      });
      if (res.ok) {
        setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
      }
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-soft">
      <h2 className="text-lg font-bold text-zinc-950">Access Requests</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-bold uppercase tracking-[0.12em] text-zinc-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Message</th>
              <th className="px-3 py-2">Submitted</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  Loading…
                </td>
              </tr>
            ) : requests.length > 0 ? (
              requests.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-3 font-semibold text-zinc-950">{r.name}</td>
                  <td className="px-3 py-3 text-zinc-600">{r.email}</td>
                  <td className="max-w-xs whitespace-pre-wrap px-3 py-3 text-zinc-600">{r.message}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-zinc-600">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => updateStatus(r.id, "approved")}
                        disabled={updatingId === r.id || r.status === "approved"}
                        className="rounded-md bg-green-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-800 disabled:opacity-40"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => updateStatus(r.id, "denied")}
                        disabled={updatingId === r.id || r.status === "denied"}
                        className="rounded-md bg-red-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-950 disabled:opacity-40"
                      >
                        Deny
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  No access requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: AccessRequestStatus }) {
  const styles: Record<AccessRequestStatus, string> = {
    pending: "bg-gray-100 text-zinc-700",
    approved: "bg-green-100 text-green-800",
    denied: "bg-red-100 text-red-800"
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${styles[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
