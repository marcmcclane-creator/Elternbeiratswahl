// --- Wahlzeitraum (Start/Ende aus ENV) ---
const VOTING_START = process.env.VOTING_START ? new Date(process.env.VOTING_START) : null;
const VOTING_END   = process.env.VOTING_END   ? new Date(process.env.VOTING_END)   : null;

// hübsches deutsches Datum (Berlin)
function fmtDT(d) {
  if (!d) return "-";
  return d.toLocaleString("de-DE", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  });
}

// aktueller Status: pre | open | post
function votingStatus() {
  const now = new Date();
  if (VOTING_START && now < VOTING_START) return { state: "pre",  startsAt: VOTING_START, endsAt: VOTING_END };
  if (VOTING_END   && now > VOTING_END)   return { state: "post", startsAt: VOTING_START, endsAt: VOTING_END };
  return { state: "open", startsAt: VOTING_START, endsAt: VOTING_END };
}

// Middleware: Wahl muss offen sein
function requireVotingOpen(req, res, next) {
  const vs = votingStatus();
  if (vs.state !== "open") {
    const msg = vs.state === "pre"
      ? `Die Wahl hat noch nicht begonnen. Start: ${fmtDT(vs.startsAt)}`
      : `Die Wahl ist bereits beendet. Ende: ${fmtDT(vs.endsAt)}`;
    // Du hast bereits eine error.ejs – die können wir nutzen:
    return res.status(403).render("error", { message: msg });
  }
  next();
}

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const { Pool } = require("pg");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { createObjectCsvWriter: createCsvWriter } = require("csv-writer");
const os = require("os");
const path = require("path");
const { createHash, createHmac, randomBytes, randomUUID } = require("crypto");
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // Länge 32
const archiver = require("archiver");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PORT = process.env.PORT || 3000;


function makeToken(len = 8) {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    const idx = bytes[i] % ALPHABET.length; // immer zwischen 0 und 31
    out += ALPHABET[idx];
  }
  return out;
}

// Konfig (Passwort und Geheimnis setzt du später bei Render als Environment Variablen)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test123";
const SESSION_SECRET = process.env.SESSION_SECRET || "fallbackSecret";

// DB-Verbindung (Render liefert DATABASE_URL später automatisch)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/elternwahl",
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

// Views & Parser
app.set("view engine", "ejs");
app.use(express.static("public"));

// --- Startseite mit Token-Eingabe ---
app.get("/", (req, res) => {
  const vs = votingStatus();
  res.render("index", { voting: vs, fmtDT }); // fmtDT optional in der View
});

// Session
app.set("trust proxy", 1); // Render läuft hinter Proxy
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true, // wichtig mit trust proxy
  cookie: {
    secure: true,       // nur über HTTPS
    httpOnly: true,     // kein Zugriff per JS
    sameSite: "lax"     // erlaubt Redirects
  }
}));

// Kandidatenlisten für Grundschule & Mittelschule
const candidates = {
  gs: ["Anna GS", "Bernd GS", "Clara GS"],
  ms: ["David MS", "Eva MS", "Felix MS"]
};

