@echo off
echo Starte Reset der Render-Datenbank...
docker run --rm -i postgres psql "postgresql://elternbeiratswahl_db_user:REMOVED_SECRET@dpg-d3849uhr0fns73fedipg-a.frankfurt-postgres.render.com/elternbeiratswahl_db" < reset.sql
echo Fertig! Datenbank wurde zurückgesetzt.
pause
