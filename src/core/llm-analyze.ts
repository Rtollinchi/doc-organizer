import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";

// Re-use the same AnalysisResult shape so the UI doesn't change
export type AnalysisResult = {
  vendor: { value: string; confidence: "high" | "low" };
  docType: { value: string; confidence: "high" | "low" };
  date: { value: string; confidence: "high" | "low" };
  poNumber: { value: string | null; confidence: "high" | "low" };
  partNumber: { value: string | null; confidence: "high" | "low" };
  description: { value: string; confidence: "high" | "low" };
  rawText: string;
};

const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = "llama3.2-vision:11b";

const PROMPT = `You are a document analysis assistant for a maintenance purchasing department.
Analyze this scanned business document image and extract the following fields.
Return ONLY a valid JSON object — no explanation, no markdown, no code fences.

Fields:
- vendor: The seller/company name (e.g. "Grainger", "Amazon", "Home Depot", "McMaster-Carr", "Uline", "Fastenal", "Linde", "Cleanova", "Motion Industries")
- docType: Exactly one of: "Packing_Slips", "Credit_Card_Receipts", "Purchase_Orders", "Order_Confirmations", "Invoices"
- date: The document date in YYYY.MM.DD format (e.g. "2026.02.11")
- poNumber: Purchase order number if visible (include "PO" prefix, e.g. "PO00044162"), or null
- partNumber: A part/catalog/item number if visible, or null
- description: Brief comma-separated list of items on the document (max 120 characters). Focus on product names, not quantities or prices.

Example output:
{"vendor":"Grainger","docType":"Packing_Slips","date":"2026.02.06","poNumber":"PO00044162","partNumber":null,"description":"Ice Scraper, 50ft Ext Cord, Dust Pan, Starting Fluid"}`;

// ── Light preprocessing for LLM (keep colors, just resize if huge) ──

