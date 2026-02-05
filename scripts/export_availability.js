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

function getEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function parseGid(v) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : null;
}

function truthyCheckbox(v) {
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

async function getSheetsClient() {
  const raw = getEnv("GDRIVE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("Missing env: GDRIVE_SERVICE_ACCOUNT_JSON");

  const creds = JSON.parse(raw);

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });

  return google.sheets({ version: "v4", auth });
}

async function gidToSheetTitle(sheets, spreadsheetId, gid) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });

  const found = (meta.data.sheets || []).find(
    (s) => s?.properties?.sheetId === gid
  );

  if (!found?.properties?.title) {
    throw new Error(
      `Could not find a sheet tab with gid=${gid}. Check AVAIL_*_GID secrets.`
    );
  }

  return found.properties.title;
}

async function fetchTabRows(sheets, spreadsheetId, tabTitle) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabTitle,
    majorDimension: "ROWS",
  });

  const values = res.data.values || [];
  if (!values.length) return { headers: [], rows: [] };

  const headers = values[0].map(normalizeHeader);
  const rows = values.slice(1);
  return { headers, rows };
}

function buildAvailability(headers, rows, breedKey) {
  // Expected columns:
  // Available? | Litter | DOB | Collar color | Sex | Coat Color
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
  const tabTitle = await gidToSheetTitle(sheets, spreadsheetId, gid);
  const { headers, rows } = await fetchTabRows(sheets, spreadsheetId, tabTitle);
  const out = buildAvailability(headers, rows, breedKey);

  ensureDir("data");
  fs.writeFileSync(path.join("data", outFile), JSON.stringify(out, null, 2));
  console.log(`Wrote data/${outFile} from tab "${tabTitle}" (gid=${gid})`);
}

async function main() {
  const sheetId = getEnv("AVAIL_SHEET_ID");
  const bouviersGid = parseGid(getEnv("AVAIL_BOUVIERS_GID"));
  const lowchenGid = parseGid(getEnv("AVAIL_LOWCHEN_GID"));

  const missing = [];
  if (!sheetId) missing.push("AVAIL_SHEET_ID");
  if (bouviersGid === null) missing.push("AVAIL_BOUVIERS_GID");
  if (lowchenGid === null) missing.push("AVAIL_LOWCHEN_GID");

  if (missing.length) {
    throw new Error(`Missing secrets: ${missing.join(", ")}`);
  }

  const sheets = await getSheetsClient();

  await exportOne({
    sheets,
    spreadsheetId: sheetId,
    gid: bouviersGid,
    breedKey: "bouviers",
    outFile: "available-bouviers.json",
  });

  await exportOne({
    sheets,
    spreadsheetId: sheetId,
    gid: lowchenGid,
    breedKey: "lowchen",
    outFile: "available-lowchen.json",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
