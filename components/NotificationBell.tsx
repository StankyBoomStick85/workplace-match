"use client";

import { useEffect, useRef, useState } from "react";
import {
  getNotificationsForRecipient,
  markNotificationsRead,
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

export function NotificationBell({ recipientEmail }: { recipientEmail: string }) {
  const [notifications, setNotifications] = useState<ContactNotification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [extractAlerts, setExtractAlerts] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return loadStoredAlerts();
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const unreadCount =
    notifications.filter((notification) => notification.status === "unread").length +
    extractAlerts.length;

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
    const nextIsOpen = !isOpen;
    setIsOpen(nextIsOpen);

    if (nextIsOpen && unreadCount > 0) {
      setNotifications(markNotificationsRead(recipientEmail).filter(
        (notification) => notification.recipientEmail.trim().toLowerCase() === recipientEmail.trim().toLowerCase()
      ));
    }
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

    if (notification.type !== "new_match") {
      return;
    }

    const params = new URLSearchParams();
    params.set("matchJobId", notification.jobId);
    if (notification.candidateId) {
      params.set("candidateId", notification.candidateId);
    }
    if (notification.employerId) {
      params.set("employerId", notification.employerId);
    }

    const nextPath =
      activeRole === "employer"
        ? `/employer/find-applicants?${params.toString()}`
        : `/jobs?${params.toString()}`;

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
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">Notifications</p>
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
                {notifications.map((notification) => (
                  <button
                    key={notification.id}
                    type="button"
                    onClick={() => openNotification(notification)}
                    className="w-full rounded-md border border-gray-200 bg-gray-50 p-3 text-left transition hover:bg-white"
                  >
                    <span className="block text-sm font-bold text-zinc-950">
                      {notification.title || (notification.type === "new_match" ? "New Match" : "Notification")}
                    </span>
                    <span className="mt-1 block text-sm leading-5 text-zinc-600">{notification.message}</span>
                    <span className="mt-1 block text-xs font-semibold text-zinc-500">{notification.jobTitle}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
