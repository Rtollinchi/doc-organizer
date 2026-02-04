export function normalize(s: string) {
  return s.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}


