FROM node:20

WORKDIR /app

# Install build tools for native modules (sodium-native)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
