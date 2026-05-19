import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

const REGION = "St. Louis, Missouri";

type USAJobsItem = {
  MatchedObjectId: string;
  MatchedObjectDescriptor: {
    PositionTitle: string;
    ApplyURI: string[];
    PositionLocationDisplay: string;
    PositionLocation: Array<{
      Latitude: number;
      Longitude: number;
    }>;
    OrganizationName: string;
    PositionRemuneration: Array<{
      MinimumRange: string;
      MaximumRange: string;
    }>;
    PositionSchedule: Array<{ Name: string }>;
    UserArea?: {
      Details?: {
        JobSummary?: string;
      };
    };
  };
};

export async function POST() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const apiKey = process.env.USAJOBS_API_KEY;
    const userAgent = process.env.USAJOBS_USER_AGENT;

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
    }

    if (!apiKey || !userAgent) {
      console.error("[refresh-usajobs-cache] env vars not set (USAJOBS_API_KEY / USAJOBS_USER_AGENT)");
      return NextResponse.json({ cached: 0, fresh: false, region: REGION, error: "USAJobs not configured." });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Check for fresh USAJobs entries in the shared cache table
    const { data: existing } = await adminClient
      .from("adzuna_cache")
      .select("id")
      .eq("region", REGION)
      .like("id", "usajobs-%")
      .gt("expires_at", new Date().toISOString())
      .limit(1);

    if (existing && existing.length > 0) {
      const { count } = await adminClient
        .from("adzuna_cache")
        .select("id", { count: "exact", head: true })
        .eq("region", REGION)
        .like("id", "usajobs-%")
        .gt("expires_at", new Date().toISOString());
      console.log("[refresh-usajobs-cache] cache fresh, count:", count);
      return NextResponse.json({ cached: count ?? 0, fresh: true, region: REGION });
    }

    // Fetch from USAJobs API
    const url = new URL("https://data.usajobs.gov/api/search");
    url.searchParams.set("LocationName", "St. Louis, MO");
    url.searchParams.set("Radius", "50");
    url.searchParams.set("ResultsPerPage", "500");
    url.searchParams.set("Page", "1");

    console.log("[refresh-usajobs-cache] fetching from USAJobs API...");
    const response = await fetch(url.toString(), {
      headers: {
        "Authorization-Key": apiKey,
        "User-Agent": userAgent,
        "Host": "data.usajobs.gov"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("[refresh-usajobs-cache] API error:", response.status, body.slice(0, 200));
      return NextResponse.json({ cached: 0, fresh: false, region: REGION });
    }

    const data = await response.json();
    const items: USAJobsItem[] = data?.SearchResult?.SearchResultItems ?? [];
    console.log("[refresh-usajobs-cache] USAJobs returned:", items.length, "jobs");

    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const rows = items
      .filter((item) => {
        const loc = item.MatchedObjectDescriptor.PositionLocation?.[0];
        return loc && isFinite(Number(loc.Latitude)) && isFinite(Number(loc.Longitude));
      })
      .map((item) => {
        const desc = item.MatchedObjectDescriptor;
        const loc = desc.PositionLocation[0];
        const rem = desc.PositionRemuneration?.[0];
        const summary = desc.UserArea?.Details?.JobSummary ?? "";
        return {
          id: `usajobs-${item.MatchedObjectId}`,
          title: desc.PositionTitle,
          company: desc.OrganizationName ?? null,
          location: desc.PositionLocationDisplay ?? null,
          lat: Number(loc.Latitude),
          lng: Number(loc.Longitude),
          salary_min: rem?.MinimumRange ? Number(rem.MinimumRange) : null,
          salary_max: rem?.MaximumRange ? Number(rem.MaximumRange) : null,
          job_type: desc.PositionSchedule?.[0]?.Name ?? null,
          url: desc.ApplyURI?.[0] ?? "",
          description: summary.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
          region: REGION,
          cached_at: now,
          expires_at: expiresAt
        };
      });

    console.log("[refresh-usajobs-cache] with coords:", rows.length, "of", items.length);

    if (rows.length === 0) {
      return NextResponse.json({ cached: 0, fresh: false, region: REGION });
    }

    const { error: upsertError } = await adminClient
      .from("adzuna_cache")
      .upsert(rows, { onConflict: "id" });

    if (upsertError) {
      console.error("[refresh-usajobs-cache] upsert error:", upsertError);
      await logError({
        route: "/api/scoring/refresh-usajobs-cache",
        errorMessage: upsertError.message,
        errorType: "database",
        severity: "medium",
        metadata: { region: REGION, count: rows.length }
      });
      return NextResponse.json({ cached: 0, fresh: false, region: REGION });
    }

    console.log("[refresh-usajobs-cache] upserted:", rows.length, "rows");
    return NextResponse.json({ cached: rows.length, fresh: false, region: REGION });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[refresh-usajobs-cache] caught error:", errorMessage);
    await logError({
      route: "/api/scoring/refresh-usajobs-cache",
      errorMessage,
      errorType: "api_error",
      severity: "medium"
    });
    return NextResponse.json({ cached: 0, fresh: false, region: REGION });
  }
}
