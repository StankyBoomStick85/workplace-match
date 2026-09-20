"use client";

import { useEffect, useRef, useState } from "react";
import {
  dismissNotification,
  markNotificationsRead,
  markSingleNotificationRead,
  refreshContactNotifications,
  type ContactNotification
} from "../lib/contactPreferences";
import { logAdminEvent } from "../lib/adminEvents";
import { supabase } from "../lib/supabase";

const EXTRACT_ALERTS_KEY = "wm_extract_alerts";

function loadStoredAlerts(): string[] {
  try {
    return JSON.parse(localStorage.getItem(EXTRACT_ALERTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveStoredAlerts(alerts: string[]) {
  try {
    localStorage.setItem(EXTRACT_ALERTS_KEY, JSON.stringify(alerts));
  } catch {}
}

export function NotificationBell({
  recipientEmail,
  recipientUserId
}: {
  recipientEmail: string;
  recipientUserId?: string;
}) {
  const [notifications, setNotifications] = useState<ContactNotification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [extractAlerts, setExtractAlerts] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return loadStoredAlerts();
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const unreadNotificationCount = notifications.filter((notification) => notification.status === "unread").length;
  const unreadCount = unreadNotificationCount + extractAlerts.length;

  function scopeToRecipient(list: ContactNotification[]) {
    return list.filter(
      (notification) => notification.recipientEmail.trim().toLowerCase() === recipientEmail.trim().toLowerCase()
    );
  }

  useEffect(() => {
    refreshNotifications();
    window.addEventListener("storage", refreshNotifications);
    window.addEventListener("workplace-match-notifications-updated", refreshNotifications);
    window.addEventListener("workplace-match-extraction-complete", handleExtractionComplete);

    return () => {
      window.removeEventListener("storage", refreshNotifications);
      window.removeEventListener("workplace-match-notifications-updated", refreshNotifications);
      window.removeEventListener("workplace-match-extraction-complete", handleExtractionComplete);
    };

    async function refreshNotifications() {
      setNotifications(await refreshContactNotifications(recipientEmail));
    }

    function handleExtractionComplete(e: Event) {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      if (detail?.message) {
        setExtractAlerts((prev) => {
          const next = [...prev, detail.message];
          saveStoredAlerts(next);
          return next;
        });
      }
    }
  }, [recipientEmail]);

  // Cross-session live updates: the in-tab "workplace-match-notifications-updated"
  // event above only reaches this bell when THIS tab triggered the change (e.g.
  // this user sent a message). A notification written by the OTHER party in a
  // different browser/session needs Realtime to arrive without a page reload.
  useEffect(() => {
    if (!recipientUserId) {
      return;
    }

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const channelName = `notifications:${recipientUserId}`;

    // See the matching comment in lib/useMatchThreadRealtime.ts - RLS-protected
    // postgres_changes needs the JWT on the socket before subscribing, or the
    // channel reports SUBSCRIBED but never delivers anything.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) {
        return;
      }
      if (!session) {
        console.warn("[NotificationBell] No auth session - skipping realtime subscribe", { channelName });
        return;
      }
      supabase.realtime.setAuth(session.access_token);

      channel = supabase
        .channel(channelName)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${recipientUserId}` },
          (payload) => {
            console.log("[NotificationBell] payload received", { channelName, payload });
            refreshContactNotifications(recipientEmail).then(setNotifications);
          }
        )
        .subscribe((status, err) => {
          console.log("[NotificationBell] status", { channelName, status, err: err?.message });
        });
    });

    return () => {
      cancelled = true;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [recipientUserId, recipientEmail]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  function toggleNotifications() {
    setIsOpen((current) => !current);
  }

  function markAllRead() {
    setNotifications(scopeToRecipient(markNotificationsRead(recipientEmail)));
  }

  function handleDismiss(id: string, event: React.MouseEvent) {
    event.stopPropagation();
    setNotifications(scopeToRecipient(dismissNotification(id)));
  }

  function dismissExtractAlert(index: number) {
    setExtractAlerts((prev) => {
      const next = prev.filter((_, i) => i !== index);
      saveStoredAlerts(next);
      return next;
    });
  }

  async function openNotification(notification: ContactNotification) {
    setIsOpen(false);
    if (notification.status === "unread") {
      setNotifications(scopeToRecipient(markSingleNotificationRead(notification.id)));
    }
    const { data: { user } } = await supabase.auth.getUser();
    const response = user ? await fetch("/api/user/me") : null;
    const userRecord = response?.ok ? await response.json() : null;
    const activeRole = userRecord?.role;

    logAdminEvent({
      type: "notification_clicked",
      userRole: activeRole === "employer" ? "employer" : "candidate",
      jobId: notification.jobId,
      applicantId: notification.candidateId,
      employerId: notification.employerId,
      metadata: { notificationType: notification.type }
    });

    if (notification.type === "capability_ready") {
      const nextPath = "/applicant/profile";
      if (window.location.pathname === nextPath) {
        return;
      }
      window.location.href = nextPath;
      return;
    }

    if (notification.type !== "new_match" && notification.type !== "interest_received") {
      return;
    }

    const params = new URLSearchParams();
    params.set("matchJobId", notification.jobId);
    // Only a confirmed mutual match carries a candidateId worth deep-linking to
    // a specific candidate - a one-sided interest_received notification never
    // does, so this never auto-focuses (and so never risks pointing at) one
    // specific candidate before there's a mutual match to justify it.
    if (notification.type === "new_match" && notification.candidateId) {
      params.set("candidateId", notification.candidateId);
    }
    if (notification.type === "new_match" && notification.employerId) {
      params.set("employerId", notification.employerId);
    }

    // Employer notifications land on Matches (mutual matches are the record
    // that lives there; a one-sided interest_received still lands there too,
    // where the employer Matches page shows it in the separate "candidates
    // interested in you" section - never Find Applicants, which was the wrong
    // destination for "go look at this specific match/interest").
    const nextPath =
      activeRole === "employer"
        ? `/employer/matches?${params.toString()}`
        : `/applicant/job-map?${params.toString()}`;

    if (window.location.pathname === nextPath.split("?")[0]) {
      window.history.replaceState(null, "", nextPath);
      window.dispatchEvent(new CustomEvent("workplace-match-focus-match", { detail: Object.fromEntries(params) }));
      return;
    }

    window.location.href = nextPath;
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={toggleNotifications}
        aria-label="Notifications"
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-transparent text-zinc-950 transition hover:bg-gray-50 hover:text-red-700"
      >
        <svg
          aria-hidden="true"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 ? (
          <span className="absolute right-0 top-0 inline-flex min-w-5 items-center justify-center rounded-full bg-red-700 px-1.5 text-xs font-bold text-white">
            {unreadCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="absolute right-0 top-full z-[1200] mt-2 w-80 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-soft">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">Notifications</p>
            {unreadNotificationCount > 0 ? (
              <button type="button" onClick={markAllRead} className="text-xs font-semibold text-red-700 transition hover:underline">
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="mt-3 max-h-80 overflow-y-auto">
            {extractAlerts.length === 0 && notifications.length === 0 ? (
              <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-zinc-600">
                No notifications yet.
              </p>
            ) : (
              <div className="space-y-2">
                {extractAlerts.map((message, index) => (
                  <div
                    key={`extract-${index}`}
                    className="flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3"
                  >
                    <div className="min-w-0">
                      <span className="block text-sm font-bold text-amber-900">Action required</span>
                      <span className="mt-1 block text-sm leading-5 text-amber-800">{message}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => dismissExtractAlert(index)}
                      aria-label="Dismiss"
                      className="shrink-0 text-amber-600 transition hover:text-amber-900"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
                {notifications.map((notification) => {
                  const isUnread = notification.status === "unread";
                  return (
                    <div
                      key={notification.id}
                      className={`flex items-start justify-between gap-2 rounded-md border p-3 transition ${
                        isUnread ? "border-red-200 bg-red-50 hover:bg-red-100/60" : "border-gray-200 bg-gray-50 hover:bg-white"
                      }`}
                    >
                      <button type="button" onClick={() => openNotification(notification)} className="min-w-0 flex-1 text-left">
                        <span className="flex items-center gap-1.5">
                          {isUnread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-700" aria-hidden="true" /> : null}
                          <span className={`block text-sm ${isUnread ? "font-bold text-zinc-950" : "font-semibold text-zinc-500"}`}>
                            {notification.title || (notification.type === "new_match" ? "New Match" : "Notification")}
                          </span>
                        </span>
                        <span className={`mt-1 block text-sm leading-5 ${isUnread ? "text-zinc-700" : "text-zinc-500"}`}>
                          {notification.message}
                        </span>
                        <span className="mt-1 block text-xs font-semibold text-zinc-400">{notification.jobTitle}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => handleDismiss(notification.id, event)}
                        aria-label="Dismiss notification"
                        className="shrink-0 text-zinc-400 transition hover:text-red-700"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
