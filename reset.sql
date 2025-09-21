-- ⚠️ Setzt alle Tabellen zurück: Tokens, Stimmen und Kandidaten werden gelöscht!
TRUNCATE tokens, votes, candidates RESTART IDENTITY;

-- Optional: Kandidaten wieder einfügen (Beispielwerte)
INSERT INTO candidates (name, school) VALUES
  ('Anna Beispiel', 'gs'),
  ('Max Mustermann', 'gs'),
  ('Lena Test', 'gs'),
  ('Thomas Muster', 'ms'),
  ('Julia Beispiel', 'ms'),
  ('Markus Demo', 'ms');
