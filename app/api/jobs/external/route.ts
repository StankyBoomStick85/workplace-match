import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

// Bounding-box half-widths: ~100 miles in each direction.
// Precise radius filtering is handled client-side in visibleExternalJobs.
const LAT_DELTA = 1.5;
const LNG_DELTA = 1.5;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lng = parseFloat(searchParams.get("lng") ?? "");

  if (!isFinite(lat) || !isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng are required." }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error("[jobs/external] Supabase env not configured");
    return NextResponse.json({ jobs: [] });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    const { data, error } = await adminClient
      .from("adzuna_cache")
      .select("id, title, company, location, lat, lng, salary_min, salary_max, job_type, url, description")
      .gt("expires_at", new Date().toISOString())
      .gte("lat", lat - LAT_DELTA)
      .lte("lat", lat + LAT_DELTA)
      .gte("lng", lng - LNG_DELTA)
      .lte("lng", lng + LNG_DELTA)
      .limit(1000);

    if (error) {
      console.error("[jobs/external] cache read error:", error);
      await logError({
        route: "/api/jobs/external",
        errorMessage: error.message,
        errorType: "database",
        severity: "medium",
        metadata: { lat, lng }
      });
      return NextResponse.json({ jobs: [] });
    }

    const rows = data ?? [];
    console.log("[jobs/external] cache returned:", rows.length, "jobs near", lat, lng);

    const jobs = rows
      .filter((row) => row.lat != null && row.lng != null && isFinite(Number(row.lat)) && isFinite(Number(row.lng)))
      .map((row) => ({
        id: row.id as string,
        title: row.title as string,
        company: (row.company as string) ?? "Unknown company",
        location: (row.location as string) ?? "",
        lat: Number(row.lat),
        lng: Number(row.lng),
        salary_min: row.salary_min != null ? Number(row.salary_min) : null,
        salary_max: row.salary_max != null ? Number(row.salary_max) : null,
        job_type: (row.job_type as string) ?? null,
        url: row.url as string,
        description: (row.description as string) ?? undefined,
        source: "adzuna" as const
      }));

    return NextResponse.json({ jobs });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[jobs/external] caught error:", errorMessage);
    await logError({
      route: "/api/jobs/external",
      errorMessage,
      errorType: "database",
      severity: "medium",
      metadata: { lat, lng }
    });
    return NextResponse.json({ jobs: [] });
  }
}
