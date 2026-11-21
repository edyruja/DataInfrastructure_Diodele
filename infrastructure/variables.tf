variable "cloudflare_account_id" {
  description = "ID-ul contului Cloudflare (Account ID din dashboard)"
  type        = string
  default     = "dfe48fe11d5dfc0dc30a84dab037aff9"
}

variable "cloudflare_api_token" {
  description = "API Token-ul Cloudflare cu permisiuni de administrare D1 și Workers"
  type        = string
  sensitive   = true
  default     = ""
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
  description = "Numele worker-ului / proiectului Cloudflare pentru Dashboard (cu 12)"
  type        = string
  default     = "datainfrastructure-diodele12"
}
