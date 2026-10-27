FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production PYTHONUNBUFFERED=1
WORKDIR /app
# Python venv for reelbot (instagrapi). Prebuilt wheels on Debian, so no Rust/compiling needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv
COPY reelbot/requirements.txt reelbot/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r reelbot/requirements.txt
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
COPY reelbot/reel_bot.py reelbot/reel_bot.py
COPY start.sh ./
USER node
EXPOSE 8000
CMD ["sh", "start.sh"]
