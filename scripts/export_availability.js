/**
 * Export Availability from Google Sheets tabs (by GID) into JSON files in /data
 * Also downloads per-row PhotoId images from Google Drive into the repo for
 * original quality display on GitHub Pages.
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
 *
 * Images:
 *  - assets/available-photos/<PhotoId>.<ext>
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

function sanitizeDriveId(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";

  // If user pasted a full drive link, extract /file/d/<id>/
  const m1 = v.match(/\/file\/d\/([^/]+)/);
  if (m1 && m1[1]) return m1[1];

  // If user pasted something with id=<id>
  const m2 = v.match(/[?&]id=([^&]+)/);
  if (m2 && m2[1]) return m2[1];

  // Otherwise assume it is already an id
  return v;
}

function extFromMime(mimeType) {
  const mt = String(mimeType || "").toLowerCase();
  if (mt === "image/jpeg") return "jpg";
  if (mt === "image/png") return "png";
  if (mt === "image/webp") return "webp";
  if (mt === "image/gif") return "gif";
  if (mt === "image/heic" || mt === "image/heif") return "heic";
  return "";
}

function extFromName(name) {
  const base = String(name || "").trim();
  const ext = path.extname(base).replace(".", "").toLowerCase();
  return ext || "";
}

async function getGoogleClients() {
  const raw = getEnv("GDRIVE_SERVICE_ACCOUNT_JSON");
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
  const drive = google.drive({ version: "v3", auth });

  return { sheets, drive, serviceAccountEmail: creds.client_email };
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

async function downloadDriveImageToRepo(drive, fileId, destDir) {
  ensureDir(destDir);

  // Get metadata to determine filename/extension
  const metaRes = await drive.files.get({
    fileId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });

  const name = metaRes?.data?.name || fileId;
  const mimeType = metaRes?.data?.mimeType || "";

  let ext = extFromName(name) || extFromMime(mimeType) || "jpg";
  // Guard against weird "name" like "photo" without extension and unknown mime
  if (!ext) ext = "jpg";

  const outName = `${fileId}.${ext}`;
  const outPath = path.join(destDir, outName);

  // Skip re-downloading if already exists
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return { outPath, outName, ext };
  }

  // Download original bytes
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    res.data
      .on("end", resolve)
      .on("error", reject)
      .pipe(ws)
      .on("error", reject);
  });

  return { outPath, outName, ext };
}

async function buildAvailability({ drive, headers, rows, breedKey }) {
  // Expected columns:
  // Available? | Litter | DOB | Collar color | Sex | Coat Color | PhotoId | Photo (optional fallback)
  const idxAvail = findHeaderIndex(headers, ["Available?", "Available", "Available ?"]);
  const idxLitter = findHeaderIndex(headers, ["Litter"]);
  const idxDob = findHeaderIndex(headers, ["DOB", "Date of Birth"]);
  const idxCollar = findHeaderIndex(headers, ["Collar color", "Collar Color", "Collar"]);
  const idxSex = findHeaderIndex(headers, ["Sex"]);
  const idxCoat = findHeaderIndex(headers, ["Coat Color", "Coat colour", "Coat"]);

  // New: PhotoId
  const idxPhotoId = findHeaderIndex(headers, ["PhotoId", "Photo ID", "Photo Id", "DriveId", "Drive ID"]);

  // Optional fallback: Photo URL column (if you keep it)
  const idxPhoto = findHeaderIndex(headers, ["Photo", "Photo URL", "Image", "Image URL"]);

  const available = [];

  // Where we store downloaded images in the repo
  const repoImageDir = path.join("assets", "available-photos");

  for (const r of rows) {
    const isAvail = idxAvail >= 0 ? truthyCheckbox(r[idxAvail]) : false;
    if (!isAvail) continue;

    // Prefer PhotoId
    let photoId = idxPhotoId >= 0 ? sanitizeDriveId(r[idxPhotoId]) : "";

    // If no PhotoId, allow fallback to a URL already in Photo (optional)
    let photo = idxPhoto >= 0 ? String(r[idxPhoto] || "").trim() : "";

    // If PhotoId present, download and set photo to the repo path
    if (photoId) {
      try {
        const dl = await downloadDriveImageToRepo(drive, photoId, repoImageDir);
        // This path is what your site should use. Keep it relative for GitHub Pages.
        photo = `assets/available-photos/${dl.outName}`;
      } catch (err) {
        console.error(`Photo download failed for PhotoId=${photoId}:`, err?.message || err);
        // If download fails, leave photo as whatever was in the Photo column (if any)
      }
    }

    available.push({
      litter: idxLitter >= 0 ? (r[idxLitter] || "") : "",
      dob: idxDob >= 0 ? (r[idxDob] || "") : "",
      collarColor: idxCollar >= 0 ? (r[idxCollar] || "") : "",
      sex: idxSex >= 0 ? (r[idxSex] || "") : "",
      coatColor: idxCoat >= 0 ? (r[idxCoat] || "") : "",
      photoId: photoId || "",
      photo: photo || "",
    });
  }

  return {
    breed: breedKey,
    generatedAt: new Date().toISOString(),
    availableCount: available.length,
    available,
  };
}

async function exportOne({ sheets, drive, spreadsheetId, gid, breedKey, outFile }) {
  const tabTitle = await gidToSheetTitle(sheets, spreadsheetId, gid);
  const { headers, rows } = await fetchTabRows(sheets, spreadsheetId, tabTitle);

  const out = await buildAvailability({ drive, headers, rows, breedKey });

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

  const { sheets, drive, serviceAccountEmail } = await getGoogleClients();

  console.log(`Service account in use: ${serviceAccountEmail}`);
  console.log(`Images will be written to: assets/available-photos/`);

  await exportOne({
    sheets,
    drive,
    spreadsheetId: sheetId,
    gid: bouviersGid,
    breedKey: "bouviers",
    outFile: "available-bouviers.json",
  });

  await exportOne({
    sheets,
    drive,
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