// DB-Init
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      school TEXT NOT NULL CHECK (school IN ('gs','ms')),
      used BOOLEAN DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      school TEXT NOT NULL CHECK (school IN ('gs','ms')),
      name TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL,
      school TEXT NOT NULL CHECK (school IN ('gs','ms')),
      choice TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // -- Audit-Tabellen:
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vote_audit (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL,
      school TEXT NOT NULL,
      choices TEXT[] NOT NULL,
      choice_count INT NOT NULL,
      submitted_at TIMESTAMP NOT NULL,
      user_agent TEXT,
      ip_hash TEXT,
      request_id TEXT NOT NULL,
      hmac TEXT NOT NULL,
      chain_prev_hash TEXT,
      chain_hash TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      meta JSONB DEFAULT '{}'::jsonb,
      at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDb();

// --- Wahlseite ---
app.post("/vote", requireVotingOpen, async (req, res) => {
  // Token bereinigen: Trim + Uppercase
  const cleaned = (req.body.token || "").toString().trim().toUpperCase();

  // In DB nach Token suchen (nur unbenutzt)
  const t = await pool.query(
    "SELECT * FROM tokens WHERE token=$1 AND used=FALSE",
    [cleaned]
  );

  if (t.rows.length === 0) {
    return res.render("error", {
      message: "❌ Ungültiger oder bereits benutzter Token."
    });
  }

  const school = t.rows[0].school;

  // Kandidaten für die passende Schulart laden
  const candidates = await pool.query(
    "SELECT * FROM candidates WHERE school=$1 ORDER BY name",
    [school]
  );

 // Wichtig: das bereinigte Token an die View weitergeben
res.render("vote", {
  token: cleaned,
  school,
  candidates: candidates.rows,
  voting: votingStatus(),
  fmtDT
});
});


// --- Vote einreichen ---
app.post("/submitVote", requireVotingOpen, async (req, res) => {

  const cleaned = (req.body.token || "").toString().trim().toUpperCase();

  // Choices sauber als Array aufbereiten
  const rawChoices = req.body.choices;
  const choices = Array.isArray(rawChoices) ? rawChoices : (rawChoices ? [rawChoices] : []);

  try {
    await pool.query("BEGIN");

    // Token prüfen
    const t = await pool.query(
      "SELECT * FROM tokens WHERE token=$1 AND used=FALSE",
      [cleaned]
    );

    if (t.rows.length === 0) {
      await pool.query("ROLLBACK");
      return res.render("error", { message: "❌ Ungültiger oder benutzter Token." });
    }

    const school = t.rows[0].school;
    const maxVotes = school === "gs" ? 12 : 7;

    // Stimmenanzahl prüfen
    if (choices.length === 0 || choices.length > maxVotes) {
      await pool.query("ROLLBACK");
      return res.render("error", { 
        message: `❌ Es dürfen zwischen 1 und ${maxVotes} Stimmen abgegeben werden.` 
      });
    }

    // Stimmen speichern
    for (const choice of choices) {
      await pool.query(
        "INSERT INTO votes (token, school, choice) VALUES ($1,$2,$3)",
        [cleaned, school, choice]
      );
    }

    // Token als benutzt markieren
    await pool.query("UPDATE tokens SET used=TRUE WHERE token=$1", [cleaned]);

    await pool.query("COMMIT");

// --- Audit-Logging ---
const request_id = randomUUID();
const submitted_at = new Date();
const user_agent = req.headers["user-agent"] || null;
const ip_hash = ipToMasked(req);

const row = {
  token: cleaned,
  school,
  choices,
  choice_count: choices.length,
  submitted_at,
  user_agent,
  ip_hash,
  request_id,
  hmac: signAudit({ token: cleaned, school, choices, submitted_at, request_id })
};

await appendVoteAudit(pool, row);



    // Danke-Seite mit Liste der gewählten Kandidaten
    res.render("thankyou", { choices, school });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Fehler bei /submitVote:", err);
    res.render("error", { message: "❌ Fehler beim Speichern der Stimmen." });
  }
});

// --- Admin Auth ---
app.get("/admin/login", (req, res) => res.render("admin_login"));
app.post("/admin/login", (req, res) => {
  console.log("DEBUG Admin Login:", req.body); // <--- Debug
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }
  res.send("❌ Falsches Passwort.");
});

function checkAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.redirect("/admin/login");
}

