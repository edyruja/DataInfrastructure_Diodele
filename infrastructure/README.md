# Infrastructure as Code (IaC) — Echipa Diodele

Acest folder conține specificațiile declarative de infrastructură Cloudflare definite prin **Terraform**.

## Componente Gestionate

* **Cloudflare D1 Database (`cloudflare_d1_database.telemetry_db`)**:
  * Nume: `pero_diodele`
  * ID instanță: `39ed8046-a6ba-440f-9b3f-0585373a0750`
  * Folosită de Worker (`src/backend/wrangler.toml`) prin binding-ul `DB`.

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

### 3. Sincronizarea resursei existente (Terraform Import)
Pentru a adopta în state-ul Terraform baza D1 deja creată și utilizată de Worker:
```bash
terraform import cloudflare_d1_database.telemetry_db <cloudflare_account_id>/39ed8046-a6ba-440f-9b3f-0585373a0750
```

### 4. Verificare plan
```bash
terraform plan
```
