"use client";

import { useEffect } from "react";

export function ThemeProvider() {
  useEffect(() => {
    if (localStorage.getItem("darkMode") === "true") {
      document.documentElement.classList.add("dark");
    }
  }, []);
  return null;
}
