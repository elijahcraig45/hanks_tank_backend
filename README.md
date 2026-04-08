# Hank's Tank Backend — MLB Analytics REST API

> **Production:** [https://hankstank.uc.r.appspot.com](https://hankstank.uc.r.appspot.com)  
> **Part of:** [hanks_tank](../hanks_tank) · **hanks_tank_backend** ← · [hanks_tank_ml](../hanks_tank_ml)

TypeScript/Express REST API serving 35,000+ records of historical MLB data from Google BigQuery, supplemented with live MLB Stats API data and daily ML predictions. Deployed to Google Cloud App Engine as the `default` service.

---

## ✨ Key Capabilities

- **Hybrid data routing** — BigQuery for historical seasons (2015–2024), MLB Stats API for live current-season data
- **ML predictions** — reads daily V8 ensemble predictions from BigQuery, exposes all 54 columns (Elo, Pythagorean, arsenal, bullpen, streaks, H2H) with deduplication
- **Statcast** — per-player pitch-level Statcast data queryable by year, batter hand, pitch type, and outcome
- **News** — MLB + Braves news feed with manual refresh endpoint
- **Transactions** — team transaction history (2015–present)
- **Request deduplication** via `ROW_NUMBER() OVER (PARTITION BY game_pk ORDER BY predicted_at DESC)`

---

## 🏗️ Architecture

```
Client (React SPA)
    │
    └── GET /api/*
          │
    ┌─────┴─────────────────────────────────────┐
    │     Express + TypeScript (App Engine)      │
    │                                            │
    │  Route handlers (src/routes/)              │
    │  Controllers  (src/controllers/)           │
    │                                            │
    ├── BigQuery client  ──► mlb_2026_season.*   │
    │   (35K+ records)                           │
    ├── MLB Stats API    ──► statsapi.mlb.com    │
    ├── News API         ──► newsapi.org         │
    └── FanGraphs        ──► fangraphs.com       │
    └─────────────────────────────────────────────┘
```

---

## 📡 API Reference

### Health

```
GET /health
→ { status: "ok", timestamp: "...", version: "..." }
```

### Predictions

```
GET /api/predictions?date=2026-04-08
→ {
    predictions: [
      {
        game_pk, game_date,
        home_team_name, away_team_name,
        home_win_probability, away_win_probability,
        predicted_winner, confidence_tier,
        model_version, model_accuracy, lineup_confirmed,
        // V8 signals
        elo_home, elo_away, elo_differential, elo_home_win_prob,
        home_pythag_season, away_pythag_season,
        home_run_diff_10g, away_run_diff_10g,
        home_current_streak, away_current_streak,
        h2h_win_pct_3yr, is_divisional,
        // V7 signals (retained)
        home_bullpen_era, away_bullpen_era, moon_phase,
        home_starter_name, home_starter_era, home_starter_hand, ...
      }
    ]
  }
```

### Stats

```
GET /api/teamBatting?year=2025
GET /api/teamPitching?year=2025
GET /api/PlayerBatting?year=2025[&limit=500]
GET /api/PlayerPitching?year=2025[&limit=500]
GET /api/standings?year=2025
```

### Player / Team

```
GET /api/player/:playerId
GET /api/team/:teamAbbr
GET /api/team/:teamAbbr/transactions
GET /api/transactions?year=2025
```

### Statcast

```
GET /api/statcast?year=2025&playerId=12345&position=batter&limit=1000
                 [&p_throws=R|L] [&stands=R|L] [&events=home_run]
```

### News

```
GET  /api/mlb-news
GET  /api/braves-news
POST /api/news/refresh
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript 5 |
| Framework | Express 4 |
| Database | Google BigQuery (`mlb_2026_season`) |
| ORM / Query | `@google-cloud/bigquery` client |
| Hosting | Google Cloud App Engine (`default` service) |
| Logging | Structured JSON logs (Cloud Logging) |
| Testing | Jest |

---

## 🚀 Local Development

```bash
# Install
npm install

# Environment
cp .env.example .env
# Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
# Set NEWS_API_KEY, GOOGLE_CLOUD_PROJECT

# Start (ts-node with hot reload)
npm run dev

# Health check
curl http://localhost:8080/health
```

### Build & Deploy

```bash
npm run build
gcloud app deploy app.yaml --quiet
```

### Tests

```bash
npm test
```

---

## 📁 Repository Structure

```
hanks_tank_backend/
├── src/
│   ├── app.ts                      # Express setup, middleware, route mounting
│   ├── routes/
│   │   ├── predictions.routes.ts   # /api/predictions
│   │   ├── stats.routes.ts         # /api/teamBatting etc.
│   │   ├── player.routes.ts        # /api/player/:id
│   │   ├── statcast.routes.ts      # /api/statcast
│   │   ├── news.routes.ts          # /api/mlb-news, /api/braves-news
│   │   └── transactions.routes.ts  # /api/transactions
│   └── controllers/
│       ├── predictions.controller.ts
│       ├── stats.controller.ts
│       ├── statcast.controller.ts
│       └── news.controller.ts
├── data/                           # Local data cache (games, standings, rosters)
├── scripts/                        # Historical transaction collection
├── legacy_backup/                  # Previous JS implementation
├── app.yaml                        # App Engine config
├── jest.config.js
└── tsconfig.json
```

---

## 🌐 Environment Variables

| Variable | Description |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID (`hankstank`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account key |
| `NEWS_API_KEY` | NewsAPI.org API key |
| `PORT` | Server port (default 8080) |

---

## 📄 License

MIT — see [LICENSE](../hanks_tank/LICENSE)