async function prepareForLLM(
  filePath: string,
  originalName: string,
): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  if (
    ext &&
    ![".jpg", ".jpeg", ".png", ".heic", ".webp", ".tiff", ".bmp"].includes(ext)
  ) {
    return filePath; // non-image — return as-is
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `doc-llm-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );

  try {
    const meta = await sharp(filePath).metadata();
    const width = meta.width || 0;

    let pipeline = sharp(filePath);

    // Resize very large images down (saves LLM processing time + memory)
    if (width > 2048) {
      pipeline = pipeline.resize({ width: 2048, withoutEnlargement: true });
    }

    // Light contrast boost — helps with phone photos of receipts
    pipeline = pipeline.normalize();

    await pipeline.png().toFile(tmpPath);
    console.log(
      `  LLM prep: ${originalName} → ${tmpPath} (${width}px → ≤2048px)`,
    );
    return tmpPath;
  } catch (err) {
    console.error(`  LLM prep failed for ${originalName}, using raw:`, err);
    return filePath;
  }
}

function imageToBase64(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString("base64");
}

// ── Health check ──

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return false;
    const data = (await res.json()) as {
      models?: Array<{ name: string }>;
    };

    const models = data.models || [];
    console.log(
      `  Ollama models found: ${models.map((m) => m.name).join(", ")}`,
    );

    // Check that a vision model is pulled
    const hasVision = models.some((m) => m.name.includes("llama3.2-vision"));
    return hasVision;
  } catch (err) {
    console.log(`  Ollama check failed: ${err}`);
    return false;
  }
}

// ── Analyze a single image ──

export async function analyzeImage(
  filePath: string,
  originalName: string,
): Promise<AnalysisResult> {
  const prepared = await prepareForLLM(filePath, originalName);
  const base64 = imageToBase64(prepared);

  // Clean up temp file
  if (prepared !== filePath) {
    try {
      fs.unlinkSync(prepared);
    } catch {}
  }

  console.log(`  Sending to Ollama (${MODEL})...`);
  const start = Date.now();

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: PROMPT,
          images: [base64],
        },
      ],
      stream: false,
      format: "json",
      options: {
        temperature: 0.1, // low temp = more deterministic
        num_predict: 512, // we only need a short JSON response
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
  };
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const content = data.message?.content || "{}";
  console.log(`  LLM responded in ${elapsed}s`);
  console.log(`  Raw LLM JSON: ${content}`);

  return parseResponse(content);
}

// ── Analyze multiple images as one document (multi-page mode) ──

export async function analyzeMultipleImages(
  files: Array<{ path: string; originalName: string }>,
): Promise<AnalysisResult> {
  const images: string[] = [];

  for (const file of files) {
    const prepared = await prepareForLLM(file.path, file.originalName);
    images.push(imageToBase64(prepared));
    if (prepared !== file.path) {
      try {
        fs.unlinkSync(prepared);
      } catch {}
    }
  }

  console.log(`  Sending ${files.length} pages to Ollama (${MODEL})...`);
  const start = Date.now();

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: `These ${files.length} images are pages of the SAME document. Analyze them together as one document.\n\n${PROMPT}`,
          images,
        },
      ],
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
        num_predict: 512,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
  };
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const content = data.message?.content || "{}";
  console.log(`  LLM responded in ${elapsed}s`);
  console.log(`  Raw LLM JSON: ${content}`);

  return parseResponse(content);
}

// ── Parse and normalize the LLM response into AnalysisResult ──

function parseResponse(content: string): AnalysisResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.error("Failed to parse LLM JSON:", content);
    parsed = {};
  }

  // ── Vendor normalization ──
  const vendorMap: Record<string, string> = {
    grainger: "Grainger",
    "w.w. grainger": "Grainger",
    "w.w.grainger": "Grainger",
    amazon: "Amazon",
    "amazon.com": "Amazon",
    "home depot": "Home_Depot",
    "the home depot": "Home_Depot",
    homedepot: "Home_Depot",
    mcmaster: "McMaster_Carr",
    "mcmaster-carr": "McMaster_Carr",
    "mcmaster carr": "McMaster_Carr",
    uline: "Uline",
    fastenal: "Fastenal",
    linde: "Linde",
    cleanova: "Cleanova",
    "motion industries": "Motion_Industries",
  };

  const rawVendor = String(parsed.vendor || "").trim();
  const normalizedVendor =
    vendorMap[rawVendor.toLowerCase()] || rawVendor.replace(/\s+/g, "_") || "";
  const hasVendor = normalizedVendor.length > 0;

  // ── Doc type ──
  const validDocTypes = [
    "Packing_Slips",
    "Credit_Card_Receipts",
    "Purchase_Orders",
    "Order_Confirmations",
    "Invoices",
  ];
  const rawDocType = String(parsed.docType || "").trim();
  const hasDocType = validDocTypes.includes(rawDocType);
  const docType = hasDocType ? rawDocType : "Other";

  // ── Date ──
  const rawDate = String(parsed.date || "").trim();
  const hasDate = /^\d{4}\.\d{2}\.\d{2}$/.test(rawDate);
  const date = hasDate
    ? rawDate
    : (() => {
        const d = new Date();
        return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
      })();

  // ── PO number ──
  const rawPO = parsed.poNumber ? String(parsed.poNumber).trim() : null;
  const po =
    rawPO && rawPO !== "null" && rawPO !== "N/A"
      ? rawPO.toUpperCase().startsWith("PO")
        ? rawPO
        : `PO${rawPO}`
      : null;

  // ── Part number ──
  const rawPart = parsed.partNumber ? String(parsed.partNumber).trim() : null;
  const part =
    rawPart && rawPart !== "null" && rawPart !== "N/A" ? rawPart : null;

  // ── Description (cap at 120 chars) ──
  const rawDesc = String(parsed.description || "").trim();
  const desc = rawDesc.length > 120 ? rawDesc.slice(0, 117) + "..." : rawDesc;

  return {
    vendor: {
      value: normalizedVendor,
      confidence: hasVendor ? "high" : "low",
    },
    docType: { value: docType, confidence: hasDocType ? "high" : "low" },
    date: { value: date, confidence: hasDate ? "high" : "low" },
    poNumber: { value: po, confidence: po ? "high" : "low" },
    partNumber: { value: part, confidence: part ? "high" : "low" },
    description: {
      value: desc,
      confidence: rawDesc.length > 0 ? "high" : "low",
    },
    rawText: `[LLM Vision Analysis]\n${JSON.stringify(parsed, null, 2)}`,
  };
}
