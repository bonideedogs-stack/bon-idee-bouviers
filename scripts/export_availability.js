const fs = require("fs");
const path = require("path");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function csvSplitLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(v => v.trim());
}

function slugHeader(h) {
  return (h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w ?]/g, "");
}

function parseCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headersRaw = csvSplitLine(lines[0]);
  const headers = headersRaw.map(slugHeader);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = csvSplitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cols[idx] ?? "").trim();
    });
    rows.push(obj);
  }
  return rows;
}

async function fetchCsvByGid(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.status} ${res.statusText}`);
  return await res.text();
}

function isAvailable(value) {
  const v = (value || "").trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "available";
}

function normalize(rows) {
  // Expected headers:
  // Available? | Litter | DOB | Collar color | Sex | Color
  const available = rows
    .filter(r => isAvailable(r["available?"]))
    .map(r => ({
      litter: r["litter"] || "",
      dob: r["dob"] || "",
      collar_color: r["collar color"] || "",
      sex: r["sex"] || "",
      color: r["color"] || "",
    }));

  // Simple sort so it stays tidy
  available.sort((a, b) => {
    const ad = (a.dob || "").toLowerCase();
    const bd = (b.dob || "").toLowerCase();
    if (ad < bd) return -1;
    if (ad > bd) return 1;
    return (a.litter || "").localeCompare(b.litter || "");
  });

  return {
    generatedAt: new Date().toISOString(),
    available
  };
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  const bouviersGid = process.env.BOUVIERS_GID;
  const lowchenGid = process.env.LOWCHEN_GID;

  if (!sheetId || !bouviersGid || !lowchenGid) {
    throw new Error("Missing secrets: AVAIL_SHEET_ID, AVAIL_BOUVIERS_GID, AVAIL_LOWCHEN_GID");
  }

  ensureDir("data");

  const bouviersCsv = await fetchCsvByGid(sheetId, bouviersGid);
  const lowchenCsv = await fetchCsvByGid(sheetId, lowchenGid);

  const bouviersRows = parseCsv(bouviersCsv);
  const lowchenRows = parseCsv(lowchenCsv);

  fs.writeFileSync(
    path.join("data", "availability-bouviers.json"),
    JSON.stringify(normalize(bouviersRows), null, 2)
  );

  fs.writeFileSync(
    path.join("data", "availability-lowchen.json"),
    JSON.stringify(normalize(lowchenRows), null, 2)
  );

  console.log("Availability exported.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