// --- Admin Übersicht ---
app.get("/admin", checkAdmin, async (req, res) => {
  const results = await pool.query(`
  SELECT school, choice, COUNT(*)::int AS count
  FROM votes
  GROUP BY school, choice
  ORDER BY school, choice
`);


  const totalVotes = (await pool.query("SELECT COUNT(*) as c FROM votes")).rows[0].c;
  const usedTokens = (await pool.query("SELECT COUNT(*) as c FROM tokens WHERE used = TRUE")).rows[0].c;
  const totalTokens = (await pool.query("SELECT COUNT(*) as c FROM tokens")).rows[0].c;

  // Neu: Tokens getrennt nach Schulart
  const usedTokensGS = (await pool.query("SELECT COUNT(*) as c FROM tokens WHERE school='gs' AND used=TRUE")).rows[0].c;
  const totalTokensGS = (await pool.query("SELECT COUNT(*) as c FROM tokens WHERE school='gs'")).rows[0].c;
  const usedTokensMS = (await pool.query("SELECT COUNT(*) as c FROM tokens WHERE school='ms' AND used=TRUE")).rows[0].c;
  const totalTokensMS = (await pool.query("SELECT COUNT(*) as c FROM tokens WHERE school='ms'")).rows[0].c;

  res.render("admin", { 
    results: results.rows, 
    totalVotes, 
    usedTokens, 
    totalTokens,
    usedTokensGS, totalTokensGS,
    usedTokensMS, totalTokensMS
  });
});

// --- Audit-Hilfsfunktionen ---
function ipToMasked(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString();
  const ip = xf.split(",")[0].trim() || (req.ip || "").toString();
  if (!ip) return null;

  if (process.env.AUDIT_HASH_IP === "1") {
    const salt = process.env.AUDIT_SALT || "change-me";
    return createHash("sha256").update(ip + salt).digest("hex");
  }
  // Fallback: IPv4 /24-Maskierung
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : null;
}

function signAudit({ token, school, choices, submitted_at, request_id }) {
  const key = process.env.AUDIT_HMAC_KEY || "dev-key-change-me";
  const payload = [
    token,
    school,
    [...choices].sort().join("|"),
    submitted_at.toISOString(),
    request_id
  ].join("|");
  return createHmac("sha256", key).update(payload).digest("hex");
}

