"use client";

import { useEffect, useRef, useState } from "react";
import { AccountSettings } from "./AccountSettings";
import { SupportSettings } from "./SupportSettings";

type Tab = "dark-mode" | "account" | "plan" | "support";

export function SettingsModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("dark-mode");
  const [isDark, setIsDark] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsDark(localStorage.getItem("darkMode") === "true");
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  function handleDarkModeToggle(checked: boolean) {
    setIsDark(checked);
    localStorage.setItem("darkMode", String(checked));
    document.documentElement.classList.toggle("dark", checked);
  }

  function handleOpen() {
    setActiveTab("dark-mode");
    setIsOpen(true);
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "dark-mode", label: "Dark Mode" },
    { id: "account", label: "Account" },
    { id: "plan", label: "Plan" },
    { id: "support", label: "Support" },
  ];

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="Settings"
        className="border-b-2 border-transparent px-1.5 py-2 text-zinc-950 transition-colors duration-150 hover:text-red-700"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {isOpen ? (
        <div
          className="fixed inset-0 z-[1250] flex items-start justify-center bg-zinc-950/40 px-4 pt-16"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setIsOpen(false); }}
        >
          <div
            ref={modalRef}
            className="w-full max-w-lg rounded-lg border border-gray-200 bg-white shadow-xl"
          >
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-bold text-zinc-900">Settings</h2>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close settings"
                className="rounded p-1 text-zinc-400 transition hover:bg-gray-100 hover:text-zinc-700"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Tab bar */}
            <div className="flex border-b border-gray-200 px-6">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`mr-6 border-b-2 py-3 text-sm font-semibold transition-colors ${
                    activeTab === tab.id
                      ? "border-red-700 text-red-700"
                      : "border-transparent text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="max-h-[70vh] overflow-y-auto">
              {activeTab === "dark-mode" ? (
                <div className="px-6 py-6">
                  <h3 className="text-sm font-bold text-zinc-900">Dark Mode</h3>
                  <p className="mt-1 text-sm text-zinc-500">Applies immediately and saves to this device.</p>
                  <div className="mt-5 flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-700">Dark mode</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isDark}
                      onClick={() => handleDarkModeToggle(!isDark)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
                        isDark ? "bg-red-700" : "bg-gray-200"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                          isDark ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              ) : activeTab === "account" ? (
                <AccountSettings role="candidate" inModal />
              ) : activeTab === "plan" ? (
                <div className="px-6 py-6">
                  <h3 className="text-sm font-bold text-zinc-900">Your Plan</h3>
                  <p className="mt-1 text-sm text-zinc-500">Manage your subscription.</p>
                  <div className="mt-5 space-y-4">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-zinc-700">Current plan</span>
                      <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-zinc-600">Free</span>
                    </div>
                    <button
                      type="button"
                      disabled
                      className="rounded-md bg-gray-100 px-4 py-2 text-sm font-semibold text-zinc-400 cursor-not-allowed"
                    >
                      Upgrade to Pro — Coming Soon
                    </button>
                  </div>
                </div>
              ) : (
                <SupportSettings />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
