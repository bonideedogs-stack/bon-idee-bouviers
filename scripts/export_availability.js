/**
 * Export Availability from Google Sheets tabs (by GID) into JSON files in /data
 *
 * Required env vars:
 *  - GDRIVE_SERVICE_ACCOUNT_JSON  (service account json)
 *  - AVAIL_SHEET_ID               (spreadsheet id)
 *  - AVAIL_BOUVIERS_GID           (gid for Bouviers tab)
 *  - AVAIL_LOWCHEN_GID            (gid for Lowchen tab)
 *
 * Output:
 *  - data/available-bouviers.json
 *  - data/available-lowchen.json
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function reqEnv(name) {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim() === "") return null;
  return v.trim();
}

function parseGid(v) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : null;
}

function truthyCheckbox(v) {
  // Sheets checkbox typically: TRUE/FALSE (strings) or booleans
  if (v === true) return true;
  const s = String(v || "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}

function normalizeHeader(h) {
  return String(h || "").trim();
}

function findHeaderIndex(headers, candidates) {
  const lower = headers.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

async function getDriveSheetsClients() {
  const raw = reqEnv("GDRIVE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("Missing env: GDRIVE_SERVICE_ACCOUNT_JSON");

  const creds = JSON.parse(raw);

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });

  const sheets = google.sheets({ version: "v4", auth });
  return { sheets };
}

async function gidToSheetTitle(sheets, spreadsheetId, gid) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });

  const found = (meta.data.sheets || []).find(
    (s) => s?.properties?.sheetId === gid
  );

  if (!found || !found.properties || !found.properties.title) {
    throw new Error(`Could not find a sheet tab with gid=${gid}. Check AVAIL_*_GID values.`);
  }

  return found.properties.title;
}

async function fetchRowsByTitle(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: title,
    majorDimension: "ROWS",
  });

  const values = res.data.values || [];
  if (!values.length) return { headers: [], rows: [] };

  const headers = values[0].map(normalizeHeader);
  const rows = values.slice(1);
  return { headers, rows };
}

function buildAvailability({ breedKey, headers, rows }) {
  // Your headers:
  // Available? | Litter | DOB | Collar color | Sex | Coat Color
  // We’ll match these case-insensitively and tolerate small variations.

  const idxAvail = findHeaderIndex(headers, ["Available?", "Available", "Available ?"]);
  const idxLitter = findHeaderIndex(headers, ["Litter"]);
  const idxDob = findHeaderIndex(headers, ["DOB", "Date of Birth"]);
  const idxCollar = findHeaderIndex(headers, ["Collar color", "Collar Color", "Collar"]);
  const idxSex = findHeaderIndex(headers, ["Sex"]);
  const idxCoat = findHeaderIndex(headers, ["Coat Color", "Coat colour", "Coat"]);

  const available = [];

  for (const r of rows) {
    const isAvail = idxAvail >= 0 ? truthyCheckbox(r[idxAvail]) : false;
    if (!isAvail) continue;

    available.push({
      litter: idxLitter >= 0 ? (r[idxLitter] || "") : "",
      dob: idxDob >= 0 ? (r[idxDob] || "") : "",
      collarColor: idxCollar >= 0 ? (r[idxCollar] || "") : "",
      sex: idxSex >= 0 ? (r[idxSex] || "") : "",
      coatColor: idxCoat >= 0 ? (r[idxCoat] || "") : "",
    });
  }

  return {
    breed: breedKey,
    generatedAt: new Date().toISOString(),
    availableCount: available.length,
    available,
  };
}

async function exportOne({ sheets, spreadsheetId, gid, breedKey, outFile }) {
  const title = await gidToSheetTitle(sheets, spreadsheetId, gid);
  const { headers, rows } = await fetchRowsByTitle(sheets, spreadsheetId, title);
  const out = buildAvailability({ breedKey, headers, rows });

  ensureDir("data");
  fs.writeFileSync(path.join("data", outFile), JSON.stringify(out, null, 2));
  console.log(`Wrote data/${outFile} from tab "${title}" (gid=${gid})`);
}

async function main() {
  const spreadsheetId = reqEnv("AVAIL_SHEET_ID");
  const bouviersGid = parseGid(reqEnv("AVAIL_BOUVIERS_GID"));
  const lowchenGid = parseGid(reqEnv("AVAIL_LOWCHEN_GID"));

  const missing = [];
  if (!spreadsheetId) missing.push("AVAIL_SHEET_ID");
  if (bouviersGid === null) missing.push("AVAIL_BOUVIERS_GID");
  if (lowchenGid === null) missing.push("AVAIL_LOWCHEN_GID");

  if (missing.length) {
    throw new Error(`Missing secrets: ${missing.join(", ")}`);
  }

  const { sheets } = await getDriveSheetsClients();

  await exportOne({
    sheets,
    spreadsheetId,
    gid: bouviersGid,
    breedKey: "bouviers",
    outFile: "available-bouviers.json",
  });

  await exportOne({
    sheets,
    spreadsheetId,
    gid: lowchenGid,
    breedKey: "lowchen",
    outFile: "available-lowchen.json",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
