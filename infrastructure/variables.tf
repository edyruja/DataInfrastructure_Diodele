variable "cloudflare_account_id" {
  description = "ID-ul contului Cloudflare (Account ID)"
  type        = string
  default     = ""
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
