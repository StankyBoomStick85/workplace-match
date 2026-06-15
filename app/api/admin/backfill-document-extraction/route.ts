import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { adminSessionKey } from "../../../../lib/adminAuth";
import { extractDocumentText } from "../../../../lib/documentExtraction";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const userIdParam = requestUrl.searchParams.get("userId");

  // Admin Check
  const cookieStore = cookies();
  const isAdmin = cookieStore.get(adminSessionKey)?.value === "true";
  if (!isAdmin) {
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    let targetProfiles: any[] = [];
    if (userIdParam) {
      const { data, error } = await adminClient
        .from("candidate_profiles")
        .select("user_id, document_metadata")
        .eq("user_id", userIdParam)
        .maybeSingle();
      if (error) throw error;
      if (data) targetProfiles = [data];
    } else {
      // Find one user who has at least one document needing extraction
      // We'll fetch a batch and find the first one in JS to keep it simple but safe
      const { data, error } = await adminClient
        .from("candidate_profiles")
        .select("user_id, document_metadata")
        .not("document_metadata", "eq", "[]")
        .limit(100); // Fetch a small batch to check
      if (error) throw error;
      targetProfiles = data || [];
    }

    let stats = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    let hasMore = false;
    let processedUserIds: string[] = [];

    // Process only ONE user who needs work to avoid timeouts
    let userToProcess: any = null;
    for (const profile of targetProfiles) {
      const docs = Array.isArray(profile.document_metadata) ? profile.document_metadata : [];
      const needsWork = docs.some((doc: any) => !doc.extractedText && doc.extractionStatus !== "complete");
      if (needsWork) {
        userToProcess = profile;
        break;
      } else {
        stats.skipped += docs.length;
      }
    }

    if (userToProcess) {
      const docs = Array.isArray(userToProcess.document_metadata) ? userToProcess.document_metadata : [];
      const updatedDocs = [...docs];
      
      for (let i = 0; i < updatedDocs.length; i++) {
        const doc = updatedDocs[i];
        if (!doc.extractedText && doc.extractionStatus !== "complete") {
          stats.processed++;
          
          // Get contentType if missing
          let contentType = doc.contentType;
          if (!contentType) {
            const pathParts = doc.path.split('/');
            const fileName = pathParts.pop();
            const folderPath = pathParts.join('/');
            const { data: listData } = await adminClient.storage
              .from("candidate-documents")
              .list(folderPath, { search: fileName });
            contentType = listData?.[0]?.metadata?.mimetype || "";
          }

          const { extractedText, extractionStatus } = await extractDocumentText(
            doc.path,
            contentType,
            adminClient,
            anthropicApiKey
          );

          updatedDocs[i] = {
            ...doc,
            contentType, // ensure it's saved if we had to look it up
            extractedText,
            extractionStatus,
          };

          if (extractionStatus === "complete") stats.succeeded++;
          else stats.failed++;

          // Update after EACH document to preserve progress
          await adminClient
            .from("candidate_profiles")
            .update({ document_metadata: updatedDocs })
            .eq("user_id", userToProcess.user_id);
            
          // Short delay to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          stats.skipped++;
        }
      }
      processedUserIds.push(userToProcess.user_id);
      hasMore = !userIdParam; // Check for more in next call if we're doing global backfill
    }

    return NextResponse.json({
      success: true,
      stats,
      processedUserIds,
      hasMore,
      message: userToProcess 
        ? `Processed documents for user ${userToProcess.user_id}` 
        : "No more documents to process."
    });

  } catch (err) {
    console.error("[backfill-document-extraction] failed", err);
    return NextResponse.json({ 
      error: err instanceof Error ? err.message : "Internal server error" 
    }, { status: 500 });
  }
}
