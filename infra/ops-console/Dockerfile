# HR Helper Ops — образ консоли для прода (сервис ops-console в infra/docker/docker-compose.contabo.yml).
# Сборка: SPA (vite) + бандл сервера (esbuild, зависимости внешние); рантайм — только prod-зависимости,
# без tsx/vite. База — SQLite-файл в /app/data (именованный volume, переживает деплои).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && npx esbuild server/local.ts --bundle --platform=node --target=node22 --format=esm --packages=external \
      --outfile=server-dist/local.mjs --log-level=warning \
 && npx esbuild server/queue/cli.ts --bundle --platform=node --target=node22 --format=esm --packages=external \
      --outfile=server-dist/oq-cli.mjs --log-level=warning \
 && cp -r server/db/migrations server-dist/migrations \
 && cp server/queue/page.html server-dist/page.html

FROM node:22-slim
# Шрифт с кириллицей — снимки графиков для Telegram рисуются на сервере (resvg, server/reports/charts.ts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -f /usr/share/fonts/truetype/dejavu/DejaVuSansMono* /usr/share/fonts/truetype/dejavu/DejaVuSerif* \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    OPS_HOST=0.0.0.0 \
    OPS_PORT=8797 \
    OPS_DATABASE_URL=file:/app/data/ops.db \
    OPS_TRUST_PROXY=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
# Файлы агента — их раздаёт установщик по одноразовому коду (/agent/install.sh, server/agents/enroll.ts).
COPY agent/hrh-ops-agent.py agent/hrh_ops_collect.py agent/hrh_ops_edge.py agent/hrh_ops_vpn.py agent/hrh-ops-vpnd.py \
  agent/hrh-ops-agent.service agent/hrh-ops-vpn.service ./agent/
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8797
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8797/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server-dist/local.mjs"]

# Отпечаток входов сборки (infra/scripts/prod/lib/build-plan.py): деплой сравнивает его с текущим деревом и
# пересобирает только изменившиеся сервисы. ARG — последним: значение меняется вместе с входами и не должно
# сбрасывать кэш слоёв выше.
ARG HR_SRC_FP=
LABEL org.hrhelper.src-fp=$HR_SRC_FP
