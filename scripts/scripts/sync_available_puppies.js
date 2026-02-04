const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function normalizeHeader(h) {
  return String(h || "").trim();
}

function truthyCheckbox(v) {
  // Sheets checkbox typically comes through as TRUE/FALSE (strings) or booleans
  const s = String(v || "").trim().toLowerCase();
  return v === true || s === "true" || s === "yes" || s === "y" || s === "1";
}

async function getAuth() {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GDRIVE_SERVICE_ACCOUNT_JSON secret");
  const creds = JSON.parse(raw);

  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

async function fetchTabRows({ sheets, spreadsheetId, tabName }) {
  // Pull the whole tab. If you ever want, we can limit range.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabName,
    majorDimension: "ROWS",
  });

  const values = res.data.values || [];
  if (!values.length) return [];

  const headers = values[0].map(normalizeHeader);
  const rows = values.slice(1);

  return rows.map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? "";
    });
    return obj;
  });
}

function buildOutput({ breedKey, rows }) {
  // Expected headers from you:
  // Available? | Litter | DOB | Collar color | Sex | Coat Color
  const items = rows.map((r) => {
    const available = truthyCheckbox(r["Available?"]);
    return {
      available,
      litter: r["Litter"] || "",
      dob: r["DOB"] || "",
      collarColor: r["Collar color"] || "",
      sex: r["Sex"] || "",
      coatColor: r["Coat Color"] || "",
    };
  });

  const availableItems = items.filter((x) => x.available);

  return {
    breed: breedKey,
    generatedAt: new Date().toISOString(),
    totalRows: items.length,
    availableCount: availableItems.length,
    available: availableItems,
  };
}

async function main() {
  const spreadsheetId = process.env.GSHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("Missing GSHEETS_SPREADSHEET_ID secret");

  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const dataDir = "data";
  ensureDir(dataDir);

  // Tabs must match your sheet tab names exactly
  const bouviersRows = await fetchTabRows({ sheets, spreadsheetId, tabName: "Bouviers" });
  const lowchenRows = await fetchTabRows({ sheets, spreadsheetId, tabName: "Lowchen" });

  const bouviersOut = buildOutput({ breedKey: "bouviers", rows: bouviersRows });
  const lowchenOut = buildOutput({ breedKey: "lowchen", rows: lowchenRows });

  fs.writeFileSync(
    path.join(dataDir, "available-bouviers.json"),
    JSON.stringify(bouviersOut, null, 2)
  );

  fs.writeFileSync(
    path.join(dataDir, "available-lowchen.json"),
    JSON.stringify(lowchenOut, null, 2)
  );

  console.log("Wrote data/available-bouviers.json and data/available-lowchen.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
