resource "cloudflare_d1_database" "telemetry_db" {
  account_id = var.cloudflare_account_id
  name       = var.d1_database_name
}

resource "cloudflare_queue" "telemetry_queue" {
  account_id = var.cloudflare_account_id
  queue_name = var.telemetry_queue_name
}

resource "cloudflare_workers_script" "telemetry_worker" {
  account_id         = var.cloudflare_account_id
  script_name        = var.backend_worker_name
  main_module        = "index.js"
  content            = file("${path.module}/../src/backend/src/index.js")
  compatibility_date = "2026-01-01"

  bindings = [
    {
      name = "DB"
      type = "d1"
      id   = cloudflare_d1_database.telemetry_db.id
    },
    {
      name       = "TELEMETRY_QUEUE"
      type       = "queue"
      queue_name = cloudflare_queue.telemetry_queue.queue_name
    },
  ]

  migrations = var.migrate_legacy_telemetry_hub ? {
    old_tag         = "v1"
    new_tag         = "v2"
    deleted_classes = ["TelemetryHub"]
  } : null
}

resource "cloudflare_queue_consumer" "telemetry_consumer" {
  count = var.manage_queue_consumer ? 1 : 0

  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.telemetry_queue.id
  script_name = cloudflare_workers_script.telemetry_worker.script_name
  type        = "worker"

  settings = {
    batch_size       = 50
    max_wait_time_ms = 1000
  }
}

resource "cloudflare_workers_script_subdomain" "telemetry_worker" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.telemetry_worker.script_name
  enabled     = true

  depends_on = [cloudflare_queue_consumer.telemetry_consumer]
}
