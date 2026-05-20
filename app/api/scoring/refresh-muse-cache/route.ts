import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

// All Muse jobs share a single cache bucket — geographic filtering is done by
// the bounding-box query in /api/jobs/external, not by region name.
const MUSE_REGION = "National";

// How many pages to pull (20 results/page)
const PAGES_TO_FETCH = 5;

type MuseJob = {
  id: number;
  name: string;
  company: { id: number; name: string };
  locations: Array<{ name: string }>;
  refs: { landing_page: string };
  publication_date: string;
  categories: Array<{ name: string }>;
  levels: Array<{ name: string }>;
};

type MuseApiResponse = {
  results: MuseJob[];
  page: number;
  page_count: number;
};

async function forwardGeocode(locationStr: string): Promise<{ lat: number; lng: number } | null> {
  const lower = locationStr.toLowerCase();
  if (!locationStr || lower.includes("remote") || lower.includes("flexible") || lower.includes("anywhere")) {
    return null;
  }
  // Strip "(US)" and similar suffixes, e.g. "Austin, TX (US)" → "Austin, TX"
  const cleaned = locationStr.replace(/\s*\([^)]*\)/g, "").trim();
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleaned)}&format=json&limit=1`,
      { headers: { "Accept-Language": "en", "User-Agent": "WorkplaceMatch/1.0" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.[0]) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

export async function POST() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const apiKey = process.env.MUSE_API_KEY;

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
    }

    if (!apiKey) {
      console.error("[refresh-muse-cache] MUSE_API_KEY not set");
      return NextResponse.json({ cached: 0, fresh: false, region: MUSE_REGION, error: "Muse not configured." });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Check for a fresh Muse cache
    const { data: existing } = await adminClient
      .from("adzuna_cache")
      .select("id")
      .eq("region", MUSE_REGION)
      .like("id", "muse-%")
      .gt("expires_at", new Date().toISOString())
      .limit(1);

    if (existing && existing.length > 0) {
      const { count } = await adminClient
        .from("adzuna_cache")
        .select("id", { count: "exact", head: true })
        .eq("region", MUSE_REGION)
        .like("id", "muse-%")
        .gt("expires_at", new Date().toISOString());
      console.log("[refresh-muse-cache] cache fresh, count:", count);
      return NextResponse.json({ cached: count ?? 0, fresh: true, region: MUSE_REGION });
    }

    // Fetch pages from The Muse API
    const allJobs: MuseJob[] = [];

    for (let page = 1; page <= PAGES_TO_FETCH; page++) {
      const url = new URL("https://www.themuse.com/api/public/jobs");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("page", String(page));

      const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!res.ok) {
        console.error(`[refresh-muse-cache] page ${page} HTTP ${res.status}`);
        break;
      }
      const data: MuseApiResponse = await res.json();
      const batch = data.results ?? [];
      allJobs.push(...batch);
      console.log(`[refresh-muse-cache] page ${page}: +${batch.length} jobs (total ${allJobs.length})`);
      if (page >= (data.page_count ?? 1)) break;
    }

    console.log("[refresh-muse-cache] total fetched:", allJobs.length);

    // Geocode unique, non-remote location strings
    const uniqueLocations = [
      ...new Set(allJobs.flatMap((j) => j.locations?.map((l) => l.name) ?? []))
    ];
    console.log("[refresh-muse-cache] unique locations to geocode:", uniqueLocations.length);

    const coordCache = new Map<string, { lat: number; lng: number } | null>();
    for (const loc of uniqueLocations) {
      coordCache.set(loc, await forwardGeocode(loc));
      // Small pause between Nominatim calls to stay within rate limit
      await new Promise((r) => setTimeout(r, 120));
    }

    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const seenIds = new Set<string>();

    const rows = allJobs
      .filter((job) => {
        const locName = job.locations?.[0]?.name ?? "";
        return coordCache.get(locName) !== null && coordCache.get(locName) !== undefined;
      })
      .map((job) => {
        const locName = job.locations?.[0]?.name ?? "";
        const coords = coordCache.get(locName)!;
        const id = `muse-${job.id}`;
        if (seenIds.has(id)) return null;
        seenIds.add(id);

        const descParts: string[] = [];
        if (job.categories?.[0]?.name) descParts.push(job.categories[0].name);
        if (job.levels?.[0]?.name) descParts.push(job.levels[0].name);

        return {
          id,
          title: job.name,
          company: job.company?.name ?? null,
          location: locName || null,
          lat: coords.lat,
          lng: coords.lng,
          salary_min: null,
          salary_max: null,
          job_type: job.categories?.[0]?.name ?? null,
          url: job.refs?.landing_page ?? "",
          description: descParts.join(" · ").slice(0, 300) || null,
          region: MUSE_REGION,
          cached_at: now,
          expires_at: expiresAt
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    console.log("[refresh-muse-cache] with coords:", rows.length, "of", allJobs.length);

    if (rows.length === 0) {
      return NextResponse.json({ cached: 0, fresh: false, region: MUSE_REGION });
    }

    const { error: upsertError } = await adminClient
      .from("adzuna_cache")
      .upsert(rows, { onConflict: "id" });

    if (upsertError) {
      console.error("[refresh-muse-cache] upsert error:", upsertError);
      await logError({
        route: "/api/scoring/refresh-muse-cache",
        errorMessage: upsertError.message,
        errorType: "database",
        severity: "medium",
        metadata: { region: MUSE_REGION, count: rows.length }
      });
      return NextResponse.json({ cached: 0, fresh: false, region: MUSE_REGION });
    }

    console.log("[refresh-muse-cache] upserted:", rows.length, "rows");
    return NextResponse.json({ cached: rows.length, fresh: false, region: MUSE_REGION });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[refresh-muse-cache] caught error:", errorMessage);
    await logError({
      route: "/api/scoring/refresh-muse-cache",
      errorMessage,
      errorType: "api_error",
      severity: "medium"
    });
    return NextResponse.json({ cached: 0, fresh: false });
  }
}
