import { normalize } from "./utils.js";

export type AnalysisResult = {
  vendor: { value: string; confidence: "high" | "low" };
  docType: { value: string; confidence: "high" | "low" };
  date: { value: string; confidence: "high" | "low" };
  poNumber: { value: string | null; confidence: "high" | "low" };
  partNumber: { value: string | null; confidence: "high" | "low" };
  description: { value: string; confidence: "high" | "low" };
  rawText: string;
};

const VENDORS = [
  { name: "Amazon", keywords: ["amazon"] },
  { name: "Grainger", keywords: ["grainger", "w.w. grainger"] },
  {
    name: "McMaster_Carr",
    keywords: ["mcmaster", "mcmaster-carr", "mcmaster carr"],
  },
  { name: "Uline", keywords: ["uline"] },
  { name: "Home_Depot", keywords: ["home depot"] },
  { name: "Fastenal", keywords: ["fastenal"] },
  { name: "Linde", keywords: ["linde"] },
  { name: "Cleanova", keywords: ["cleanova"] },
  { name: "Motion_Industries", keywords: ["motion industries"] },
];

const DOC_TYPES = [
  {
    type: "Packing_Slips",
    keywords: [
      "packing slip",
      "packing list",
      "pack list",
      "packing",
      "delivery ticket",
      "ship to",
      "shipped via",
      "ship date",
      "cartons shipped",
      "box id",
    ],
  },
  {
    type: "Purchase_Orders",
    keywords: ["purchase order", "po number", "po#", "po :"],
  },
  {
    type: "Order_Confirmations",
    keywords: [
      "order confirmation",
      "confirmation number",
      "order number",
      "order placed",
    ],
  },
  {
    type: "Invoices",
    keywords: ["invoice", "invoice number", "inv#", "bill to", "amount due"],
  },
  {
    type: "Credit_Card_Receipts",
    keywords: [
      "receipt",
      "visa",
      "mastercard",
      "auth code",
      "subtotal",
      "self checkout",
      "credit card",
      "amex",
      "total due",
    ],
  },
];

function detectVendor(text: string): {
  value: string;
  confidence: "high" | "low";
} {
  const normalized = normalize(text);
  for (const v of VENDORS) {
    if (v.keywords.some((k) => normalized.includes(k))) {
      return { value: v.name, confidence: "high" };
    }
  }
  return { value: "", confidence: "low" };
}

function detectDocType(text: string): {
  value: string;
  confidence: "high" | "low";
} {
  const normalized = normalize(text);
  for (const rule of DOC_TYPES) {
    if (rule.keywords.some((k) => normalized.includes(k))) {
      return { value: rule.type, confidence: "high" };
    }
  }
  return { value: "Other", confidence: "low" };
}

