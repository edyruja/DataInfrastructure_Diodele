variable "cloudflare_account_id" {
  description = "ID-ul contului Cloudflare (Account ID din dashboard)"
  type        = string
  default     = "dfe48fe11d5dfc0dc30a84dab037aff9"
}

variable "cloudflare_api_token" {
  description = "Token Cloudflare cu permisiuni D1 Edit, Workers Scripts Edit și Queues Edit. Providerul poate citi și CLOUDFLARE_API_TOKEN."
  type        = string
  sensitive   = true
  default     = null
}

variable "d1_database_name" {
  description = "Numele bazei de date Cloudflare D1"
  type        = string
  default     = "pero_diodele"
}

variable "backend_worker_name" {
  description = "Numele worker-ului Cloudflare de backend (Telemetrie F1)"
  type        = string
  default     = "datainfrastructure-diodele"
}

variable "dashboard_worker_name" {
  description = "Numele Cloudflare Worker-ului care publică dashboard-ul"
  type        = string
  default     = "datainfrastructure-diodele12"
}

variable "workers_dev_subdomain" {
  description = "Subdomeniul workers.dev înregistrat pentru contul Cloudflare"
  type        = string
  default     = "cristianstefanpopa05"
}

variable "telemetry_queue_name" {
  description = "Numele cozii Cloudflare pentru mesajele de telemetrie"
  type        = string
  default     = "telemetry-queue"
}

variable "manage_queue_consumer" {
  description = "Creează consumatorul cozii în Terraform. Pentru un consumator existent gestionat din Wrangler, setează false."
  type        = bool
  default     = true
}

variable "migrate_legacy_telemetry_hub" {
  description = "Aplică migrarea TelemetryHub de la v1 la v2 pentru un Worker existent aflat la v1"
  type        = bool
  default     = false
}
