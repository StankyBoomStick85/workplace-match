"use client";

import { useEffect, useState } from "react";
import {
  getNotificationsForRecipient,
  markNotificationsRead,
  type ContactNotification
} from "../lib/contactPreferences";
import { logAdminEvent } from "../lib/adminEvents";

export function NotificationBell({ recipientEmail }: { recipientEmail: string }) {
  const [notifications, setNotifications] = useState<ContactNotification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const unreadCount = notifications.filter((notification) => notification.status === "unread").length;

  useEffect(() => {
    refreshNotifications();
    window.addEventListener("storage", refreshNotifications);
    window.addEventListener("workplace-match-notifications-updated", refreshNotifications);

    return () => {
      window.removeEventListener("storage", refreshNotifications);
      window.removeEventListener("workplace-match-notifications-updated", refreshNotifications);
    };

    function refreshNotifications() {
      setNotifications(getNotificationsForRecipient(recipientEmail));
    }
  }, [recipientEmail]);

  function toggleNotifications() {
    const nextIsOpen = !isOpen;
    setIsOpen(nextIsOpen);

    if (nextIsOpen && unreadCount > 0) {
      setNotifications(markNotificationsRead(recipientEmail).filter(
        (notification) => notification.recipientEmail.trim().toLowerCase() === recipientEmail.trim().toLowerCase()
      ));
    }
  }

  function openNotification(notification: ContactNotification) {
    setIsOpen(false);
    logAdminEvent({
      type: "notification_clicked",
      userRole: localStorage.getItem("workplace_match_active_role") === "employer" ? "employer" : "candidate",
      jobId: notification.jobId,
      applicantId: notification.candidateId,
      employerId: notification.employerId,
      metadata: { notificationType: notification.type }
    });

    if (notification.type !== "new_match") {
      return;
    }

    const activeRole = localStorage.getItem("workplace_match_active_role");
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
    <div className="relative">
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
            {notifications.length > 0 ? (
              <div className="space-y-2">
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
            ) : (
              <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-zinc-600">
                No notifications yet.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
