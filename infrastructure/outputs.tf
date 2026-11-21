output "cloudflare_account_id" {
  value       = var.cloudflare_account_id
  description = "ID-ul contului Cloudflare (dfe48fe11d5dfc0dc30a84dab037aff9)"
}

output "database_id" {
  value       = cloudflare_d1_database.telemetry_db.id
  description = "ID-ul bazei de date folosit în wrangler.toml (39ed8046-a6ba-440f-9b3f-0585373a0750)"
}

output "database_name" {
  value       = cloudflare_d1_database.telemetry_db.name
  description = "Numele bazei de date D1 (pero_diodele)"
}

output "backend_worker_name" {
  value       = cloudflare_workers_script.telemetry_worker.name
  description = "Numele worker-ului Cloudflare de backend (datainfrastructure-diodele)"
}

output "backend_worker_url" {
  value       = "https://${var.backend_worker_name}.cristianstefanpopa05.workers.dev"
  description = "URL-ul worker-ului Cloudflare de backend"
}

output "dashboard_worker_name" {
  value       = cloudflare_pages_project.dashboard_pages.name
  description = "Numele worker-ului / proiectului Cloudflare pentru dashboard (datainfrastructure-diodele12)"
}

output "dashboard_worker_url" {
  value       = "https://${var.dashboard_worker_name}.cristianstefanpopa05.workers.dev"
  description = "URL-ul dashboard-ului Cloudflare"
}
