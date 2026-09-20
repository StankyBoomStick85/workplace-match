"use client";

import { useEffect, useRef } from "react";
import { supabase } from "./supabase";
import { isOwnRecentEcho, type MatchMessage, type MatchThreadContext } from "./matchMessages";

// Subscribes to INSERTs on match_messages for exactly one open thread, so a
// message the other party sends shows up without a page refresh. Realtime
// postgres_changes filters only support a single column comparison (no
// multi-column AND), so this filters server-side on job_id - the most
// selective column available - and narrows to the exact
// applicant/employer/job triple client-side before calling onMessage.
//
// Pass `thread: null` (e.g. `isOpen ? thread : null`) to unsubscribe while a
// thread's panel is closed. Requires Realtime to be enabled for the
// match_messages table in the Supabase dashboard - see the rollout notes in
// the commit/PR this shipped with.
export function useMatchThreadRealtime(
  thread: MatchThreadContext | null,
  onMessage: (message: MatchMessage) => void
) {
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!thread || !thread.applicantId || !thread.employerId || !thread.jobId) {
      return;
    }

    const channel = supabase
      .channel(`match_messages:${thread.applicantId}:${thread.employerId}:${thread.jobId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "match_messages", filter: `job_id=eq.${thread.jobId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (row.applicant_id !== thread.applicantId || row.employer_id !== thread.employerId) {
            return;
          }

          const senderRole = row.sender_role as MatchMessage["senderRole"];
          const text = String(row.text ?? "");
          if (isOwnRecentEcho(thread, senderRole, text)) {
            return;
          }

          onMessageRef.current({
            id: String(row.id),
            applicantId: String(row.applicant_id),
            employerId: String(row.employer_id),
            jobId: String(row.job_id),
            senderRole,
            text,
            createdAt: String(row.created_at)
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.applicantId, thread?.employerId, thread?.jobId]);
}
