# Image Node légère
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Crée le dossier de données SQLite (monté en volume en prod)
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "src/app.js"]