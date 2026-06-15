import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import mammoth from "mammoth";
import pdf from "pdf-parse";

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

  // 1. Download document
  const { data: blob, error: dlErr } = await adminClient.storage
    .from("candidate-documents")
    .download(path);

  if (dlErr || !blob) {
    console.error("[process-document] download failed", dlErr);
    return NextResponse.json({ error: "Could not read document from storage." }, { status: 500 });
  }

  const bytes = await blob.arrayBuffer();
  const buffer = Buffer.from(bytes);
  let extractedText = "";
  let extractionStatus: "complete" | "failed" = "complete";

  // 2. Extract text based on file type
  const contentType = blob.type;
  try {
    if (contentType === "application/pdf") {
      const data = await pdf(buffer);
      extractedText = data.text;
    } else if (
      contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      contentType === "application/msword"
    ) {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (contentType.startsWith("image/")) {
      // Images don't have direct text extraction in this step yet, but we'll mark as complete with empty text
      // or we could use OCR, but the instructions only mentioned PDF and DOCX for now.
      extractedText = "";
    } else {
      extractionStatus = "failed";
    }
  } catch (err) {
    console.error("[process-document] extraction failed", err);
    extractionStatus = "failed";
  }

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
