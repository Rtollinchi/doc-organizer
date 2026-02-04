import fs from "node:fs/promises";
import path from "node:path";
import { classifyDocType, detectVendor } from "../core/classify.js";
import { todayYYYYMMDD } from "../core/utils.js";

async function main() {
  const intakeDir = path.resolve("example/intake");
  const files =  await fs.readdir(intakeDir);

  for (const file of files) {
    const vendor = detectVendor(file);
    const docType = classifyDocType(file);
    const date = todayYYYYMMDD();

    const ext = path.extname(file);
    const base = path.basename(file, ext);

    const targetName = `${date} - ${vendor} - ${base}${ext}`;
    const targetRelPath = path.join(docType, targetName);

    console.log(`${file} => ${targetRelPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

