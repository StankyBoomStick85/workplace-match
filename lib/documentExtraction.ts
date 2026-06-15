import mammoth from "mammoth";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdf: (buffer: Buffer) => Promise<{ text: string }> = require("pdf-parse");
import Anthropic from "@anthropic-ai/sdk";

const VISION_PROMPT = `Transcribe all readable text from this document and describe its relevant content. 
This document may be a certification, award order, military record (NCOER/OER), diploma, or credential screenshot.

Guidelines:
- Preserve all names, dates, ratings, and specific achievement language exactly as written.
- Maintain the original structure and context as much as possible.
- If it is a form or certificate, clearly label the fields and values.
- Do not summarize or paraphrase key evidence; the capability profile relies on these specific details.

Return the transcription and description in a clear, readable format.`;

export type ExtractionResult = {
  extractedText: string;
  extractionStatus: "complete" | "failed";
};

export async function extractDocumentText(
  storagePath: string,
  contentType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminClient: any,
  anthropicApiKey?: string
): Promise<ExtractionResult> {
  let extractedText = "";
  let extractionStatus: "complete" | "failed" = "complete";

  try {
    const { data: blob, error: dlErr } = await adminClient.storage
      .from("candidate-documents")
      .download(storagePath);

    if (dlErr || !blob) {
      console.error("[extractDocumentText] download failed", dlErr);
      return { extractedText: "", extractionStatus: "failed" };
    }

    const bytes = await blob.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (contentType === "application/pdf") {
      const data = await pdf(buffer);
      extractedText = data.text;

      // If text is empty or near-empty, treat as scanned PDF and use Claude Vision
      if (extractedText.trim().length < 20 && anthropicApiKey) {
        const anthropic = new Anthropic({ apiKey: anthropicApiKey });
        const b64 = buffer.toString("base64");
        
        const message = await anthropic.beta.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          betas: ["pdfs-2024-09-25"],
          messages: [{
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } } as any,
              { type: "text", text: VISION_PROMPT },
            ],
          }],
        });
        extractedText = message.content.find((b) => b.type === "text")?.text ?? "";
      }
    } else if (
      contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      contentType === "application/msword"
    ) {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (contentType.startsWith("image/") && anthropicApiKey) {
      const anthropic = new Anthropic({ apiKey: anthropicApiKey });
      const b64 = buffer.toString("base64");
      const mediaType = contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: VISION_PROMPT },
          ],
        }],
      });
      extractedText = message.content.find((b) => b.type === "text")?.text ?? "";
    } else if (contentType.startsWith("image/")) {
      extractedText = "";
      extractionStatus = "failed";
    } else {
      extractionStatus = "failed";
    }
  } catch (err) {
    console.error("[extractDocumentText] extraction failed", err);
    extractionStatus = "failed";
  }

  return { extractedText, extractionStatus };
}
