# Infrastructura Cloudflare

Aplicația mobilă trimite datele la `POST /api/telemetry`. Worker-ul `datainfrastructure-diodele` le publică în coada `telemetry-queue` prin binding-ul `TELEMETRY_QUEUE`. Același Worker consumă loturi de până la 50 de mesaje, cu o așteptare de cel mult o secundă pentru formarea lotului, și salvează rezultatele în D1 prin binding-ul `DB`.

Dashboard-ul `datainfrastructure-diodele12` rulează ca Worker. Terraform publică modulele SSR din `src/dashboard/.output/server` și fișierele statice din `src/dashboard/.output/public` prin binding-ul `ASSETS`.

## Pregătire

Folosește Terraform 1.7 sau mai nou, Node.js 22.12 sau mai nou și un token Cloudflare cu permisiunile de cont `D1 Edit`, `Workers Scripts Edit` și `Queues Edit`. Configurează tokenul prin `CLOUDFLARE_API_TOKEN` și confirmă că subdomeniul `workers.dev` al contului este înregistrat. Dacă folosești alt cont sau alte nume decât cele implicite, modifică o copie a fișierului `terraform.tfvars.example` numită `terraform.tfvars` și construiește dashboard-ul cu `VITE_API_URL` setat la URL-ul backend-ului tău.

Rulează comenzile de pregătire din rădăcina proiectului.

```bash
npm --prefix src/dashboard ci
npm --prefix src/dashboard run build
terraform -chdir=infrastructure init -upgrade
terraform -chdir=infrastructure validate
```

## Resurse existente

Dacă ai deja un state Terraform, folosește-l în continuare. Providerul v5 migrează state-ul pentru D1 și Worker-ul de backend la aceleași adrese. La aplicare, Terraform scoate vechiul proiect Pages din state și îl păstrează în Cloudflare. [Ghidul Cloudflare pentru migrarea la v5](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/guides/version-5-migration)

Importă resursele existente care lipsesc din state. Înlocuiește `ACCOUNT_ID` și `QUEUE_ID` cu ID-urile Cloudflare ale contului și cozii.

```bash
terraform -chdir=infrastructure import cloudflare_d1_database.telemetry_db ACCOUNT_ID/39ed8046-a6ba-440f-9b3f-0585373a0750
terraform -chdir=infrastructure import cloudflare_queue.telemetry_queue ACCOUNT_ID/QUEUE_ID
terraform -chdir=infrastructure import cloudflare_workers_script.telemetry_worker ACCOUNT_ID/datainfrastructure-diodele
terraform -chdir=infrastructure import cloudflare_workers_script.dashboard ACCOUNT_ID/datainfrastructure-diodele12
```

Dacă `telemetry-queue` are deja consumatorul configurat prin Wrangler, setează `manage_queue_consumer = false` în `terraform.tfvars`. Providerul Cloudflare nu poate importa consumatorul existent. Pentru o coadă fără consumator, valoarea implicită creează asocierea cu Worker-ul de telemetrie. [Resursa Terraform pentru consumatorul cozii](https://registry.terraform.io/providers/cloudflare/cloudflare/5.29.0/docs/resources/queue_consumer)

Dacă Worker-ul de telemetrie are încă migrarea `v1`, aplică o singură dată cu `-var=migrate_legacy_telemetry_hub=true` pentru a elimina clasa veche `TelemetryHub`. Pentru un Worker nou sau migrat deja la `v2`, folosește valoarea implicită.

## Inițializarea unei baze D1 noi

Pentru o bază D1 nouă, creeaz-o și aplică schema din `src/backend/schema.sql` înainte de a publica backend-ul. Comenzile folosesc contul și numele implicite din proiect.

```bash
terraform -chdir=infrastructure apply -target=cloudflare_d1_database.telemetry_db
DATABASE_NAME=$(terraform -chdir=infrastructure output -raw database_name)
(
  cd src/backend
  npm install --no-package-lock
  npx wrangler d1 execute "$DATABASE_NAME" --remote --file=schema.sql
)
```

## Planificare și aplicare

Pentru o bază D1 existentă, reaplică `src/backend/schema.sql` înainte de actualizarea Workerului de telemetrie. Comanda `wrangler d1 execute` din secțiunea anterioară creează tabelele pentru loturile cu timestamp și opririle de sesiune. Sesiunile din schema veche pot fi consultate în dashboard. Publică Workerul între sesiuni pentru ca o înregistrare să folosească aceeași schemă de la început până la final.

```bash
terraform -chdir=infrastructure plan
terraform -chdir=infrastructure apply
```

Output-urile includ ID-ul bazei D1, numele și ID-ul cozii și URL-urile celor două Workers.
