output "database_id" {
  value       = cloudflare_d1_database.telemetry_db.id
  description = "ID-ul bazei de date folosit în wrangler.toml (39ed8046-a6ba-440f-9b3f-0585373a0750)"
}

output "database_name" {
  value       = cloudflare_d1_database.telemetry_db.name
  description = "Numele bazei de date D1 (pero_diodele)"
}
