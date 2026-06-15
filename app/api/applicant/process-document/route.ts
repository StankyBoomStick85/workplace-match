import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { extractDocumentText } from "../../../../lib/documentExtraction";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  // 1. Get contentType from storage metadata
  const { data: fileInfo, error: metaErr } = await adminClient.storage
    .from("candidate-documents")
    .getMetadata(path);

  if (metaErr || !fileInfo) {
    console.error("[process-document] getMetadata failed", metaErr);
    return NextResponse.json({ error: "Could not read document metadata from storage." }, { status: 500 });
  }

  // 2. Run extraction using shared helper
  const { extractedText, extractionStatus } = await extractDocumentText(
    path,
    fileInfo.mimetype || "",
    adminClient,
    anthropicApiKey
  );

  // 3. Update metadata in Supabase
  try {
    const { data: profile, error: fetchErr } = await adminClient
      .from("candidate_profiles")
      .select("document_metadata")
      .eq("user_id", user.id)
      .maybeSingle();

    if (fetchErr || !profile) {
      throw new Error("Could not find profile metadata.");
    }

    const metadata = Array.isArray(profile.document_metadata) ? profile.document_metadata : [];
    const updatedMetadata = metadata.map((doc: any) => {
      if (doc.id === docId) {
        return {
          ...doc,
          extractedText,
          extractionStatus,
        };
      }
      return doc;
    });

    const { error: updateErr } = await adminClient
      .from("candidate_profiles")
      .update({ document_metadata: updatedMetadata })
      .eq("user_id", user.id);

    if (updateErr) throw updateErr;

    return NextResponse.json({ success: true, extractionStatus, extractedTextLength: extractedText.length });
  } catch (err) {
    console.error("[process-document] metadata update failed", err);
    return NextResponse.json({ error: "Failed to update document metadata." }, { status: 500 });
  }
}
