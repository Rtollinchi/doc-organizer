import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { extractText } from "../core/ocr.js";
import { analyzeText } from "../core/analyze.js";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static(path.resolve("src/server/public")));
app.use(express.json());

const VENDORS = [
  "Amazon",
  "Grainger",
  "McMaster_Carr",
  "Uline",
  "Home_Depot",
  "Fastenal",
  "Linde",
  "Cleanova",
  "Motion_Industries",
];

const DOC_TYPES = [
  "Credit_Card_Receipts",
  "Packing_Slips",
  "Purchase_Orders",
  "Order_Confirmations",
  "Invoices",
];

// API: Batch upload + analyze via OCR
app.post("/api/analyze-batch", upload.array("files", 50), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || !files.length) {
      res.status(400).json({ error: "No files uploaded" });
      return;
    }

    console.log(`\nAnalyzing ${files.length} file(s)...`);

    // Process all files in parallel
    const results = await Promise.all(
      files.map(async (file) => {
        try {
          console.log(`  OCR: ${file.originalname}`);
          const text = await extractText(file.path, file.originalname);
          console.log(`\n--- RAW OCR TEXT (${file.originalname}) ---`);
          console.log(text);
          console.log(`--- END OCR TEXT ---\n`);
          const analysis = analyzeText(text);
          console.log(
            `  Done: ${file.originalname} → ${analysis.vendor.value} / ${analysis.docType.value} / PO: ${analysis.poNumber.value}`,
          );
          return {
            tempFile: file.filename,
            originalName: file.originalname,
            analysis,
            status: "analyzed" as const,
          };
        } catch (err) {
          console.error(`  Error on ${file.originalname}:`, err);
          return {
            tempFile: file.filename,
            originalName: file.originalname,
            analysis: null,
            status: "error" as const,
          };
        }
      }),
    );

    res.json({ results, vendors: VENDORS, docTypes: DOC_TYPES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Batch analysis failed" });
  }
});

// API: Multi-page mode — OCR all files and merge text into one result
app.post(
  "/api/analyze-multipage",
  upload.array("files", 50),
  async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || !files.length) {
        res.status(400).json({ error: "No files uploaded" });
        return;
      }

      console.log(`\nAnalyzing ${files.length} page(s) as ONE document...`);

      // OCR each page in parallel
      const pages = await Promise.all(
        files.map(async (file, idx) => {
          console.log(`  OCR page ${idx + 1}: ${file.originalname}`);
          const text = await extractText(file.path, file.originalname);
          return { file, text };
        }),
      );

      // Concatenate all page text
      const combinedText = pages
        .map((p) => p.text)
        .join("\n\n--- PAGE BREAK ---\n\n");
      console.log(`\n--- COMBINED OCR TEXT (${files.length} pages) ---`);
      console.log(combinedText);
      console.log(`--- END COMBINED OCR TEXT ---\n`);

      const analysis = analyzeText(combinedText);
      console.log(
        `  Done: ${files.length} pages → ${analysis.vendor.value} / ${analysis.docType.value} / PO: ${analysis.poNumber.value}`,
      );

      // Return as a single-item result, keeping only the first file as tempFile
      // (we'll store all temp filenames so confirm can clean them up)
      const results = [
        {
          tempFile: files[0].filename,
          tempFiles: files.map((f) => f.filename),
          originalName: files.map((f) => f.originalname).join(" + "),
          analysis,
          status: "analyzed" as const,
        },
      ];

      res.json({ results, vendors: VENDORS, docTypes: DOC_TYPES });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Multi-page analysis failed" });
    }
  },
);

// API: Confirm batch — rename + move files
app.post("/api/confirm-batch", async (req, res) => {
  try {
    const { items } = req.body as {
      items: Array<{
        tempFile: string;
        tempFiles?: string[];
        originalName: string;
        vendor: string;
        docType: string;
        date: string;
        description: string;
        partNumber: string;
        poNumber: string;
        requestedBy: string;
      }>;
    };

    const logDir = path.resolve("logs");
    await fs.mkdir(logDir, { recursive: true });

    const results: Array<{
      originalName: string;
      newName: string;
      targetDir: string;
      success: boolean;
    }> = [];

    for (const item of items) {
      try {
        // Determine which temp files to move
        const tempFileList =
          item.tempFiles && item.tempFiles.length
            ? item.tempFiles
            : [item.tempFile];

        // Get extension from original name (use first file's name for multipage)
        const firstName =
          item.originalName.split(" + ")[0] || item.originalName;
        const ext = path.extname(firstName);

        // Build filename: Date - Vendor - Description - For X - Part# - PO#
        const parts = [item.date, item.vendor];
        if (item.description) parts.push(item.description);
        if (item.requestedBy) parts.push(`For ${item.requestedBy}`);
        if (item.partNumber) parts.push(item.partNumber);
        if (item.poNumber) parts.push(item.poNumber);
        const baseName = parts.join(" - ");

        // Route packing slips to vendor-specific folders
        let targetDir: string;
        if (item.docType === "Packing_Slips") {
          targetDir = path.resolve("output", `Packing_Slips_${item.vendor}`);
        } else {
          targetDir = path.resolve("output", item.docType);
        }

        await fs.mkdir(targetDir, { recursive: true });

        // Move each page
        const movedNames: string[] = [];
        for (let p = 0; p < tempFileList.length; p++) {
          const tempPath = path.join("uploads", tempFileList[p]);

          // Single page: "name.jpeg"  Multi: "name - Page 1.jpeg", "name - Page 2.jpeg"
          const pageName =
            tempFileList.length === 1
              ? baseName + ext
              : `${baseName} - Page ${p + 1}${ext}`;

          // Handle filename conflicts
          let targetPath = path.join(targetDir, pageName);
          let counter = 2;
          while (true) {
            try {
              await fs.access(targetPath);
              const base = pageName.slice(0, -ext.length);
              targetPath = path.join(targetDir, `${base} (${counter})${ext}`);
              counter++;
            } catch {
              break;
            }
          }

          await fs.rename(tempPath, targetPath);
          movedNames.push(path.basename(targetPath));
        }

        const newName = movedNames.join(", ");

        // Audit log
        await fs.appendFile(
          path.join(logDir, "audit.jsonl"),
          JSON.stringify({
            ts: new Date().toISOString(),
            source: item.originalName,
            target: movedNames.join(", "),
            targetDir,
            pages: tempFileList.length,
            vendor: item.vendor,
            docType: item.docType,
            date: item.date,
            description: item.description,
            partNumber: item.partNumber,
            poNumber: item.poNumber,
            requestedBy: item.requestedBy,
          }) + "\n",
        );

        console.log(`  Moved: ${item.originalName} → ${newName}`);
        results.push({
          originalName: item.originalName,
          newName,
          targetDir,
          success: true,
        });
      } catch (err) {
        console.error(`  Failed: ${item.originalName}`, err);
        results.push({
          originalName: item.originalName,
          newName: "",
          targetDir: "",
          success: false,
        });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Batch confirm failed" });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n📄 Doc Organizer running at http://localhost:${PORT}\n`);
});
