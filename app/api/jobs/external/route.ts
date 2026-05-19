import { NextResponse } from "next/server";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

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
};

export async function GET(request: Request) {
  console.log('[jobs/external] env check:', {
    hasAppId: !!process.env.ADZUNA_APP_ID,
    hasAppKey: !!process.env.ADZUNA_APP_KEY,
    appIdValue: process.env.ADZUNA_APP_ID
  });

  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lng = parseFloat(searchParams.get("lng") ?? "");
  const radiusMiles = parseFloat(searchParams.get("radius") ?? "25");
  const keywords = searchParams.get("keywords") ?? "";

  if (!isFinite(lat) || !isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng are required." }, { status: 400 });
  }

  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;

  console.log("[jobs/external] env check — ADZUNA_APP_ID:", appId ? "present" : "MISSING", "| ADZUNA_APP_KEY:", appKey ? "present" : "MISSING");

  if (!appId || !appKey) {
    console.error("[jobs/external] aborting — ADZUNA_APP_ID and/or ADZUNA_APP_KEY are not set in environment variables");
    return NextResponse.json({ error: "Adzuna not configured.", jobs: [] }, { status: 500 });
  }

  const radiusKm = Math.round(radiusMiles * 1.60934);

  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: "50",
    latitude: String(lat),
    longitude: String(lng),
    distance: String(radiusKm),
    "content-type": "application/json",
    ...(keywords ? { what: keywords } : {})
  });

  try {
    const response = await fetch(
      `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      throw new Error(`Adzuna responded ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const rawJobs: AdzunaResult[] = data.results ?? [];

    console.log("[jobs/external] Adzuna total results:", data.count ?? "unknown");
    console.log("[jobs/external] rawJobs returned:", rawJobs.length);
    if (rawJobs[0]) {
      console.log("[jobs/external] first result shape:", JSON.stringify({
        id: rawJobs[0].id,
        title: rawJobs[0].title,
        latitude: rawJobs[0].latitude,
        longitude: rawJobs[0].longitude,
        location: rawJobs[0].location
      }));
    }

    const jobsWithCoords = rawJobs.filter((job) => isFinite(job.latitude ?? NaN) && isFinite(job.longitude ?? NaN));
    console.log("[jobs/external] jobs with coordinates:", jobsWithCoords.length, "of", rawJobs.length);

    const jobs = jobsWithCoords
      .map((job) => ({
        id: `adzuna-${job.id}`,
        title: job.title,
        company: job.company?.display_name ?? "Unknown company",
        location: job.location?.display_name ?? "",
        lat: job.latitude as number,
        lng: job.longitude as number,
        salary_min: job.salary_min ?? null,
        salary_max: job.salary_max ?? null,
        job_type: job.contract_type ?? null,
        url: job.redirect_url,
        source: "adzuna" as const
      }));

    return NextResponse.json({ jobs });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[jobs/external] caught error:", errorMessage, err);
    await logError({
      route: "/api/jobs/external",
      errorMessage,
      errorType: "api_error",
      severity: "medium",
      metadata: { lat, lng, radiusMiles }
    });
    return NextResponse.json({ jobs: [] });
  }
}
