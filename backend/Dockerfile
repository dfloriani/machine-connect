FROM node:22-alpine

WORKDIR /app

# Package files first so the dependency layer is cached across source changes.
COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 4000

CMD ["node", "dist/server.js"]
