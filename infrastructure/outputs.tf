output "database_id" {
  value       = cloudflare_d1_database.telemetry_db.id
  description = "ID-ul bazei de date folosit în wrangler.toml (39ed8046-a6ba-440f-9b3f-0585373a0750)"
}

output "database_name" {
  value       = cloudflare_d1_database.telemetry_db.name
  description = "Numele bazei de date D1 (pero_diodele)"
}

output "telemetry_worker_name" {
  value       = cloudflare_workers_script.telemetry_worker.name
  description = "Numele worker-ului Cloudflare de telemetrie (telemetry-worker)"
}

output "dashboard_name" {
  value       = cloudflare_pages_project.dashboard_pages.name
  description = "Numele proiectului Cloudflare Pages pentru dashboard (diodele-dashboard)"
}

output "dashboard_subdomain" {
  value       = cloudflare_pages_project.dashboard_pages.subdomain
  description = "Subdomeniul automat generat de Cloudflare Pages (ex: diodele-dashboard.pages.dev)"
}
