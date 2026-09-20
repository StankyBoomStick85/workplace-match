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

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const channelName = `match_messages:${thread.applicantId}:${thread.employerId}:${thread.jobId}`;

    // Realtime's postgres_changes evaluates RLS using the JWT attached to the
    // socket (via realtime.setAuth), not the anon key alone. createBrowserClient
    // wires this automatically on auth state changes, but that's a fire-and-
    // forget internal call - there's no guarantee it has landed on the socket
    // before .subscribe() runs. Awaiting the session and setting it explicitly
    // here removes that race instead of hoping the timing works out: a channel
    // that subscribes before the socket carries a valid JWT will report
    // SUBSCRIBED (subscribing itself doesn't check RLS) but silently deliver
    // nothing, forever, since every row-level RLS check afterward fails.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) {
        return;
      }
      if (!session) {
        console.warn("[useMatchThreadRealtime] No auth session - skipping subscribe", { channelName });
        return;
      }
      supabase.realtime.setAuth(session.access_token);

      channel = supabase
        .channel(channelName)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "match_messages", filter: `job_id=eq.${thread.jobId}` },
          (payload) => {
            console.log("[useMatchThreadRealtime] payload received", { channelName, payload });
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
        .subscribe((status, err) => {
          console.log("[useMatchThreadRealtime] status", { channelName, status, err: err?.message });
        });
    });

    return () => {
      cancelled = true;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.applicantId, thread?.employerId, thread?.jobId]);
}
