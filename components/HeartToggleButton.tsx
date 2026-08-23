"use client";

import { Heart } from "lucide-react";

export function HeartToggleButton({
  interested,
  onClick,
  size = "md",
  className = ""
}: {
  interested: boolean;
  onClick: () => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const iconSize = size === "sm" ? 16 : 20;
  const dimensionClass = size === "sm" ? "h-8 w-8" : "h-10 w-10";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={interested ? "Remove interest" : "Mark interested"}
      aria-pressed={interested}
      title={interested ? "Remove interest" : "Mark interested"}
      className={`inline-flex shrink-0 items-center justify-center rounded-full border transition ${
        interested
          ? "border-red-900 bg-red-900 text-white hover:bg-red-950"
          : "border-zinc-300 bg-white text-zinc-500 hover:border-red-300 hover:text-red-700"
      } ${dimensionClass} ${className}`}
    >
      <Heart size={iconSize} fill={interested ? "currentColor" : "none"} strokeWidth={2} />
    </button>
  );
}
