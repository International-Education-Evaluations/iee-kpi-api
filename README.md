# IEE KPI Data API

Lightweight API server that queries MongoDB Atlas and serves KPI/QC data to Google Sheets via Apps Script.

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check — returns `{status: "ok"}` |
| `GET /collections` | API Key | Lists all collections across orders/payment/user/master databases |
| `GET /kpi-segments?days=90` | API Key | Processing status segments with worker attribution and durations |
| `GET /credential-counts?days=90` | API Key | Credential count per order for XpH calculation |
| `GET /qc-events?days=90` | API Key | QC events (I Fixed It / Kick It Back) with accountability |

## Security

- **Helmet** — secure HTTP headers
- **API Key** — required on all endpoints except /health
- **Rate Limiting** — 60 requests/minute per IP
- **CORS** — restricted to Google Apps Script origins
- **IP Allowlist** — optional, set `ALLOWED_IPS` env var

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `API_KEY` | Yes | Secret key for API authentication |
| `PORT` | No | Server port (default: 3000) |
| `ALLOWED_IPS` | No | Comma-separated IP allowlist |
| `NODE_ENV` | No | Environment (default: production) |

## Deploy on Railway

1. Push to GitHub
2. Connect repo in Railway
3. Add environment variables
4. Deploy — Railway auto-detects Node.js
