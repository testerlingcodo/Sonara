# 🎵 Sonara — Discord Music Bot

Sonara is a feature-rich Discord music bot that supports **YouTube** and **Spotify** (tracks, playlists, albums). Built with discord.js v14 and @discordjs/voice.

---

## ✨ Features

- 🎵 Play songs from **YouTube** (URL or search query)
- 🟢 Play from **Spotify** (track, playlist, album links)
- 📋 Full **queue system** with add, remove, shuffle, clear
- 🔁 **Loop** current song or entire queue
- ⏸ Pause, resume, skip controls
- 🔊 Volume control
- 🎶 Auto-join your voice channel on `/play`
- 🤖 Modern **slash commands**

---

## 📋 Commands

| Command | Description |
|---|---|
| `/play <query/url>` | Play a song, YouTube URL, or Spotify link |
| `/join` | Join your voice channel |
| `/leave` | Disconnect from voice channel |
| `/stop` | Stop music and clear queue |
| `/skip` | Skip the current song |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/nowplaying` | Show the current song |
| `/queue` | Show the queue |
| `/loop <mode>` | Loop: song / queue / off |
| `/volume <1-100>` | Set volume |
| `/shuffle` | Shuffle the queue |
| `/clear` | Clear queue (keeps current song) |
| `/remove <position>` | Remove a song from queue |

---

## 🚀 Setup Guide

### 1. Requirements
- **Node.js v18+** → https://nodejs.org
- **FFmpeg** installed on your system
  - Windows: https://ffmpeg.org/download.html (add to PATH)
  - Linux: `sudo apt install ffmpeg`
  - Mac: `brew install ffmpeg`

---

### 2. Clone / Download the project

```bash
cd sonara
npm install
```

---

### 3. Create a Discord Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it `Sonara`
3. Go to **Bot** tab → click **Add Bot**
4. Under **Token** → click **Reset Token** → copy the token
5. Under **Privileged Gateway Intents**, enable:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `Send Messages`, `Embed Links`, `Read Message History`
7. Copy the generated URL, open it, and invite Sonara to your server

---

### 4. Create Spotify App

1. Go to https://developer.spotify.com/dashboard
2. Click **Create App**
3. Fill in name/description → check the TOS → Create
4. Click **Settings** → copy **Client ID** and **Client Secret**

---

### 5. Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
DISCORD_TOKEN=your_discord_bot_token_here
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
```

---

### 6. Run Sonara

```bash
npm start
```

You should see:
```
✅ Sonara is online as Sonara#1234
✅ Slash commands registered globally
```

> ⚠️ Slash commands may take up to **1 hour** to appear globally. To test instantly, use guild-specific commands (see below).

---

## 🎮 Usage Examples

```
/play Never Gonna Give You Up
/play https://www.youtube.com/watch?v=dQw4w9WgXcQ
/play https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT
/play https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF
```

---

## ⚡ Quick Tip — Instant Slash Commands (for testing)

Edit the bottom of `index.js`, changing:

```js
await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
```

to:

```js
await rest.put(Routes.applicationGuildCommands(client.user.id, 'YOUR_GUILD_ID'), { body: commands });
```

This registers commands only for your server — **instantly**.

---

## 🐛 Troubleshooting

| Problem | Solution |
|---|---|
| `ffmpeg not found` | Install FFmpeg and make sure it's in your PATH |
| `Cannot find module` | Run `npm install` again |
| Slash commands not showing | Wait up to 1 hour, or use guild commands |
| Spotify not working | Check your Client ID & Secret in `.env` |
| Bot not joining voice | Make sure bot has `Connect` and `Speak` permissions |

---

## 📦 Tech Stack

- [discord.js v14](https://discord.js.org)
- [@discordjs/voice](https://github.com/discordjs/voice)
- [@distube/ytdl-core](https://github.com/distubejs/ytdl-core)
- [yt-search](https://www.npmjs.com/package/yt-search)
- [spotify-web-api-node](https://github.com/thelinmichael/spotify-web-api-node)

---

Made with ❤️ — **Sonara Music Bot**
