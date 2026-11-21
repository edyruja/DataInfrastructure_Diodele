# Porsche CodeLap Hackathon 2026 — Telemetry Data Infrastructure
**Echipa:** Diodele  
**Proiect:** High-Performance Serverless Telemetry Pipeline & Live Digital Cockpit for Porsche Motorsport  

---

## 🏎️ 1. Solution Overview

Acest proiect reprezintă o infrastructură completă de telemetrie auto de înaltă performanță, concepută pentru mediul de motorsport. Soluția elimină necesitatea echipamentelor hardware costisitoare prin transformarea unui smartphone într-o unitate de telemetrie capabilă să captureze forțe G la 50 Hz și poziție satelitară de înaltă precizie.

### Arhitectura Sistemului (Pipeline-ul de Date)
Arhitectura este complet decuplată și distribuită la Edge pe Cloudflare:

```
[ Smartphone / Pilot ]
        │  (50 Hz IMU + GPS satelit, batching 1s)
        ▼
[ Cloudflare Worker (Producer) ] ── (ACK instant 15ms) ──► [ Smartphone ]
        │
        ▼ (Asincron)
[ Cloudflare Queues (telemetry-queue) ]
        │
        ▼ (Loturi de până la 50 mesaje)
[ Cloudflare Worker (Consumer) ]
        ├── Fuziune Senzorială (IMU + GPS)
        ├── Calcul Dinamic Forțe G & Aderență combinată
        ├── Geo-fencing Haversine (< 15m) & Lap Auto-Split
        ▼
[ Cloudflare D1 (Serverless SQLite) ]
        ▲
        │ (Near Real-Time Polling 1s)
[ TanStack Start Dashboard (React 19) ] ──► Cockpit 911 GT2 RS (60 FPS)
```

---

## 🛠️ 2. Relevant Tools & Technologies

| Modul | Tehnologii & Instrumente |
| :--- | :--- |
| **Mobile Capture** | React Native, Expo SDK 58, Expo Sensors (Accelerometru, Giroscop), Expo Location (GPS) |
| **Ingestion & Messaging** | Cloudflare Workers (Edge Serverless), Cloudflare Queues (Buffer asincron la nivel global) |
| **Data Processing** | Worker Consumer (Fuziune IMU-GPS, Haversine Lap Detection, filtrare matematică) |
| **Storage & Persistence** | Cloudflare D1 (Bază relațională SQLite distribuită la Edge, indecși pe `lap_offset_ms`) |
| **Digital Cockpit** | TanStack Start, React 19, Vite, Tailwind CSS, Lucide Icons, Catmull-Rom Spline Interpolation |
| **Infrastructure as Code** | HashiCorp Terraform (Provider Cloudflare v5), Wrangler CLI |

---

## 📦 3. Required Dependencies & Prerequisites

Înainte de instalare, asigurați-vă că aveți instalate:
- **Node.js**: `v20.x` sau mai nou (recomandat `v22.x`)
- **npm**: `v10.x` sau mai nou
- **Terraform**: `v1.7.0` sau mai nou (pentru provizionare IaC)
- **Wrangler CLI**: `npm install -g wrangler` (sau prin `npx wrangler`)
- **Cont Cloudflare**: Cu suport pentru Workers, D1 și Queues
- **Dispozitiv Android / iOS**: Cu aplicația Expo Go sau APK-ul compilat din `src/mobile/app2-release.apk`

---

## 🚀 4. Setup & Installation Instructions

### Pasul 1: Clonarea depozitului
```bash
git clone https://github.com/edyruja/DataInfrastructure_Diodele.git
cd DataInfrastructure_Diodele
```

### Pasul 2: Instalarea dependențelor pentru toate modulele
```bash
# Dependențe Backend Worker
npm --prefix src/backend install

# Dependențe Dashboard
npm --prefix src/dashboard install

# Dependențe Mobile App
npm --prefix src/mobile install
```

### Pasul 3: Configurare Variabile de Mediu
Creați fișierul `.env` în rădăcina proiectului pornind de la `.env.example`:
```bash
cp .env.example .env
```
Completați datele de acces Cloudflare:
```env
CLOUDFLARE_ACCOUNT_ID="your_account_id"
CLOUDFLARE_API_TOKEN="your_cloudflare_api_token"
```

---

## 💻 5. Instructions for Running the Solution

### A. Rularea Dashboard-ului (Digital Cockpit)
Pentru a porni interfața web local:
```bash
cd src/dashboard
npm run dev
```
Dashboard-ul va fi accesibil la adresa: **`http://localhost:8082`** (sau portul configurat de Vite).

### B. Provizionarea Infrastructurii (Terraform)
Pentru a proviziona automat baza de date D1, Coada și Worker-ul în Cloudflare:
```bash
cd infrastructure
terraform init -upgrade
terraform validate
terraform apply
```

### C. Deploy Backend Worker (Cloudflare)
Dacă doriți să faceți deploy manual al Worker-ului și aplicarea schemei bazei de date:
```bash
cd src/backend

# 1. Aplicare schemă SQL în D1
npx wrangler d1 execute telemetry-db --remote --file=schema.sql

# 2. Creare coadă (dacă nu a fost creată prin Terraform)
npx wrangler queues create telemetry-queue

# 3. Publicare Worker pe Cloudflare Edge
npx wrangler deploy
```

### D. Rularea Aplicației Mobile de Telemetrie
```bash
cd src/mobile
npx expo start
```
- Scanați codul QR din terminal cu aplicația **Expo Go** pe telefon (Android/iOS).
- Alternativ, puteți instala direct pachetul de release compilat: [src/mobile/app2-release.apk](src/mobile/app2-release.apk).

---

## 📊 6. Key Features

- **Decuplare Totală**: Ingestia răspunde în sub 15ms grație Cloudflare Queues; scrierea în D1 se face în loturi (batch size 20-50).
- **Fuziune Senzorială IMU + GPS**: Decuplează forțele laterale și de frânare folosind viteza satelitară și giroscopul 3-axe, eliminând nevoia alinierii rigide a telefonului.
- **Trigonometrie Haversine**: Închide și cronometrează automat tururile la traversarea liniei de start (< 15 metri).
- **60 FPS Smooth Playback**: Dashboard-ul interpolează datele prin spline Catmull-Rom și dinamică de chunk-buffering pentru a elimina sacadarea.
- **G-G Friction Circle**: Recreează vizualizarea avansată de aderență a anvelopelor specifică mașinilor GT2 RS / GT3 Cup.

---

## 📂 7. Repository Structure

```
├── infrastructure/         # Scripturi Terraform IaC (Cloudflare Provider v5)
├── presentation/           # Prezentarea finală a proiectului (.pptx / .pdf)
├── src/
│   ├── backend/            # Cloudflare Worker (Producer + Consumer) & Schema SQL
│   ├── dashboard/          # Dashboard web TanStack Start / React 19 (Cockpit GT2 RS)
│   └── mobile/             # Aplicație React Native / Expo pentru telemetrie mobilă
├── PREZENTARE_CODELAP.md   # Ghid detaliat de conținut pentru cele 7 slide-uri
└── README.md               # Documentația principală a soluției
```

---

## 📑 8. Presentation
Materialele pentru susținerea proiectului se găsesc în directorul [`presentation/`](presentation/):
- Prezentarea oficială a echipei Diodele: `presentation/`

