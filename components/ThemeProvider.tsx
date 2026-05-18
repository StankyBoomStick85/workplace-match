"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export function ThemeProvider() {
  const pathname = usePathname();

  useEffect(() => {
    const isDark = localStorage.getItem("darkMode") === "true";
    const isJobMap = pathname === "/applicant/job-map";
    if (isDark && !isJobMap) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [pathname]);

  return null;
}
