import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { extractDocumentText } from "../../../../lib/documentExtraction";
import { extractEvidenceFromOneDocument, type StoredDoc } from "../../../../lib/capabilityPipeline";

export const dynamic = "force-dynamic";
// Raised from 60s: this route now runs up to two sequential Anthropic calls per
// document (transcription, then evidence-claim extraction reading that cached
// text) instead of one, so the old ceiling had no margin left for a large
// scanned document or an SDK retry.
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const path = typeof body?.path === "string" ? body.path : "";
  const docId = typeof body?.docId === "string" ? body.docId : "";

  if (!path || !docId) {
    return NextResponse.json({ error: "path and docId are required." }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) { cookieStore.set(name, value, options); },
      remove(name: string, options: CookieOptions) { cookieStore.set(name, "", options); },
    },
  });

  const { data: { user }, error: userError } = await authClient.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  if (!path.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "Access denied." }, { status: 403 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Get contentType from storage metadata via list()
  const pathParts = path.split('/');
  const fileName = pathParts.pop();
  const folderPath = pathParts.join('/');
  const { data: listData, error: listErr } = await adminClient.storage
    .from("candidate-documents")
    .list(folderPath, { search: fileName });

  if (listErr || !listData || listData.length === 0) {
    console.error("[process-document] storage list() failed", listErr);
    return NextResponse.json({ error: "Could not read document metadata from storage." }, { status: 500 });
  }

  const contentType = listData[0]?.metadata?.mimetype || "";

  // 2. Run raw text/transcription extraction using shared helper
  const { extractedText, extractionStatus } = await extractDocumentText(
    path,
    contentType,
    adminClient,
    anthropicApiKey
  );

  // 3. Look up this document's own metadata entry (label/filename) so evidence
  // extraction below can run with the exact same prompt shape generate-capability
  // has always used - this is a caching change, not a change to what gets asked.
  let profileDocs: any[] = [];
  try {
    const { data: profile, error: fetchErr } = await adminClient
      .from("candidate_profiles")
      .select("document_metadata")
      .eq("user_id", user.id)
      .maybeSingle();

    if (fetchErr || !profile) {
      throw new Error("Could not find profile metadata.");
    }
    profileDocs = Array.isArray(profile.document_metadata) ? profile.document_metadata : [];
  } catch (err) {
    console.error("[process-document] metadata fetch failed", err);
    return NextResponse.json({ error: "Failed to load document metadata." }, { status: 500 });
  }

  const existingDoc = profileDocs.find((doc: any) => doc.id === docId);

  // 4. Cache per-document evidence extraction here, once, at upload time - this is
  // the same call generate-capability made per document on every "Generate" click
  // (lib/capabilityPipeline.ts extractEvidenceFromOneDocument), just moved to run
  // once instead of on every regeneration. Skipped only if this document's own
  // metadata entry has vanished between steps (e.g. deleted mid-request) - nothing
  // to attach cached evidence to in that case.
  let evidenceStatus: "complete" | "failed" = "failed";
  let evidenceItems: unknown[] = [];
  let evidenceExtractedAt = "";

  if (existingDoc && anthropicApiKey) {
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });
    const syntheticDoc: StoredDoc = {
      id: docId,
      label: existingDoc.label ?? "",
      filename: existingDoc.filename ?? "",
      path,
      contentType,
      extractedText,
      extractionStatus
    };

    try {
      const result = await extractEvidenceFromOneDocument(syntheticDoc, adminClient, anthropic);
      evidenceItems = result.items;
      evidenceStatus = result.unreadable || result.extractionFailed ? "failed" : "complete";
      evidenceExtractedAt = new Date().toISOString();
    } catch (err) {
      console.error("[process-document] evidence extraction failed", err);
    }
  } else if (!anthropicApiKey) {
    console.error("[process-document] ANTHROPIC_API_KEY missing - skipping evidence extraction, document will be extracted on next Generate instead");
  }

  // 5. Write transcription + evidence cache back in one update.
  try {
    const updatedMetadata = profileDocs.map((doc: any) => {
      if (doc.id === docId) {
        return {
          ...doc,
          extractedText,
          extractionStatus,
          evidenceItems,
          evidenceStatus,
          evidenceExtractedAt
        };
      }
      return doc;
    });

    const { error: updateErr } = await adminClient
      .from("candidate_profiles")
      .update({ document_metadata: updatedMetadata })
      .eq("user_id", user.id);

    if (updateErr) throw updateErr;

    return NextResponse.json({
      success: true,
      extractionStatus,
      extractedTextLength: extractedText.length,
      evidenceStatus,
      evidenceCount: evidenceItems.length
    });
  } catch (err) {
    console.error("[process-document] metadata update failed", err);
    return NextResponse.json({ error: "Failed to update document metadata." }, { status: 500 });
  }
}
