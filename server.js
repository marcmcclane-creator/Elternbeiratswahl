const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- Startseite mit Token-Eingabe ---
app.get("/", (req, res) => {
  res.render("index");
});

// Session
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "strict"
    }
  })
);

// Kandidatenlisten für Grundschule & Mittelschule
const candidates = {
  gs: ["Anna GS", "Bernd GS", "Clara GS"],
  ms: ["David MS", "Eva MS", "Felix MS"]
};

// DB-Init
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE,
      school TEXT,
      used BOOLEAN DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      school TEXT,
      choice TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDb();

// --- Wahlseite ---
app.post("/vote", async (req, res) => {
  const { token } = req.body;
  const t = await pool.query("SELECT * FROM tokens WHERE token=$1 AND used=FALSE", [token]);

  if (t.rows.length === 0) {
return res.render("error", { message: "❌ Ungültiger oder bereits benutzter Token." });
  }

  const school = t.rows[0].school;

  // Kandidaten für die passende Schulart laden
  const candidates = await pool.query("SELECT * FROM candidates WHERE school=$1 ORDER BY name", [school]);

  res.render("vote", { token, school, candidates: candidates.rows });
});

// --- Stimme absenden ---
app.post("/submitVote", async (req, res) => {
  const { token, choice } = req.body;

  // prüfen, ob Token gültig und noch nicht benutzt
  const t = await pool.query("SELECT * FROM tokens WHERE token=$1 AND used=FALSE", [token]);
  if (t.rows.length === 0) {
    return res.send("❌ Ungültiger oder bereits benutzter Token.");
  }

  const school = t.rows[0].school;

  // Stimme speichern
  await pool.query("INSERT INTO votes (token, choice, school) VALUES ($1,$2,$3)", [token, choice, school]);

  // Token als benutzt markieren
  await pool.query("UPDATE tokens SET used=TRUE WHERE token=$1", [token]);

  // Danke-Seite anzeigen
  res.render("thankyou", { school });
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
  const results = await pool.query(
    "SELECT school, choice, COUNT(*) as count FROM votes GROUP BY school, choice ORDER BY school"
  );

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


// --- Token-Generator mit CSV-Export ---
app.get("/generateTokens/:school/:n", checkAdmin, async (req, res) => {
  const n = Math.max(1, parseInt(req.params.n));
  const school = req.params.school; // "gs" oder "ms"
  let tokens = [];
  for (let i = 0; i < n; i++) {
    const t = uuidv4();
    await pool.query(
      "INSERT INTO tokens (token, school) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [t, school]
    );
    tokens.push({ token: t });
  }

  const filePath = path.join(os.tmpdir(), `tokens-${school}.csv`);
  const csvWriter = createCsvWriter({
    path: filePath,
    header: [{ id: "token", title: "Token" }]
  });
  await csvWriter.writeRecords(tokens);

  // Download
  const filename =
    school === "gs" ? "tokens-grundschule.csv" : "tokens-mittelschule.csv";
  res.download(filePath, filename);
});



// --- CSV-Export Ergebnisse (getrennt nach GS und MS in zwei Dateien) ---
app.get("/admin/export/csv", checkAdmin, async (req, res) => {
  const results = await pool.query(
    "SELECT school, choice, COUNT(*) as count FROM votes GROUP BY school, choice ORDER BY school, choice"
  );

  // Ergebnisse trennen
  const gsResults = results.rows.filter(r => r.school === "gs");
  const msResults = results.rows.filter(r => r.school === "ms");

  const tmpDir = os.tmpdir();
  const gsFile = path.join(tmpDir, "wahlergebnisse-grundschule.csv");
  const msFile = path.join(tmpDir, "wahlergebnisse-mittelschule.csv");

  const writerGS = createCsvWriter({
    path: gsFile,
    header: [
      { id: "choice", title: "Kandidat" },
      { id: "count", title: "Stimmen" }
    ]
  });
  await writerGS.writeRecords(gsResults);

  const writerMS = createCsvWriter({
    path: msFile,
    header: [
      { id: "choice", title: "Kandidat" },
      { id: "count", title: "Stimmen" }
    ]
  });
  await writerMS.writeRecords(msResults);

  // Packe beide CSVs in eine ZIP-Datei
  const zipPath = path.join(tmpDir, "wahlergebnisse.zip");
  const archiver = require("archiver");
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");
  archive.pipe(output);
  archive.file(gsFile, { name: "wahlergebnisse-grundschule.csv" });
  archive.file(msFile, { name: "wahlergebnisse-mittelschule.csv" });
  await archive.finalize();

  output.on("close", () => {
    res.download(zipPath, "wahlergebnisse.zip");
  });
});


// --- PDF-Export Ergebnisse (getrennt nach GS und MS) ---
app.get("/admin/export/pdf", checkAdmin, async (req, res) => {
  const results = await pool.query(
    "SELECT school, choice, COUNT(*) as count FROM votes GROUP BY school, choice ORDER BY school, choice"
  );

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
  ["gs", "ms"].forEach(schoolKey => {
    const schoolName = schoolKey === "gs" ? "Grundschule" : "Mittelschule";
    const schoolResults = results.rows.filter(r => r.school === schoolKey);

    // Abschnittsüberschrift
    doc.moveDown(2);
    doc.x = 50;
    doc.fontSize(14).text(schoolName, {align: "left", underline: true });
    doc.moveDown(0.5);

    if (schoolResults.length === 0) {
      doc.fontSize(12).text("Keine Stimmen abgegeben.");
      return;
    }

    // Tabellenspalten
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

    // Tabellenzeilen
    doc.font("Helvetica");
    y += 25;
    schoolResults.forEach(r => {
      doc.rect(tableLeft, y, col1Width, 25).stroke();
      doc.rect(tableLeft + col1Width, y, col2Width, 25).stroke();
      doc.text(r.choice, tableLeft + 5, y + 7, { width: col1Width - 10, align: "left" });
      doc.text(r.count.toString(), tableLeft + col1Width, y + 7, { width: col2Width, align: "center" });
      y += 25;
    });
  });

  // Unterschriftsfeld
  doc.moveDown(5);
  doc.x = 50;
  doc.text("______________________________", { align: "left" });
  doc.x = 50;
  doc.text("Ort, Datum, Unterschrift Wahlleitung", { align: "left" });

  // PDF abschließen
  doc.end();

  // Download starten, sobald PDF fertig geschrieben ist
  stream.on("finish", () => {
    res.download(filePath, "wahlergebnisse.pdf");
  });
});


// --- Server starten ---
app.listen(PORT, () => console.log(`✅ Server läuft auf http://localhost:${PORT}`));
