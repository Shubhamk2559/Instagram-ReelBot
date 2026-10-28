FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
COPY start.sh ./
USER node
EXPOSE 8000
CMD ["sh", "start.sh"]
