const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const { Pool } = require("pg");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { createObjectCsvWriter: createCsvWriter } = require("csv-writer");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PORT = process.env.PORT || 3000;
// Gut lesbares Alphabet (ohne 0, O, 1, I, L)
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // Länge 32

function makeToken(len = 8) {
  const bytes = crypto.randomBytes(len);
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
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- Startseite mit Token-Eingabe ---
app.get("/", (req, res) => {
  res.render("index");
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
  CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    token TEXT,
    school TEXT,
    choice TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    candidates: candidates.rows
  });
});

// --- Vote einreichen ---
app.post("/submitVote", async (req, res) => {
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

    // Danke-Seite mit Liste der gewählten Kandidaten
    res.render("thankyou", { choices });
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
    return res.download(files[0].path, files[0].name);
  }

  // Wenn beide Dateien existieren → als ZIP bündeln
  const archiver = require("archiver");
  const zipPath = path.join(os.tmpdir(), "tokens.zip");
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");

  archive.pipe(output);
  files.forEach(f => archive.file(f.path, { name: f.name }));
  await archive.finalize();

  output.on("close", () => {
    res.download(zipPath, "tokens.zip");
  });
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

// --- Datenschutz-Seite ---
app.get("/datenschutz", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "datenschutz.html"));
});

// --- Server starten ---
app.listen(PORT, () => console.log(`✅ Server läuft auf http://localhost:${PORT}`));
