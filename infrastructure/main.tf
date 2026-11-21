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

# 1. Baza de date Cloudflare D1 pentru stocarea telemetriei F1
resource "cloudflare_d1_database" "telemetry_db" {
  account_id = var.cloudflare_account_id
  name       = var.d1_database_name
}

# 2. Worker-ul Cloudflare de Backend (Telemetrie F1)
# Încarcă index.js unificat din src/backend/src/index.js (self-contained)
resource "cloudflare_workers_script" "telemetry_worker" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name
  content    = file("${path.module}/../src/backend/src/index.js")
  module     = true

  compatibility_date  = "2026-01-01"
  compatibility_flags = ["nodejs_compat"]

  d1_database_binding {
    name        = "DB"
    database_id = cloudflare_d1_database.telemetry_db.id
  }
}

# 3. Proiectul Cloudflare Pages pentru Dashboard (Interfața Web TanStack Start / Vite)
resource "cloudflare_pages_project" "dashboard_pages" {
  account_id        = var.cloudflare_account_id
  name              = var.dashboard_name
  production_branch = "main"

  build_config {
    build_command   = "npm run build"
    destination_dir = ".output/public"
    root_dir        = "src/dashboard"
  }

  deployment_configs {
    production {
      compatibility_date  = "2026-01-01"
      compatibility_flags = ["nodejs_compat"]
    }
  }
}
