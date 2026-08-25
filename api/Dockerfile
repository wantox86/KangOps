FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# Drizzle migration SQL files are read at runtime (drizzle-orm/better-sqlite3/migrator reads
# ./drizzle relative to cwd), not compiled -- must be copied into the runtime image separately.

FROM node:22-alpine AS runtime
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Stays root at container start (not `USER node` here) -- the entrypoint needs root briefly to
# chown the mounted /data volume (fresh named volumes are root-owned) before dropping to the
# non-root "node" user via su-exec. The app process itself (dist/index.js) never runs as root.
ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
