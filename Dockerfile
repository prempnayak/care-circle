# Local-mode image: runs dev-auth, the API (with in-process workers), dashboard and simulator.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=development
COPY . .
RUN npm ci --no-audit --no-fund
EXPOSE 8787 8788 5173 5174 8790
CMD ["npm", "run", "start:local"]