async function appendVoteAudit(pool, row) {
  const prev = await pool.query("SELECT chain_hash FROM vote_audit ORDER BY id DESC LIMIT 1");
  const chain_prev_hash = prev.rows[0]?.chain_hash || "";

  const canonical = JSON.stringify({
    token: row.token,
    school: row.school,
    choices: [...row.choices].sort(),
    choice_count: row.choice_count,
    submitted_at: row.submitted_at.toISOString(),
    user_agent: row.user_agent || null,
    ip_hash: row.ip_hash || null,
    request_id: row.request_id,
    hmac: row.hmac,
    chain_prev_hash
  });

  const chain_hash = createHash("sha256").update(canonical).digest("hex");

  await pool.query(
    `INSERT INTO vote_audit
      (token, school, choices, choice_count, submitted_at, user_agent, ip_hash, request_id, hmac, chain_prev_hash, chain_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.token, row.school, row.choices, row.choice_count,
      row.submitted_at, row.user_agent, row.ip_hash,
      row.request_id, row.hmac, chain_prev_hash, chain_hash
    ]
  );
}

async function logAdmin(pool, action, meta = {}) {
  await pool.query(
    "INSERT INTO admin_audit (action, meta) VALUES ($1, $2)",
    [action, meta]
  );
}

// --- Token-Generator mit CSV-Export (robust, Uppercase, Retry bei Kollision) ---
app.get("/generateTokens/:school", checkAdmin, async (req, res) => {
  try {
    const school = (req.params.school || "").toLowerCase();
    if (!["gs", "ms"].includes(school)) {
      return res.status(400).send("❌ Ungültige Schulart (erwartet: gs oder ms).");
    }

    const n = Math.max(1, parseInt(req.query.n || "1", 10));
    const tokens = [];

    for (let i = 0; i < n; i++) {
      let ok = false;
      for (let tries = 0; tries < 8; tries++) {
        const t = makeToken(8); // bereits Großbuchstaben
        try {
          await pool.query(
            "INSERT INTO tokens (token, school) VALUES ($1,$2)",
            [t, school]
          );
          tokens.push({ token: t });
          ok = true;
          break;
        } catch (e) {
          // 23505 = unique_violation in Postgres -> nochmal versuchen
          if (e && e.code === "23505") continue;
          console.error("Insert-Fehler bei Token:", e);
          return res.status(500).send("❌ Fehler beim Erzeugen der Tokens.");
        }
      }
      if (!ok) {
        console.error("Konnte nach 8 Versuchen keinen eindeutigen Token erzeugen.");
        return res.status(500).send("❌ Konnte eindeutigen Token nicht erzeugen.");
      }
    }

  // CSV schreiben
const filePath = path.join(os.tmpdir(), `tokens-${school}.csv`);
const csvWriter = createCsvWriter({
  path: filePath,
  header: [{ id: "token", title: "Token" }]
});
await csvWriter.writeRecords(tokens);

const filename = school === "gs" ? "tokens-grundschule.csv" : "tokens-mittelschule.csv";
await logAdmin(pool, "TOKENS_GENERATED", { count: tokens.length, school });
return res.download(filePath, filename);

  } catch (err) {
    console.error("Unbekannter Fehler /generateTokens:", err);
    return res.status(500).send("❌ Interner Fehler bei der Token-Erzeugung.");
  }
});




// --- CSV-Export aller Tokens, getrennt nach GS und MS ---
app.get("/admin/export/tokens", checkAdmin, async (req, res) => {
  const results = await pool.query(
    "SELECT token, school, used FROM tokens ORDER BY school, token"
  );

  // Tokens bereinigen: uppercase
  const mapped = results.rows.map(r => ({
    token: r.token.toUpperCase(),
    school: r.school === "gs" ? "Grundschule" : "Mittelschule",
    used: r.used ? "Ja" : "Nein"
  }));

  // Aufteilen nach Schulart
  const grundschule = mapped.filter(r => r.school === "Grundschule");
  const mittelschule = mapped.filter(r => r.school === "Mittelschule");

  // Funktion für CSV schreiben
  async function writeCsv(records, filename) {
    if (records.length === 0) return null;

    const filePath = path.join(os.tmpdir(), filename);
    const csvWriter = createCsvWriter({
      path: filePath,
      header: [
        { id: "token", title: "Token" },
        { id: "school", title: "Schulart" },
        { id: "used", title: "Verwendet" }
      ]
    });
    await csvWriter.writeRecords(records);
    return filePath;
  }

  // Zwei Dateien erzeugen
  const files = [];
  const gsFile = await writeCsv(grundschule, "tokens-grundschule.csv");
  if (gsFile) files.push({ path: gsFile, name: "tokens-grundschule.csv" });

  const msFile = await writeCsv(mittelschule, "tokens-mittelschule.csv");
  if (msFile) files.push({ path: msFile, name: "tokens-mittelschule.csv" });

  // Wenn beide leer → Fehlermeldung
  if (files.length === 0) {
    return res.render("error", { message: "❌ Keine Tokens vorhanden." });
  }

  // Wenn nur eine Datei → direkt Download
  if (files.length === 1) {
  await logAdmin(pool, "TOKENS_EXPORTED_CSV", {
  schools: [files[0].name.includes("grundschule") ? "gs" : "ms"]
  }); 
  return res.download(files[0].path, files[0].name);
  }

  // Wenn beide Dateien existieren → als ZIP bündeln
  const zipPath = path.join(os.tmpdir(), "tokens.zip");
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");

  archive.pipe(output);
  files.forEach(f => archive.file(f.path, { name: f.name }));
  output.on("close", () => {
    res.download(zipPath, "tokens.zip");
  });
await logAdmin(pool, "TOKENS_EXPORTED_CSV", { schools: ["gs", "ms"] });
await archive.finalize();
});

// --- CSV-Export Ergebnisse (getrennt nach GS und MS in zwei Dateien) ---
app.get("/admin/export/csv", checkAdmin, async (req, res) => {
  const results = await pool.query(`
    SELECT school, choice, COUNT(*)::int AS count
    FROM votes
    GROUP BY school, choice
    ORDER BY school, choice
  `);

  const gsResults = results.rows.filter(r => r.school === "gs");
  const msResults = results.rows.filter(r => r.school === "ms");

  if (gsResults.length === 0 && msResults.length === 0) {
    return res.render("error", { message: "❌ Keine Stimmen vorhanden." });
  }

  const tmpDir = os.tmpdir();
  const files = [];

  async function writeCsv(data, filename) {
    const filePath = path.join(tmpDir, filename);
    const writer = createCsvWriter({
      path: filePath,
      header: [
        { id: "choice", title: "Kandidat" },
        { id: "count", title: "Stimmen" }
      ]
    });
    await writer.writeRecords(data.map(r => ({ choice: r.choice, count: r.count })));
    return filePath;
  }

  if (gsResults.length > 0) {
    files.push({ path: await writeCsv(gsResults, "wahlergebnisse-grundschule.csv"), name: "wahlergebnisse-grundschule.csv" });
  }
  if (msResults.length > 0) {
    files.push({ path: await writeCsv(msResults, "wahlergebnisse-mittelschule.csv"), name: "wahlergebnisse-mittelschule.csv" });
  }

  // ZIP erstellen
  const zipPath = path.join(tmpDir, "wahlergebnisse.zip");
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");

  output.on("close", () => res.download(zipPath, "wahlergebnisse.zip"));

  archive.pipe(output);
  files.forEach(f => archive.file(f.path, { name: f.name }));
await logAdmin(pool, "RESULTS_EXPORTED_CSV", { schools: ["gs", "ms"] });
  archive.finalize();
});

// --- PDF-Export Ergebnisse (getrennt nach GS und MS) ---
app.get("/admin/export/pdf", checkAdmin, async (req, res) => {
  const results = await pool.query(`
    SELECT school, choice, COUNT(*)::int AS count
    FROM votes
    GROUP BY school, choice
    ORDER BY school, choice
  `);

  const filePath = path.join(os.tmpdir(), "wahlergebnisse.pdf");
  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Kopfzeile
  doc.fontSize(14).text("Elternbeiratswahl 2025", 50, 50);
  try {
    doc.image("public/logo.png", 400, 30, { fit: [150, 80] });
  } catch (e) {
    console.error("Logo konnte nicht geladen werden:", e.message);
  }
  doc.moveDown(5);

  // Datum
  const today = new Date().toLocaleDateString("de-DE", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  doc.fontSize(12).text(`Druckdatum: ${today}`, { align: "right" });
  doc.moveDown(2);

  // Ergebnisse je Schulart
 ["gs", "ms"].forEach((schoolKey, index) => {
  const schoolName = schoolKey === "gs" ? "Grundschule" : "Mittelschule";
  const schoolResults = results.rows.filter(r => r.school === schoolKey);

  // Nur bei Mittelschule → neue Seite (Grundschule bleibt auf der ersten Seite)
  if (index === 1) doc.addPage();

  doc.fontSize(14).text(schoolName, { align: "left", underline: true });
  doc.moveDown(0.5);

  if (schoolResults.length === 0) {
    doc.fontSize(12).text("Keine Stimmen abgegeben.");
    return;
  }

  const tableLeft = 50;
  const col1Width = 300;
  const col2Width = 150;
  let y = doc.y;

  // Tabellenkopf
  doc.rect(tableLeft, y, col1Width, 25).stroke();
  doc.rect(tableLeft + col1Width, y, col2Width, 25).stroke();
  doc.font("Helvetica-Bold");
  doc.text("Kandidat", tableLeft, y + 7, { width: col1Width, align: "center" });
  doc.text("Stimmen", tableLeft + col1Width, y + 7, { width: col2Width, align: "center" });

  doc.font("Helvetica");
  y += 25;

  schoolResults.forEach(r => {
    if (y > 750) { // Seitenumbruch bei Überlauf
      doc.addPage();
      y = 50;
    }
    doc.rect(tableLeft, y, col1Width, 25).stroke();
    doc.rect(tableLeft + col1Width, y, col2Width, 25).stroke();
    doc.text(r.choice, tableLeft + 5, y + 7, { width: col1Width - 10, align: "left" });
    doc.text(r.count.toString(), tableLeft + col1Width, y + 7, { width: col2Width, align: "center" });
    y += 25;
  });
});

// Unterschriftsfeld direkt nach der letzten Tabelle, nicht auf neuer Seite
doc.moveDown(5);
doc.fontSize(12);
doc.text("______________________________", 50, doc.y);
doc.moveDown(0.5);
doc.text("Ort, Datum, Unterschrift Wahlleitung", 50, doc.y);

await logAdmin(pool, "RESULTS_EXPORTED_PDF", { schools: ["gs", "ms"] });
  doc.end();

  stream.on("finish", () => {
    res.download(filePath, "wahlergebnisse.pdf");
  });
});

// --- Datenschutz-Seite ---
app.get("/datenschutz", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "datenschutz.html"));
});

// --- Impressum-Seite ---
app.get("/impressum", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "impressum.html"));
});

// --- Audit-Export als ZIP ---
app.get("/admin/export/audit", checkAdmin, async (req, res) => {
  const tmp = os.tmpdir();
  const voteCsv = path.join(tmp, "vote_audit.csv");
  const adminCsv = path.join(tmp, "admin_audit.csv");
  const zipPath = path.join(tmp, "audit_bundle.zip");

  const voteRows = (await pool.query(`
    SELECT id, token, school, choices, choice_count, submitted_at, user_agent, ip_hash, request_id, hmac, chain_prev_hash, chain_hash
    FROM vote_audit ORDER BY id
  `)).rows;

  const writerVote = createCsvWriter({
    path: voteCsv,
    header: [
      {id:"id", title:"id"},
      {id:"token", title:"token"},
      {id:"school", title:"school"},
      {id:"choices", title:"choices"},
      {id:"choice_count", title:"choice_count"},
      {id:"submitted_at", title:"submitted_at"},
      {id:"user_agent", title:"user_agent"},
      {id:"ip_hash", title:"ip_hash"},
      {id:"request_id", title:"request_id"},
      {id:"hmac", title:"hmac"},
      {id:"chain_prev_hash", title:"chain_prev_hash"},
      {id:"chain_hash", title:"chain_hash"}
    ]
  });
  await writerVote.writeRecords(voteRows.map(r => ({ ...r, choices: JSON.stringify(r.choices) })));

  const adminRows = (await pool.query(`SELECT id, action, meta, at FROM admin_audit ORDER BY id`)).rows;
  const writerAdmin = createCsvWriter({
    path: adminCsv,
    header: [
      {id:"id", title:"id"},
      {id:"action", title:"action"},
      {id:"meta", title:"meta"},
      {id:"at", title:"at"}
    ]
  });
  await writerAdmin.writeRecords(adminRows.map(r => ({ ...r, meta: JSON.stringify(r.meta) })));

  const versionPath = path.join(tmp, "VERSION.txt");
  const commit = process.env.RENDER_GIT_COMMIT || process.env.COMMIT || "unknown";
  fs.writeFileSync(versionPath, `commit=${commit}\nexported_at=${new Date().toISOString()}\n`);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");
  archive.pipe(output);
  archive.file(voteCsv, { name: "vote_audit.csv" });
  archive.file(adminCsv, { name: "admin_audit.csv" });
  archive.file(versionPath, { name: "VERSION.txt" });

  // Download-Listener VOR finalize registrieren
  output.on("close", () => res.download(zipPath, "audit_bundle.zip"));

  // Admin-Log VOR finalize
  await logAdmin(pool, "AUDIT_EXPORTED_ZIP", { user: "admin" });

  await archive.finalize();
});

// --- Server starten ---
app.listen(PORT, () => console.log(`✅ Server läuft auf http://localhost:${PORT}`));
