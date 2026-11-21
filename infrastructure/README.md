# Infrastructure as Code (IaC) — Echipa Diodele

Acest folder conține specificațiile declarative de infrastructură Cloudflare definite prin **Terraform**.

## Componente Gestionate

1. **Cloudflare D1 Database (`cloudflare_d1_database.telemetry_db`)**:
   * Nume: `pero_diodele`
   * ID instanță: `39ed8046-a6ba-440f-9b3f-0585373a0750`
   * Baza de date SQLite distribuită pentru persistența sesiunilor, tururilor și punctelor de telemetrie.

2. **Cloudflare Worker Backend (`cloudflare_workers_script.telemetry_worker`)**:
   * Nume: `telemetry-worker`
   * Script: `src/backend/src/index.js` (unificat și self-contained)
   * Binding: `d1_database_binding` conectat automat la instanța D1 (`env.DB`).
   * WebSocket & REST API pentru telemetrie F1.

3. **Cloudflare Pages Dashboard (`cloudflare_pages_project.dashboard_pages`)**:
   * Nume: `diodele-dashboard`
   * Interfața web TanStack Start / Vite (`src/dashboard`)
   * Build automat cu livrare prin CDN Cloudflare Pages (`diodele-dashboard.pages.dev`).

## Utilizare

### 1. Inițializare
```bash
cd infrastructure
terraform init
```

### 2. Configurare variabile
Copiați fișierul exemplu și adăugați credențialele:
```bash
cp terraform.tfvars.example terraform.tfvars
```

### 3. Sincronizarea resurselor existente (Terraform Import)
```bash
# Import baza D1:
terraform import cloudflare_d1_database.telemetry_db <cloudflare_account_id>/39ed8046-a6ba-440f-9b3f-0585373a0750

# Import worker:
terraform import cloudflare_workers_script.telemetry_worker <cloudflare_account_id>/telemetry-worker
```

### 4. Validare și Planificare
```bash
terraform validate
terraform plan
```
