const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");

const DAYS_TO_KEEP_CURRENT = 90;

// We store "first seen" timestamps here so the 90-day window is based on
// when the file enters your system, not the camera date and not Drive metadata.
const MANIFEST_PATH = path.join("data", "puppy-photo-manifest.json");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function daysBetweenIso(olderIso, newerIso) {
  const ms = new Date(newerIso).getTime() - new Date(olderIso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function readManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return { version: 1, firstSeen: {} };
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return { version: 1, firstSeen: {} };
  }
}

function writeManifest(manifest) {
  ensureDir(path.dirname(MANIFEST_PATH));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

async function getDriveClient() {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GDRIVE_SERVICE_ACCOUNT_JSON secret");

  const creds = JSON.parse(raw);

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken;

  while (true) {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id,name,mimeType,createdTime,modifiedTime)",
      pageSize: 1000,
      pageToken,
    });

    for (const f of res.data.files || []) {
      if (!f.mimeType) continue;
      const isImage =
        f.mimeType.startsWith("image/") ||
        /\.(jpe?g|png|webp)$/i.test(f.name || "");
      if (isImage) files.push(f);
    }

    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }

  // Keep a stable “nice” order: newest uploads/edits first based on Drive modifiedTime.
  // This is only for ordering, not for the 90-day rule.
  files.sort((a, b) => new Date(b.modifiedTime || b.createdTime) - new Date(a.modifiedTime || a.createdTime));
  return files;
}

async function downloadFile(drive, fileId, outPath) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  fs.writeFileSync(outPath, Buffer.from(res.data));
}

function safeFilename(name) {
  const base = name
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .trim();
  return base || `photo_${Date.now()}.jpg`;
}

async function syncBreed({ drive, breedKey, folderId, manifest, runNowIso }) {
  const baseDir = path.join("images", "puppies", breedKey);
  const currentDir = path.join(baseDir, "current");
  const archiveDir = path.join(baseDir, "archive");
  const dataDir = "data";

  ensureDir(currentDir);
  ensureDir(archiveDir);
  ensureDir(dataDir);

  const files = await listFilesInFolder(drive, folderId);

  manifest.firstSeen[breedKey] = manifest.firstSeen[breedKey] || {};

  const current = [];
  let archiveCount = 0;

  for (const f of files) {
    // Establish firstSeen the first time we encounter this Drive file id.
    if (!manifest.firstSeen[breedKey][f.id]) {
      manifest.firstSeen[breedKey][f.id] = runNowIso;
    }

    const firstSeenIso = manifest.firstSeen[breedKey][f.id];
    const ageDays = daysBetweenIso(firstSeenIso, runNowIso);
    const isArchive = ageDays > DAYS_TO_KEEP_CURRENT;

    const extMatch = (f.name || "").match(/\.(jpe?g|png|webp)$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : ".jpg";

    const stableName =
      `${safeFilename(path.parse(f.name || "photo").name)}_${sha1(f.id).slice(0, 10)}${ext}`;

    const destDir = isArchive ? archiveDir : currentDir;
    const destPath = path.join(destDir, stableName);

    if (!fs.existsSync(destPath)) {
      await downloadFile(drive, f.id, destPath);
    }

    const relUrl = `./${destPath.replace(/\\/g, "/")}`;

    if (isArchive) {
      archiveCount += 1;
    } else {
      current.push({
        filename: stableName,
        url: relUrl,
        driveName: f.name,
        firstSeen: firstSeenIso,
        ageDays,
      });
    }
  }

  const out = {
    breed: breedKey,
    generatedAt: runNowIso,
    keepDays: DAYS_TO_KEEP_CURRENT,
    current,
    archiveCount,
  };

  fs.writeFileSync(
    path.join(dataDir, `puppy-photos-${breedKey}.json`),
    JSON.stringify(out, null, 2)
  );

  console.log(`Synced ${breedKey}: current=${current.length}, archived=${archiveCount}`);
}

async function main() {
  const drive = await getDriveClient();

  const bouviersId = process.env.GDRIVE_BOUVIERS_FOLDER_ID;
  const lowchenId = process.env.GDRIVE_LOWCHEN_FOLDER_ID;
  if (!bouviersId || !lowchenId) throw new Error("Missing folder id secret(s)");

  const runNowIso = nowIso();
  const manifest = readManifest();

  await syncBreed({ drive, breedKey: "bouviers", folderId: bouviersId, manifest, runNowIso });
  await syncBreed({ drive, breedKey: "lowchen", folderId: lowchenId, manifest, runNowIso });

  writeManifest(manifest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
