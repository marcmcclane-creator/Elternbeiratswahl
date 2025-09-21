-- Bestehende Tabellen löschen (nur wenn du ALLE Daten neu aufsetzen willst!)
DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS tokens;

-- Tabelle für Zugangstokens
CREATE TABLE tokens (
    id SERIAL PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    school TEXT NOT NULL CHECK (school IN ('gs','ms')),
    used BOOLEAN DEFAULT FALSE
);

-- Tabelle für Stimmen
CREATE TABLE votes (
    id SERIAL PRIMARY KEY,
    token TEXT NOT NULL,
    school TEXT NOT NULL CHECK (school IN ('gs','ms')),
    choice TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Optional: Kandidaten wieder einfügen (Beispielwerte)
INSERT INTO candidates (name, school) VALUES
  ('Anna Beispiel', 'gs'),
  ('Max Mustermann', 'gs'),
  ('Lena Test', 'gs'),
  ('Thomas Muster', 'ms'),
  ('Julia Beispiel', 'ms'),
  ('Markus Demo', 'ms');
