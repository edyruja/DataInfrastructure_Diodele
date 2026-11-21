# Infrastructure as Code (IaC) — Echipa Diodele

Acest folder conține specificațiile declarative de infrastructură Cloudflare definite prin **Terraform**.

## Componente Gestionate

1. **Cloudflare Account ID**:
   * `dfe48fe11d5dfc0dc30a84dab037aff9`

2. **Cloudflare D1 Database (`cloudflare_d1_database.telemetry_db`)**:
   * Nume: `pero_diodele`
   * ID instanță: `39ed8046-a6ba-440f-9b3f-0585373a0750`
   * Baza de date SQLite distribuită pentru persistența sesiunilor, tururilor și punctelor de telemetrie.

3. **Cloudflare Backend Worker (`cloudflare_workers_script.telemetry_worker`)**:
   * Nume: `datainfrastructure-diodele`
   * URL: `https://datainfrastructure-diodele.cristianstefanpopa05.workers.dev`
   * WebSocket: `wss://datainfrastructure-diodele.cristianstefanpopa05.workers.dev/ws`
   * Script: `src/backend/src/index.js` (unificat și self-contained)
   * Binding: `d1_database_binding` conectat automat la instanța D1 (`env.DB`).

4. **Cloudflare Dashboard Web (`cloudflare_pages_project.dashboard_pages`)**:
   * Nume: `datainfrastructure-diodele12`
   * URL: `https://datainfrastructure-diodele12.cristianstefanpopa05.workers.dev`
   * Interfața web TanStack Start / Vite (`src/dashboard`)
   * Binding: Static Assets (`ASSETS`).

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
terraform import cloudflare_d1_database.telemetry_db dfe48fe11d5dfc0dc30a84dab037aff9/39ed8046-a6ba-440f-9b3f-0585373a0750

# Import Backend Worker:
terraform import cloudflare_workers_script.telemetry_worker dfe48fe11d5dfc0dc30a84dab037aff9/datainfrastructure-diodele

# Import Dashboard Pages / Worker:
terraform import cloudflare_pages_project.dashboard_pages dfe48fe11d5dfc0dc30a84dab037aff9/datainfrastructure-diodele12
```

### 4. Validare și Planificare
```bash
terraform validate
terraform plan
```
