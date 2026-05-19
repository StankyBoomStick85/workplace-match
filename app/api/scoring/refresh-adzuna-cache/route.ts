import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { "Accept-Language": "en", "User-Agent": "WorkplaceMatch/1.0" } }
    );
    if (!res.ok) return "Missouri";
    const data = await res.json();
    const city =
      data?.address?.city ??
      data?.address?.town ??
      data?.address?.village ??
      data?.address?.county ??
      "";
    const state = data?.address?.state ?? "";
    if (city && state) return `${city}, ${state}`;
    if (state) return state;
  } catch {
    // fall through to fallback
  }
  return "Missouri";
}

type AdzunaResult = {
  id: string;
  title: string;
  company: { display_name: string };
  location: { display_name: string };
  latitude?: number;
  longitude?: number;
  salary_min?: number;
  salary_max?: number;
  contract_type?: string;
  redirect_url: string;
  description?: string;
};

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const lat = typeof body.lat === "number" ? body.lat : parseFloat(body.lat ?? "");
    const lng = typeof body.lng === "number" ? body.lng : parseFloat(body.lng ?? "");
    const radiusMiles = typeof body.radius === "number" ? body.radius : parseFloat(body.radius ?? "25") || 25;

    if (!isFinite(lat) || !isFinite(lng)) {
      return NextResponse.json({ error: "lat and lng are required." }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const region = await reverseGeocode(lat, lng);
    console.log("[refresh-adzuna-cache] region:", region);

    // Check for fresh cache entries for this region
    const { data: existing, error: cacheError } = await adminClient
      .from("adzuna_cache")
      .select("id")
      .eq("region", region)
      .gt("expires_at", new Date().toISOString())
      .limit(1);

    if (cacheError) {
      console.error("[refresh-adzuna-cache] cache check error:", cacheError);
    }

    if (existing && existing.length > 0) {
      const { count } = await adminClient
        .from("adzuna_cache")
        .select("id", { count: "exact", head: true })
        .eq("region", region)
        .gt("expires_at", new Date().toISOString());
      console.log("[refresh-adzuna-cache] cache fresh, count:", count);
      return NextResponse.json({ cached: count ?? 0, fresh: true, region });
    }

    // Cache stale or empty — fetch from Adzuna
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    if (!appId || !appKey) {
      console.error("[refresh-adzuna-cache] Adzuna keys not set");
      return NextResponse.json({ cached: 0, fresh: false, region, error: "Adzuna not configured." });
    }

    const url = new URL("https://api.adzuna.com/v1/api/jobs/us/search/1");
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("results_per_page", "50");
    url.searchParams.set("where", region);
    url.searchParams.set("distance", String(Math.round(radiusMiles)));
    url.searchParams.set("what", "");

    console.log("[refresh-adzuna-cache] calling Adzuna:", url.toString());

    const response = await fetch(url.toString(), {
      headers: { "Accept": "application/json" }
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[refresh-adzuna-cache] Adzuna error ${response.status}:`, body);
      return NextResponse.json({ cached: 0, fresh: false, region });
    }

    const data = await response.json();
    const rawJobs: AdzunaResult[] = data.results ?? [];
    console.log("[refresh-adzuna-cache] Adzuna returned:", rawJobs.length, "jobs");

    const jobsWithCoords = rawJobs.filter(
      (job) => isFinite(job.latitude ?? NaN) && isFinite(job.longitude ?? NaN)
    );
    console.log("[refresh-adzuna-cache] with coords:", jobsWithCoords.length, "of", rawJobs.length);

    if (jobsWithCoords.length === 0) {
      return NextResponse.json({ cached: 0, fresh: false, region });
    }

    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    const rows = jobsWithCoords.map((job) => ({
      id: `adzuna-${job.id}`,
      title: job.title,
      company: job.company?.display_name ?? null,
      location: job.location?.display_name ?? null,
      lat: job.latitude as number,
      lng: job.longitude as number,
      salary_min: job.salary_min ?? null,
      salary_max: job.salary_max ?? null,
      job_type: job.contract_type ?? null,
      url: job.redirect_url,
      description: job.description ? stripHtml(job.description) : null,
      region,
      cached_at: new Date().toISOString(),
      expires_at: expiresAt
    }));

    const { error: upsertError } = await adminClient
      .from("adzuna_cache")
      .upsert(rows, { onConflict: "id" });

    if (upsertError) {
      console.error("[refresh-adzuna-cache] upsert error:", upsertError);
      await logError({
        route: "/api/scoring/refresh-adzuna-cache",
        errorMessage: upsertError.message,
        errorType: "database",
        severity: "medium",
        metadata: { region, count: rows.length }
      });
      return NextResponse.json({ cached: 0, fresh: false, region });
    }

    console.log("[refresh-adzuna-cache] upserted:", rows.length, "rows");
    return NextResponse.json({ cached: rows.length, fresh: false, region });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[refresh-adzuna-cache] caught error:", errorMessage);
    await logError({
      route: "/api/scoring/refresh-adzuna-cache",
      errorMessage,
      errorType: "api_error",
      severity: "medium"
    });
    return NextResponse.json({ cached: 0, fresh: false });
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
