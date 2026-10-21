FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Run as the unprivileged "node" user. The day-by-day record and the last
# tariff grid are kept in /data, the integration's persistent folder.
USER node

CMD ["node", "src/index.js"]
