"use client";

import { useEffect, useRef } from "react";

// Scrolls a message-thread container to the newest message whenever `trigger`
// changes. Callers pass something that changes on send, on realtime arrival,
// and on thread open (e.g. `${isOpen}:${messages.length}`) so all three
// trigger a scroll.
export function useAutoScrollToBottom<T>(trigger: T) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [trigger]);

  return ref;
}
