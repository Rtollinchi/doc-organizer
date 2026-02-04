import { normalize } from "./utils.js";

export function detectVendor(filename: string): string {
  const text = normalize(filename);
  if (text.includes("amazon")) return "Amazon";
  if (text.includes("grainger")) return "Grainger";
  return "Unknown";
}

export function classifyDocType(filename: string): string {
  const text = normalize(filename);

  if (text.includes("receipt") || text.includes("credit") || text.includes("visa")) {
    return "Credit_Card_Receipts";
  }
  if (text.includes("packing slip") || text.includes("pack slip")) {
    return "Packing_Slips";
  }
  if (text.includes("purchase order") || text.includes("po ")) {
    return "Purchase_Orders";
  }
  if (text.includes("order confirmation") || text.includes("confirmation")) {
    return "Order_Confirmations";
  }
  return "Miscellaneous";
}