function detectDate(text: string): {
  value: string;
  confidence: "high" | "low";
} {
  // Try ISO-ish: 2026-01-19, 2026.01.19, 2026/01/19
  const iso = text.match(/(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (iso) {
    return {
      value: `${iso[1]}.${iso[2].padStart(2, "0")}.${iso[3].padStart(2, "0")}`,
      confidence: "high",
    };
  }

  // US format: 01/19/2026, 1-19-26
  const us = text.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
  if (us) {
    let yyyy = us[3];
    if (yyyy.length === 2) yyyy = `20${yyyy}`;
    if (yyyy.startsWith("20")) {
      return {
        value: `${yyyy}.${us[1].padStart(2, "0")}.${us[2].padStart(2, "0")}`,
        confidence: "high",
      };
    }
  }

  // Fallback to today
  const d = new Date();
  const today = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  return { value: today, confidence: "low" };
}

function detectPO(text: string): {
  value: string | null;
  confidence: "high" | "low";
} {
  const upper = text.toUpperCase();

  // Collect numbers we should IGNORE (zip codes, phone numbers, dates, delivery numbers)
  const ignoreNumbers = new Set<string>();

  // Zip codes: 5-digit numbers after state abbreviations (NY, TX, etc.)
  const zipMatches = upper.matchAll(
    /\b[A-Z]{2}\s+([0-9]{5})(?:[.\-\s]?[0-9]{4})?\b/g,
  );
  for (const m of zipMatches) ignoreNumbers.add(m[1]);

  // Phone numbers: 10-digit sequences or 3-4-4 patterns
  const phoneMatches = upper.matchAll(
    /\b([0-9]{10})\b|(?:\(?([0-9]{3})\)?[\s.\-]?([0-9]{3})[\s.\-]?([0-9]{4}))/g,
  );
  for (const m of phoneMatches) {
    if (m[1]) ignoreNumbers.add(m[1]);
    if (m[2] && m[3] && m[4]) ignoreNumbers.add(m[2] + m[3] + m[4]);
  }

  // Delivery numbers (already captured separately)
  const delMatch = upper.match(/DELIVERY[\s#:NUMBER|]*\s*([0-9]{7,13})/);
  if (delMatch) ignoreNumbers.add(delMatch[1]);

  // Account numbers
  const acctMatch = upper.match(/ACCOUNT[\s#:NUMBER|]*\s*([0-9]{5,12})/);
  if (acctMatch) ignoreNumbers.add(acctMatch[1]);

  // Order numbers
  const orderMatch = upper.match(/ORDER\s*NUMBER[\s#:|]*\s*([0-9]{5,12})/);
  if (orderMatch) ignoreNumbers.add(orderMatch[1]);

  function isIgnored(num: string): boolean {
    if (ignoreNumbers.has(num)) return true;
    // Also ignore if this number is a substring of an ignored number (zip+4)
    for (const ign of ignoreNumbers) {
      if (ign.includes(num) || num.includes(ign)) return true;
    }
    return false;
  }

  // Pattern 1: Clean "PO00044162" or "PO 00044162" or "PO-00044162"
  const direct = upper.match(/\bPO[\s#:\-]*([0-9]{3,10})\b/);
  if (direct && !isIgnored(direct[1]))
    return { value: `PO${direct[1]}`, confidence: "high" };

  // Pattern 2: OCR misread — "P0" (zero instead of O)
  const p0 = upper.match(/\bP0[\s#:\-]*([0-9]{3,10})\b/);
  if (p0 && !isIgnored(p0[1]))
    return { value: `PO${p0[1]}`, confidence: "high" };

  // Pattern 3: Labeled field — "PO Number" then digits somewhere nearby
  const labeled = upper.match(
    /PO\s*(?:NUMBER|NUM|#|NO\.?)[\s\S]{0,30}?([0-9]{5,10})/,
  );
  if (labeled && !isIgnored(labeled[1]))
    return { value: `PO${labeled[1]}`, confidence: "high" };

  // Pattern 4: 8+ digit number on a line with "PO" (skip short numbers that could be zips)
  const lines = upper.split("\n");
  for (const line of lines) {
    // Skip address lines (contain state abbreviations + zip patterns)
    if (/\b[A-Z]{2}\s+[0-9]{5}\b/.test(line)) continue;
    // Skip phone/fax lines
    if (/PHONE|TELE|FAX|CALL/i.test(line)) continue;

    if (/PO|P\.?O\.?|P0/i.test(line)) {
      // Only match 8+ digits to avoid zip codes
      const numMatch = line.match(/([0-9]{8,10})/);
      if (numMatch && !isIgnored(numMatch[1]))
        return { value: `PO${numMatch[1]}`, confidence: "low" };
    }
  }

  return { value: null, confidence: "low" };
}

function detectPartNumber(
  text: string,
  poDigits: string | null,
  vendor: string,
): { value: string | null; confidence: "high" | "low" } {
  // Grainger is a consumables vendor — no part numbers needed
  if (vendor === "Grainger") return { value: null, confidence: "low" };

  const upper = text.toUpperCase();

  // Only return a part number if there's a clear label nearby.
  // Labels: "Part #", "Part No", "Item #", "Item No", "P/N", "Catalog #"
  // Use word boundaries (\b) to avoid matching inside words like "Department"
  const labelPatterns = [
    /\b(?:PART|CATALOG|CAT)\s*[#:NO.]+\s*([A-Z0-9]{3,12})/gi,
    /\bP\/N[:\s]*([A-Z0-9]{3,12})/gi,
    /\bITEM\s*[#:NO.]+\s*([A-Z0-9]{3,12})/gi,
  ];

  for (const re of labelPatterns) {
    const m = re.exec(upper);
    if (m) {
      const val = m[1];
      // Skip years, PO digits, and very short matches
      if (val.startsWith("20") && val.length === 4) continue;
      if (poDigits && val === poDigits) continue;
      if (val.length < 3) continue;
      return { value: val, confidence: "high" };
    }
  }

  // No labeled part number found — don't guess
  return { value: null, confidence: "low" };
}

function extractDescription(
  text: string,
  docType: string,
): { value: string; confidence: "high" | "low" } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 3);

  // ── Packing slips / invoices: parse item lines ──
  if (docType === "Packing_Slips" || docType === "Invoices") {
    const items = parseItemLines(lines);
    if (items.length) {
      // Include as many items as will fit within ~120 chars
      const shortNames = items.map((item) => shortenItemName(item));
      const included: string[] = [];
      let len = 0;
      for (const name of shortNames) {
        // +2 for ", " separator
        if (len > 0 && len + name.length + 2 > 120) break;
        included.push(name);
        len += name.length + (included.length > 1 ? 2 : 0);
      }
      const desc = included.join(", ");
      return { value: desc, confidence: "high" };
    }
  }

  // ── Receipts: look for store or first item ──
  if (docType === "Credit_Card_Receipts") {
    for (const line of lines.slice(0, 10)) {
      if (/self\s*checkout|store|sale/i.test(line)) continue;
      if (/receipt|visa|mastercard|auth|total/i.test(line)) continue;
      if (line.length > 5 && line.length < 60 && /[a-zA-Z]/.test(line)) {
        return { value: line.trim(), confidence: "low" };
      }
    }
  }

  return { value: "", confidence: "low" };
}

/**
 * Parse item lines from packing slip OCR text.
 * Grainger format: [item#] [description] [quantities/prices at end]
 * e.g. "52CD02- Ice Scraper, Steel, 7\" W  3  0  -3  E  90.62  271.86"
 *      "1FD55 Lid Ext Crd,50f,14Ga,15A,SJTW,Org/Blk  0  4  0  0.00  0.00"
 */
function parseItemLines(lines: string[]): string[] {
  const items: string[] = [];

  // Grainger item codes ALWAYS have both letters and digits:
  // 52CD02, 1FD55, 1VAJ7, 21A070, 2F146, 3EA99
  // This regex requires at least one digit and one letter in the code.
  const itemLineRe =
    /^[^a-zA-Z0-9]*(?:\d{0,2}\s+)?([A-Z0-9]{4,8})\s*[-–.]?\s+(.+)/i;

  for (const line of lines) {
    const m = line.match(itemLineRe);
    if (!m) continue;

    const code = m[1];
    let desc = m[2].trim();

    // Code MUST contain both letters and digits (skip pure words like "WELL", "BOXID")
    if (!/[A-Za-z]/.test(code) || !/[0-9]/.test(code)) continue;

    // Skip WWG secondary detail lines
    if (/^WWG/i.test(code)) continue;

    // Skip garbage / header lines
    if (desc.length < 3) continue;
    if (/^(Granger|Customer|UOM|Part\s*Nbr|Caller|Carrier)/i.test(desc))
      continue;

    // Clean trailing numeric noise (prices, quantities, OCR garbage)
    desc = desc.replace(/\s+[\d.,$Eco]+(?:\s+[\d.,$Eco]+)*\s*$/, "").trim();
    // Remove trailing OCR artifacts
    desc = desc.replace(/\s*[~\-_|\[\]{}]+\s*$/, "").trim();

    if (desc.length > 2) {
      items.push(desc);
    }
  }

  return items;
}

/**
 * Shorten an item description to a compact human-readable name.
 * "Ice Scraper, Steel, 7\" W" → "Ice Scraper"
 * "Lid Ext Crd,50f,14Ga,15A,SJTW,Org/Blk" → "50ft Ext Cord"
 * "Handheld Oust Pan Black" → "Dust Pan"
 * "Starting Fluid Aerosol, 11 Oz." → "Starting Fluid"
 * "Cutting Oil, 12 oz.,Aerosol" → "Cutting Oil"
 */
function shortenItemName(desc: string): string {
  // Common Grainger abbreviation expansions
  const abbrevs: [RegExp, string][] = [
    [/\bLid\s*Ext\s*Crd\b/i, "Ext Cord"],
    [/\bLtd\s*Ext\s*Crd\b/i, "Ext Cord"],
    [/\bExt\s*Crd\b/i, "Ext Cord"],
    [/\bOust\s*Pan\b/i, "Dust Pan"], // common OCR misread
    [/\bDust\s*Pan\b/i, "Dust Pan"],
    [/\bHx\s*Bolt\b/i, "Hex Bolt"],
  ];

  let name = desc;

  // Apply abbreviation expansions
  for (const [re, replacement] of abbrevs) {
    if (re.test(name)) {
      name = name.replace(re, replacement);
    }
  }

  // Extract a length prefix like "50f" or "25ft" or "25R" (OCR for 25ft) → "50ft"
  const lengthMatch = name.match(/(\d+)\s*(?:ft?|foot|feet|R)\b/i);
  const lengthPrefix = lengthMatch ? `${lengthMatch[1]}ft ` : "";

  // If we expanded an abbreviation, use the expanded name with length
  if (name !== desc) {
    const mainName = name.split(/[,;]/)[0].trim();
    // Strip filler words for compactness
    const cleaned = mainName
      .replace(/\bHandheld\b/i, "")
      .replace(/\bBlack\b/i, "")
      .replace(/\bWhite\b/i, "")
      .replace(/\bOrange\b/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (lengthPrefix && /cord|cable|crd/i.test(desc)) {
      return lengthPrefix + cleaned;
    }
    return cleaned;
  }

  // No abbreviation matched — take first part before comma/specs
  const firstPart = name
    .split(/[,;]/)[0]
    .trim()
    .replace(/\s+\d+\s*["']?\s*[WwHhLl]?\s*$/, "") // strip dimensions: 7" W
    .replace(/\s+\d+\s*[Oo]z\.?\s*$/i, "") // strip size: 11 Oz.
    .replace(/\bAerosol\b/i, "") // strip "Aerosol" delivery form
    .replace(/\bHandheld\b/i, "") // strip "Handheld"
    .replace(/\s{2,}/g, " ")
    .trim();

  return firstPart || desc;
}

/**
 * Pre-process OCR text to fix common Tesseract character swaps.
 * This doesn't change the rawText stored in the result — only used
 * to improve detection accuracy.
 */
function preprocessOCR(text: string): string {
  let t = text;
  // Tesseract often swaps O↔0, l↔1, S↔5, B↔8
  // Normalize lines that look like "PO Number" fields
  t = t.replace(/P[O0]\s*[Nn][uü][mn][b8][e3][rn]/g, "PO Number");
  t = t.replace(/[Pp][O0]\s*#/g, "PO#");
  // Fix "romero" → "PO Number" (common Tesseract garble for this phrase)
  t = t.replace(/[Rr]omero/g, "PO Number");
  return t;
}

export function analyzeText(rawText: string): AnalysisResult {
  // Use preprocessed text for detection, but keep raw for storage
  const cleaned = preprocessOCR(rawText);
  const vendor = detectVendor(cleaned);
  const docType = detectDocType(cleaned);
  const date = detectDate(cleaned);
  const po = detectPO(cleaned);

  const poDigits = po.value ? po.value.replace("PO", "") : null;
  const partNumber = detectPartNumber(cleaned, poDigits, vendor.value);
  const description = extractDescription(cleaned, docType.value);

  return {
    vendor,
    docType,
    date,
    poNumber: po,
    partNumber,
    description,
    rawText,
  };
}
