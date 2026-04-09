FROM node:20

WORKDIR /app

# Install build tools + curl
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp (the npm-bundled one is outdated)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
