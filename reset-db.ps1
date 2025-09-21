Write-Host "🔄 Datenbank wird zurückgesetzt..."

# reset.sql in den Container schicken und ausführen
Get-Content reset.sql | docker exec -i elternwahl-pg psql -U user -d elternwahl

Write-Host "✅ Datenbank wurde neu angelegt!"
