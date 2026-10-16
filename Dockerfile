FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY data ./data
COPY LICENSES ./LICENSES
COPY NOTICE.md ./NOTICE.md
COPY snapshot/manifest.json ./snapshot/manifest.json
RUN mkdir /app/state && chown node:node /app/state
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATE_DIR=/app/state
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
