terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# 1. Declararea bazei de date Cloudflare D1
# Baza de date D1 utilizată pentru stocarea telemetriei F1 (sessions, laps, telemetry_points)
resource "cloudflare_d1_database" "telemetry_db" {
  account_id = var.cloudflare_account_id
  name       = var.d1_database_name
}
