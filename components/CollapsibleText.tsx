"use client";

import { useState } from "react";

// Generic long-text collapse: shows a clamped preview (collapsed by default)
// with a "Show more"/"Show less" toggle, so a list of cards stays scannable
// instead of every card expanding to its full content height. Used for plain
// text (job descriptions) - the structured employer summary has its own
// collapse behavior in EmployerSummaryContent, since "collapsed" there means
// something more specific than a line clamp.
export function CollapsibleText({
  text,
  className = "text-sm leading-6 text-zinc-700",
  previewLines = 2
}: {
  text: string;
  className?: string;
  previewLines?: 1 | 2 | 3;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!text) {
    return null;
  }

  // Rough heuristic (no DOM measurement): skip the toggle entirely when the
  // text is short enough it almost certainly wouldn't be clamped anyway - a
  // "Show more" that reveals nothing looks broken.
  const approxCharsPerLine = 60;
  const mightOverflow = text.length > approxCharsPerLine * previewLines;

  if (!mightOverflow) {
    return <p className={`${className} whitespace-pre-wrap`}>{text}</p>;
  }

  const clampClass = previewLines === 1 ? "line-clamp-1" : previewLines === 3 ? "line-clamp-3" : "line-clamp-2";

  return (
    <div>
      <p className={`${className} whitespace-pre-wrap ${isExpanded ? "" : clampClass}`}>{text}</p>
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        className="mt-1 text-xs font-semibold text-red-800 transition hover:underline"
      >
        {isExpanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
