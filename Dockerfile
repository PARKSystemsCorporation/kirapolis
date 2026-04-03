FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY services/agent/package.json services/agent/package.json
RUN npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts
COPY services/agent/ services/agent/
COPY apps/desktop/ apps/desktop/
COPY data/ data/
COPY scripts/ scripts/
COPY .env.example .env.example
RUN npm run build
ENV NODE_ENV=production
ENV KIRA_HOST=0.0.0.0
ENV KIRA_PORT=4317
EXPOSE 4317
CMD ["node", "services/agent/dist/server.js"]
