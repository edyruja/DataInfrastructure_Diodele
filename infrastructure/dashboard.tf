locals {
  dashboard_output_dir = "${path.module}/../src/dashboard/.output"
  dashboard_server_dir = "${local.dashboard_output_dir}/server"
  dashboard_entrypoint = "${local.dashboard_server_dir}/index.mjs"
}

resource "cloudflare_workers_script" "dashboard" {
  account_id          = var.cloudflare_account_id
  script_name         = var.dashboard_worker_name
  main_module         = "index.mjs"
  content_file        = local.dashboard_entrypoint
  content_sha256      = try(filesha256(local.dashboard_entrypoint), null)
  compatibility_date  = "2026-01-01"
  compatibility_flags = ["nodejs_compat"]

  files = {
    for module in setsubtract(fileset(local.dashboard_server_dir, "**/*.{mjs,js}"), ["index.mjs"]) : module => {
      content_type   = "application/javascript+module"
      content_base64 = filebase64("${local.dashboard_server_dir}/${module}")
    }
  }

  bindings = [{
    name = "ASSETS"
    type = "assets"
  }]

  assets = {
    directory = "${local.dashboard_output_dir}/public"
    config = {
      headers = try(file("${local.dashboard_output_dir}/public/_headers"), null)
    }
  }

  lifecycle {
    precondition {
      condition     = fileexists(local.dashboard_entrypoint) && length(fileset("${local.dashboard_output_dir}/public", "assets/**")) > 0
      error_message = "Rulează npm --prefix src/dashboard run build din rădăcina proiectului înainte de terraform plan."
    }
  }
}

resource "cloudflare_workers_script_subdomain" "dashboard" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.dashboard.script_name
  enabled     = true
}

removed {
  from = cloudflare_pages_project.dashboard_pages

  lifecycle {
    destroy = false
  }
}
