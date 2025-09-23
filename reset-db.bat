@echo off
setlocal

REM Lies Variablen aus der .env-Datei ein
for /f "tokens=1,2 delims== eol=#" %%a in (.env) do (
    set %%a=%%b
)

REM Sicherstellen, dass DATABASE_URL gesetzt wurde
if "%DATABASE_URL%"=="" (
    echo ❌ Keine DATABASE_URL gefunden. Bitte prüfe deine .env-Datei.
    exit /b 1
)

REM Reset der Datenbank mit psql
docker run --rm -i postgres psql "%DATABASE_URL%" < reset.sql

endlocal
pause
