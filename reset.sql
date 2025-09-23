-- 🗑️ Bestehende Tabellen löschen
DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS candidates;

-- 📋 Tabellen neu anlegen
CREATE TABLE tokens (
  id SERIAL PRIMARY KEY,
  token TEXT UNIQUE,
  school TEXT,
  used BOOLEAN DEFAULT FALSE
);

CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  token TEXT,
  school TEXT,
  choice TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE candidates (
  id SERIAL PRIMARY KEY,
  school TEXT,
  name TEXT
);

-- 👥 Kandidaten einfügen
INSERT INTO candidates (school, name) VALUES
('gs', 'Anna Beispiel'),
('gs', 'Bernd Muster'),
('gs', 'Clara Test'),
('gs', 'David Demo'),
('ms', 'Eva Beispiel'),
('ms', 'Felix Modell'),
('ms', 'Gina Test'),
('ms', 'Hans Mustermann');
