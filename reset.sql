-- Tokens zurücksetzen
DROP TABLE IF EXISTS tokens;
CREATE TABLE tokens (
  id SERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  school TEXT NOT NULL,
  used BOOLEAN DEFAULT FALSE
);

-- Stimmen zurücksetzen
DROP TABLE IF EXISTS votes;
CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL,
  choice TEXT NOT NULL,
  school TEXT NOT NULL
);

-- Kandidaten (lassen wir bestehen, sonst müsstest du sie jedes Mal neu eintragen)
CREATE TABLE IF NOT EXISTS candidates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  school TEXT NOT NULL
);
