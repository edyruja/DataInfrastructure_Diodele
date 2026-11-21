output "cloudflare_account_id" {
  value       = var.cloudflare_account_id
  description = "ID-ul contului Cloudflare"
}

output "database_id" {
  value       = cloudflare_d1_database.telemetry_db.id
  description = "ID-ul bazei de date D1 conectate la backend"
}

output "database_name" {
  value       = cloudflare_d1_database.telemetry_db.name
  description = "Numele bazei de date D1"
}

output "backend_worker_name" {
  value       = cloudflare_workers_script.telemetry_worker.script_name
  description = "Numele Worker-ului de telemetrie"
}

output "backend_worker_url" {
  value       = "https://${cloudflare_workers_script_subdomain.telemetry_worker.script_name}.${var.workers_dev_subdomain}.workers.dev"
  description = "URL-ul Worker-ului de telemetrie"
}

output "telemetry_queue_id" {
  value       = cloudflare_queue.telemetry_queue.id
  description = "ID-ul cozii Cloudflare pentru telemetrie"
}

output "telemetry_queue_name" {
  value       = cloudflare_queue.telemetry_queue.queue_name
  description = "Numele cozii conectate la TELEMETRY_QUEUE"
}

output "dashboard_worker_name" {
  value       = cloudflare_workers_script.dashboard.script_name
  description = "Numele Worker-ului care publică dashboard-ul"
}

output "dashboard_worker_url" {
  value       = "https://${cloudflare_workers_script_subdomain.dashboard.script_name}.${var.workers_dev_subdomain}.workers.dev"
  description = "URL-ul dashboard-ului Cloudflare"
}
