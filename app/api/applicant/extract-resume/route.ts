import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SYSTEM_PROMPT =
  "You extract structured data from resumes and professional documents. Return only valid JSON matching the requested schema — no markdown, no explanation, nothing else.";

const USER_PROMPT = `Extract whatever profile information is present in this document and return it as JSON. Use null for any field not found.

Return exactly this JSON shape:
{
  "fullName": string or null,
  "zipCode": string or null (US ZIP code only — 5 digits),
  "capabilitySummary": string or null (write a clean 2-4 sentence professional summary based on the document — do not quote verbatim),
  "topSkills": string or null (comma-separated list of specific skills found in the document),
  "experienceLevel": "entry" or "skilled" or "lead" or "lower management" or "management" or null,
  "industriesOfInterest": string or null (primary industry or professional field)
}

Infer experienceLevel from years of experience and seniority of roles:
- entry: 0-2 years or first professional role
- skilled: 2-5 years in a professional role
- lead: 5-10 years, or explicitly a senior individual contributor or team lead
- lower management: some supervisory or team management responsibility
- management: clear manager, director, or executive level

Return only the JSON object.`;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const path = typeof body?.path === "string" ? body.path : "";
  const contentType = typeof body?.contentType === "string" ? body.contentType : "";

  if (!path || !contentType) {
    return NextResponse.json({ error: "path and contentType are required." }, { status: 400 });
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

  // Ensure the requested path belongs to the authenticated user
  if (!path.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "Access denied." }, { status: 403 });
  }

  const isImage = contentType.startsWith("image/");
  const isPdf = contentType === "application/pdf";
  const isWord =
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    contentType === "application/msword";

  if (!isImage && !isPdf && !isWord) {
    return NextResponse.json({ extracted: null, message: "File type cannot be read automatically." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured." }, { status: 500 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: blob, error: dlErr } = await adminClient.storage
    .from("candidate-documents")
    .download(path);

  if (dlErr || !blob) {
    console.error("[extract-resume] download failed", dlErr);
    return NextResponse.json({ error: "Could not read document from storage." }, { status: 500 });
  }

  const bytes = await blob.arrayBuffer();
  const b64 = Buffer.from(bytes).toString("base64");
  const anthropic = new Anthropic({ apiKey });

  let rawText = "";
  try {
    if (isWord) {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      const docText = result.value.trim();
      if (!docText) {
        return NextResponse.json({ extracted: null, message: "Could not extract text from Word document." });
      }
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `${USER_PROMPT}\n\n---\n\n${docText}` }],
      });
      rawText = message.content.find((b) => b.type === "text")?.text ?? "";
    } else if (isPdf) {
      const message = await anthropic.beta.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        betas: ["pdfs-2024-09-25"],
        system: SYSTEM_PROMPT,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } } as any,
          { type: "text", text: USER_PROMPT },
        ] }],
      });
      rawText = message.content.find((b) => b.type === "text")?.text ?? "";
    } else {
      const mediaType = contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
          { type: "text", text: USER_PROMPT },
        ] }],
      });
      rawText = message.content.find((b) => b.type === "text")?.text ?? "";
    }
  } catch (err) {
    console.error("[extract-resume] Anthropic API error", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI extraction failed: ${msg}` }, { status: 500 });
  }

  try {
    const cleaned = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const extracted = JSON.parse(cleaned);
    return NextResponse.json({ extracted });
  } catch {
    console.error("[extract-resume] failed to parse AI response", rawText);
    return NextResponse.json({ error: "Failed to parse AI response." }, { status: 500 });
  }
}
