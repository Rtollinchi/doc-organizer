import Tesseract from "tesseract.js";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Preprocess image for better OCR accuracy:
 * 1. Convert to grayscale
 * 2. Resize up if small (Tesseract wants ~300 DPI equivalent)
 * 3. Binary threshold (pure black/white — best for printed text)
 * 4. Sharpen
 * 5. Output as high-quality PNG (lossless, no JPEG artifacts)
 *
 * @param originalName — the original filename (multer strips extensions)
 */
async function preprocessImage(
  filePath: string,
  originalName: string,
): Promise<string> {
  // Check the ORIGINAL filename extension, not the multer temp path
  const ext = path.extname(originalName).toLowerCase();
  if (
    ext &&
    ![".jpg", ".jpeg", ".png", ".heic", ".webp", ".tiff", ".bmp"].includes(ext)
  ) {
    return filePath; // PDFs, etc. — return as-is
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `doc-org-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );

  try {
    const meta = await sharp(filePath).metadata();
    const width = meta.width || 0;

    let pipeline = sharp(filePath).grayscale(); // step 1: remove color

    // step 2: upscale small images (phone photos are usually fine, but just in case)
    if (width > 0 && width < 2000) {
      const scale = Math.min(2550 / width, 3);
      pipeline = pipeline.resize({
        width: Math.round(width * scale),
        kernel: sharp.kernel.lanczos3,
      });
    }

    // step 3: normalize contrast then apply binary threshold
    // This turns the image into pure black text on white background
    pipeline = pipeline
      .normalize() // stretch histogram to full range
      .sharpen({ sigma: 1.5 }) // crisp edges
      .threshold(140); // binary: pixels > 140 → white, ≤ 140 → black

    await pipeline.png().toFile(tmpPath);
    console.log(
      `  Preprocessed: ${originalName} → ${tmpPath} (${width}px wide)`,
    );
    return tmpPath;
  } catch (err) {
    console.error(`  Preprocess failed for ${originalName}, using raw:`, err);
    return filePath; // fallback to unprocessed
  }
}

export async function extractText(
  filePath: string,
  originalName: string = "",
): Promise<string> {
  let processedPath: string | null = null;

  try {
    processedPath = await preprocessImage(filePath, originalName);

    const { data } = await Tesseract.recognize(processedPath, "eng", {
      logger: () => {}, // silence progress logs
    });
    return data.text;
  } finally {
    // Clean up temp file if we created one
    if (processedPath && processedPath !== filePath) {
      fs.unlink(processedPath, () => {}); // fire-and-forget cleanup
    }
  }
}
