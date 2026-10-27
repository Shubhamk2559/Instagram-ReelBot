# Reel Scheduler

Single-service app: Express + TypeScript API serving a React (Vite) frontend, backed by Postgres.

## Structure
- `server/` – API, config validation, migrations (`server/migrations/*.sql`)
- `reelbot/` – standalone Python scheduler (instagrapi, no Meta developer app). See `reelbot/README.md`
- `web/` – React frontend
- `Dockerfile` – one image, runs migrations then starts the server

## Local development
1. `cp .env.example .env` and set `DATABASE_URL` (local Postgres 13+).
2. `npm install`
3. `npm run migrate`
4. Terminal 1: `npm run dev:server` (port 8000). Terminal 2: `npm run dev:web` (port 5173, proxies /api).

## Deploy on Koyeb
1. Create a Koyeb **Managed Postgres** database; copy its connection string.
2. Push this repo to GitHub. In Koyeb: Create Service → GitHub → select repo → builder **Dockerfile**.
3. Environment variables:
   - `DATABASE_URL` = connection string (use a Secret)
   - `DATABASE_SSL` = `true`
   - `APP_BASE_URL` = your Koyeb public URL
   - `NODE_ENV` = `production`
4. Port: `8000`, HTTP. Health check path: `/api/health`.
5. Deploy. Migrations run automatically on each start.

## Endpoints
- `GET /api/health` – liveness
- `GET /api/ready` – database connectivity
