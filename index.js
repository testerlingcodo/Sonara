const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const { constants: ytdlConstants } = require('youtube-dl-exec');
const { Readable } = require('stream');
const ffmpegPath = require('ffmpeg-static');
const ytSearch = require('yt-search');
const fs = require('fs');
const http = require('http');
require('dotenv').config();

// ─── youtubei.js (InnerTube API with OAuth2) ───────────────────────────────────
let _ytInstance = null;
async function getYouTubeInstance() {
  if (_ytInstance) return _ytInstance;
  const { Innertube } = require('youtubei.js');
  const opts = { generate_session_locally: true };
  if (process.env.YOUTUBE_OAUTH_TOKENS) {
    try {
      opts.credentials = JSON.parse(
        Buffer.from(process.env.YOUTUBE_OAUTH_TOKENS, 'base64').toString('utf8')
      );
      console.log('✅ YouTube OAuth2 tokens loaded');
    } catch { console.error('Invalid YOUTUBE_OAUTH_TOKENS env var'); }
  }
  _ytInstance = await Innertube.create(opts);
  _ytInstance.session.on('update-credentials', ({ credentials }) => {
    console.log('🔑 OAuth2 tokens refreshed — update YOUTUBE_OAUTH_TOKENS on Render:');
    console.log(Buffer.from(JSON.stringify(credentials)).toString('base64'));
  });
  return _ytInstance;
}
// Pre-warm the instance at startup
getYouTubeInstance().catch(e => console.error('youtubei init error:', e.message));

const PREFIX = '!s';

// Use system yt-dlp (latest, installed via Dockerfile) with fallback to bundled
const YTDLP_PATH = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : ytdlConstants.YOUTUBE_DL_PATH;

// Write YouTube cookies file from env var (needed on cloud servers to bypass bot detection)
const COOKIES_PATH = '/tmp/yt-cookies.txt';
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf8'));
  console.log('✅ YouTube cookies loaded');
}

// Commands only the host can use
const HOST_ONLY = new Set(['stop','skip','pause','resume','leave','clear','shuffle','remove','loop','volume','vocal','host']);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const queues = new Map();

// ─── Spotify (scrape OG tags — no API key needed) ──────────────────────────────
async function scrapeSpotifyPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  });
  const html = await res.text();
  const title  = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
  const desc   = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1];
  if (!title) throw new Error('Could not read Spotify page');
  const artist = desc?.split('·')[0]?.trim() || '';
  return artist ? `${title} ${artist}` : title;
}

async function scrapeSpotifyPlaylist(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  });
  const html = await res.text();
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ldMatch) throw new Error('Could not extract playlist tracks from Spotify');
  const ld = JSON.parse(ldMatch[1]);
  const tracks = ld.track || ld.tracks || [];
  return tracks.map(t => `${t.name} ${t.byArtist?.name || ''}`).filter(Boolean);
}

// ─── Proxy audio fetch (Piped + Invidious in parallel) ────────────────────────
// Bypasses YouTube IP restrictions on cloud servers — all sources raced at once.

async function _fetchPiped(instance, videoId) {
  const res = await fetch(`${instance}/streams/${videoId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.audioStreams?.length) throw new Error('no streams');
  const best = [...data.audioStreams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!best?.url) throw new Error('no url');
  console.log(`[proxy] audio via Piped ${instance}`);
  return best.url;
}

async function _fetchInvidious(instance, videoId) {
  const res = await fetch(`${instance}/api/v1/videos/${videoId}?local=true`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const audio = (data.adaptiveFormats || [])
    .filter(f => f.type?.startsWith('audio/') && f.url)
    .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0))[0];
  if (!audio?.url) throw new Error('no formats');
  console.log(`[proxy] audio via Invidious ${instance}`);
  return audio.url;
}

async function getProxiedAudioUrl(videoId) {
  try {
    return await Promise.any([
      _fetchPiped('https://pipedapi.kavin.rocks', videoId),
      _fetchPiped('https://pipedapi.adminforge.de', videoId),
      _fetchPiped('https://piped-api.garudalinux.org', videoId),
      _fetchInvidious('https://inv.nadeko.net', videoId),
      _fetchInvidious('https://invidious.privacydev.net', videoId),
      _fetchInvidious('https://iv.ggtyler.dev', videoId),
      _fetchInvidious('https://invidious.flokinet.to', videoId),
    ]);
  } catch (e) {
    const reasons = (e instanceof AggregateError ? e.errors : [e]).map(x => x.message).join(' | ');
    console.error('[proxy] all sources failed:', reasons);
    return null;
  }
}

// ─── Embeds ────────────────────────────────────────────────────────────────────
function errorEmbed(msg) {
  return new EmbedBuilder().setColor('#ED4245').setDescription(`❌  ${msg}`);
}

function nowPlayingEmbed(song, queue) {
  const isSpotify  = song.source === 'spotify';
  const loopStatus = queue.loop ? '🔂 Song' : queue.loopQueue ? '🔁 Queue' : '─';
  return new EmbedBuilder()
    .setColor(isSpotify ? '#1DB954' : '#FF0000')
    .setAuthor({ name: isSpotify ? '🎵  Now Playing  •  via Spotify' : '▶  Now Playing  •  YouTube' })
    .setTitle(song.title)
    .setURL(song.url)
    .setThumbnail(song.thumbnail || null)
    .addFields(
      { name: '⏱  Duration',     value: `\`${song.duration || 'Unknown'}\``, inline: true },
      { name: '👤  Requested by', value: song.requestedBy,                   inline: true },
      { name: '🔁  Loop',         value: loopStatus,                          inline: true },
    )
    .setFooter({ text: `Sonara  •  ${queue.songs.length} song(s) left  •  Host: ${queue.hostTag || 'None'}` })
    .setTimestamp();
}

function addedToQueueEmbed(song, position) {
  const isSpotify = song.source === 'spotify';
  return new EmbedBuilder()
    .setColor(isSpotify ? '#1DB954' : '#FF0000')
    .setAuthor({ name: '➕  Added to Queue' })
    .setTitle(song.title)
    .setURL(song.url)
    .setThumbnail(song.thumbnail || null)
    .addFields(
      { name: '⏱  Duration', value: `\`${song.duration || 'Unknown'}\``, inline: true },
      { name: '📍  Position', value: `#${position}`,                      inline: true },
    )
    .setFooter({ text: 'Sonara Music Bot' });
}

function playlistAddedEmbed(count, source) {
  return new EmbedBuilder()
    .setColor(source === 'spotify' ? '#1DB954' : '#FF0000')
    .setAuthor({ name: '📋  Playlist Added' })
    .setDescription(`Added **${count} songs** to the queue!`)
    .setFooter({ text: 'Sonara Music Bot' });
}

function queueFinishedEmbed() {
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setDescription('✅  Queue finished! Use `!s play` to add more songs.');
}

function sadKickedEmbed() {
  return new EmbedBuilder()
    .setColor('#36393F')
    .setTitle('😢  Disconnected')
    .setDescription("*Looks like someone kicked me out...*\n\nI'll be back when you need me. 💔\nUse `!s join` to call me back!")
    .setFooter({ text: 'Sonara Music Bot' });
}

function requestEmbed(song, requesterTag, hostId) {
  const isSpotify = song.source === 'spotify';
  return new EmbedBuilder()
    .setColor('#FEE75C')
    .setAuthor({ name: '🎵  Song Request — Awaiting Approval' })
    .setTitle(song.title)
    .setURL(song.url)
    .setThumbnail(song.thumbnail || null)
    .addFields(
      { name: '👤  Requested by', value: requesterTag,                         inline: true },
      { name: '⏱  Duration',     value: `\`${song.duration || 'Unknown'}\``,  inline: true },
      { name: '🎵  Source',       value: isSpotify ? 'Spotify' : 'YouTube',    inline: true },
    )
    .setDescription(`<@${hostId}> — please approve or deny this request.`)
    .setFooter({ text: 'Sonara Music Bot' });
}

// ─── Queue Class ───────────────────────────────────────────────────────────────
class MusicQueue {
  constructor(guildId, textChannel, voiceChannel, connection, hostId, hostTag) {
    this.guildId         = guildId;
    this.textChannel     = textChannel;
    this.voiceChannel    = voiceChannel;
    this.connection      = connection;
    this.songs           = [];
    this.player          = createAudioPlayer();
    this.currentSong     = null;
    this.loop            = false;
    this.loopQueue       = false;
    this.volume          = 100;
    this.vocalGain       = 0;
    this.isPlaying       = false;
    this.resource        = null;
    this._restarting     = false;
    this.hostId          = hostId;
    this.hostTag         = hostTag;
    this.pendingRequests = new Map(); // requestId → { song, userId, tag }

    this.connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this._restarting) return;
      if (this.loop && this.currentSong) {
        this.play(this.currentSong);
      } else {
        if (this.loopQueue && this.currentSong) this.songs.push(this.currentSong);
        this.next();
      }
    });

    this.player.on('error', (err) => {
      console.error('Player error:', err.message);
      this.textChannel.send({ embeds: [errorEmbed(`Playback error: ${err.message}`)] });
      this.next();
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.textChannel.send({ embeds: [sadKickedEmbed()] });
        this._destroySilent();
      }
    });
  }

  async play(song) {
    this.currentSong = song;
    this.isPlaying   = true;
    try {
      const eqFilter = this.vocalGain > 0
        ? ['-af', `equalizer=f=1000:width_type=o:width=2:g=${Math.round(this.vocalGain / 2)},equalizer=f=2500:width_type=o:width=2:g=${this.vocalGain}`]
        : [];
      const ffmpegOutArgs = ['-vn', ...eqFilter, '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1'];

      const videoId = song.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];

      let ffmpegProc;

      // ── 1. Piped / Invidious proxy ────────────────────────────────────────────
      const proxyUrl = videoId ? await getProxiedAudioUrl(videoId) : null;

      if (proxyUrl) {
        ffmpegProc = spawn(ffmpegPath, [
          '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
          '-i', proxyUrl, ...ffmpegOutArgs,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

      // ── 2. youtubei.js InnerTube API (works with OAuth2 from any IP) ──────────
      } else if (videoId) {
        console.log('[youtubei] streaming');
        const yt = await getYouTubeInstance();
        const ytStream = await yt.download(videoId, { type: 'audio', quality: 'bestefficiency' });
        const nodeStream = Readable.fromWeb(ytStream);
        ffmpegProc = spawn(ffmpegPath, ['-i', 'pipe:0', ...ffmpegOutArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
        nodeStream.pipe(ffmpegProc.stdin);
        nodeStream.on('error', err => {
          console.error('[youtubei] stream error:', err.message);
          ffmpegProc.stdin.destroy(err);
        });

      // ── 3. yt-dlp (direct piping, last resort) ───────────────────────────────
      } else {
        const ytdlArgs = [
          song.url, '-o', '-', '-f', 'bestaudio/best',
          '--no-check-certificates', '--no-playlist', '--quiet',
        ];
        if (fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 0)
          ytdlArgs.push('--cookies', COOKIES_PATH);
        console.log('[yt-dlp] fetching');
        const ytdlProc = spawn(YTDLP_PATH, ytdlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        ffmpegProc = spawn(ffmpegPath, ['-i', 'pipe:0', ...ffmpegOutArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
        ytdlProc.stdout.pipe(ffmpegProc.stdin);
        let ytdlErr = '';
        ytdlProc.stderr.on('data', d => { ytdlErr += d.toString(); });
        ytdlProc.on('close', code => {
          if (code !== 0) {
            console.error(`[yt-dlp] exit ${code}:`, ytdlErr.trim());
            ffmpegProc.stdin.destroy(new Error(ytdlErr.trim().split('\n').pop()));
          } else {
            ffmpegProc.stdin.end();
          }
        });
      }

      let ffmpegErr = '';
      ffmpegProc.stderr.on('data', d => { ffmpegErr += d.toString(); });
      ffmpegProc.on('close', code => {
        if (code !== 0) console.error(`[ffmpeg] exit ${code}:`, ffmpegErr.slice(-300));
      });

      this.resource = createAudioResource(ffmpegProc.stdout, { inputType: StreamType.OggOpus, inlineVolume: true });
      this.resource.volume?.setVolume(this.volume / 100);
      this.player.play(this.resource);

      this.textChannel.send({ embeds: [nowPlayingEmbed(song, this)] });
    } catch (err) {
      console.error('Play error:', err);
      this.textChannel.send({ embeds: [errorEmbed(`Could not play: **${song.title}**\n\`${err.message}\``)] });
      this.next();
    }
  }

  next() {
    if (this.songs.length === 0) {
      this.currentSong = null;
      this.isPlaying   = false;
      this.textChannel.send({ embeds: [queueFinishedEmbed()] });
      setTimeout(() => { if (!this.isPlaying) this._destroySilent(); }, 30000);
      return;
    }
    this.play(this.songs.shift());
  }

  _destroySilent() {
    this.player.stop();
    try { this.connection.destroy(); } catch {}
    queues.delete(this.guildId);
  }

  destroy() { this._destroySilent(); }
}

// ─── Song Resolution ───────────────────────────────────────────────────────────
async function resolveSong(query, requestedBy) {
  const ytMatch = query.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) {
    const info = await ytSearch({ videoId: ytMatch[1] });
    return [{
      title: info.title || query,
      url: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
      duration: info.timestamp || 'Unknown',
      thumbnail: info.thumbnail,
      source: 'youtube',
      requestedBy,
    }];
  }

  if (query.includes('spotify.com/track')) {
    const searchQuery = await scrapeSpotifyPage(query);
    const song = await searchYouTube(searchQuery, requestedBy);
    if (song) song.source = 'spotify';
    return [song];
  }

  if (query.includes('spotify.com/playlist') || query.includes('spotify.com/album')) {
    const queries = await scrapeSpotifyPlaylist(query);
    const songs = await Promise.all(queries.slice(0, 50).map(q => searchYouTube(q, requestedBy)));
    return songs.filter(Boolean).map(s => ({ ...s, source: 'spotify' }));
  }

  return [await searchYouTube(query, requestedBy)];
}

async function searchYouTube(query, requestedBy) {
  const result = await ytSearch(query);
  const video  = result.videos[0];
  if (!video) return null;
  return {
    title: video.title,
    url: video.videoId
      ? `https://www.youtube.com/watch?v=${video.videoId}`
      : video.url?.startsWith('http') ? video.url : `https://www.youtube.com${video.url}`,
    duration:  video.timestamp,
    thumbnail: video.thumbnail,
    source:    'search',
    requestedBy,
  };
}

// ─── Bot Ready ─────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Sonara is online as ${client.user.tag}`);
  client.user.setActivity(`${PREFIX} play • music`, { type: ActivityType.Listening });
});

// ─── Voice State: detect host leaving VC ──────────────────────────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  if (!oldState.member || oldState.member.user.bot) return;
  const queue = queues.get(oldState.guild.id);
  if (!queue || !queue.hostId) return;
  // Host left the voice channel entirely
  if (oldState.member.id === queue.hostId && oldState.channelId && !newState.channelId) {
    queue.hostId  = null;
    queue.hostTag = null;
    queue.textChannel.send({
      embeds: [new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('👑  Host Left')
        .setDescription('The host has left the voice channel.\nThe **next person** to use `!s play` or `!s join` will become the new host.')
      ],
    });
  }
});

// ─── Button Interactions (approve / deny requests) ────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const parts = interaction.customId.split('_');
  if (parts.length !== 3 || !['approve', 'deny'].includes(parts[0])) return;
  const [action, guildId, requestId] = parts;

  const queue = queues.get(guildId);
  if (!queue) return interaction.reply({ content: 'This session has ended.', ephemeral: true });

  if (interaction.user.id !== queue.hostId)
    return interaction.reply({ content: '❌  Only the host can approve or deny requests.', ephemeral: true });

  const request = queue.pendingRequests.get(requestId);
  if (!request) return interaction.reply({ content: 'This request has already been handled or expired.', ephemeral: true });

  queue.pendingRequests.delete(requestId);

  if (action === 'approve') {
    queue.songs.push(request.song);
    if (!queue.isPlaying) queue.next();
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor('#1DB954')
        .setAuthor({ name: '✅  Request Approved' })
        .setTitle(request.song.title)
        .setURL(request.song.url)
        .setDescription(`Added to queue by <@${queue.hostId}>!\nPosition: **#${queue.songs.length}**`)
        .setFooter({ text: `Requested by ${request.tag}` })
      ],
      components: [],
    });
  } else {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor('#ED4245')
        .setAuthor({ name: '❌  Request Denied' })
        .setTitle(request.song.title)
        .setDescription(`Denied by <@${queue.hostId}>.`)
        .setFooter({ text: `Requested by ${request.tag}` })
      ],
      components: [],
    });
  }
});

// ─── Message Handler (!s prefix) ──────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.toLowerCase().startsWith(PREFIX.toLowerCase())) return;

  const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const query   = args.join(' ');

  const guild        = message.guild;
  const member       = message.member;
  const textChannel  = message.channel;
  const voiceChannel = member?.voice?.channel;
  const queue        = queues.get(guild.id);

  const reply = (embed) => textChannel.send({ embeds: [embed] });

  // ── play ──
  if (command === 'play') {
    if (!query) return reply(errorEmbed('Please provide a song name or link!\nUsage: `!s play <song name or URL>`'));
    if (!voiceChannel) return reply(errorEmbed('You need to be in a voice channel first!'));

    const searchEmbed = new EmbedBuilder().setColor('#5865F2').setDescription(`🔍  Searching for **${query}**...`);
    const msg = await textChannel.send({ embeds: [searchEmbed] });

    let songs;
    try {
      songs = await resolveSong(query, message.author.tag);
    } catch (err) {
      console.error('resolveSong error:', err);
      return msg.edit({ embeds: [errorEmbed(`Could not find: ${err?.message || JSON.stringify(err)}`)] });
    }

    songs = songs.filter(Boolean);
    if (!songs.length) return msg.edit({ embeds: [errorEmbed('No results found!')] });

    let guildQueue = queues.get(guild.id);

    // Create queue if not exists — caller becomes host
    if (!guildQueue) {
      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId:   guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
        });
        guildQueue = new MusicQueue(guild.id, textChannel, voiceChannel, connection, message.author.id, message.author.tag);
        queues.set(guild.id, guildQueue);
      } catch (err) {
        return msg.edit({ embeds: [errorEmbed(`Cannot join voice channel: ${err.message}`)] });
      }
    }

    // If there's no host (previous host left), caller becomes host
    if (!guildQueue.hostId) {
      guildQueue.hostId  = message.author.id;
      guildQueue.hostTag = message.author.tag;
      await textChannel.send({
        embeds: [new EmbedBuilder()
          .setColor('#FEE75C')
          .setDescription(`👑  <@${message.author.id}> is now the host!`)
        ],
      });
    }

    const isHost = message.author.id === guildQueue.hostId;

    // Non-host → send request for approval
    if (!isHost) {
      const song      = songs[0]; // only single-song requests for non-hosts
      const requestId = Date.now().toString();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${guild.id}_${requestId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_${guild.id}_${requestId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
      );
      await textChannel.send({
        embeds: [requestEmbed(song, message.author.tag, guildQueue.hostId)],
        components: [row],
      });
      guildQueue.pendingRequests.set(requestId, { song, userId: message.author.id, tag: message.author.tag });
      return msg.edit({
        embeds: [new EmbedBuilder()
          .setColor('#FEE75C')
          .setDescription(`⏳  Your request for **${song.title}** was sent to <@${guildQueue.hostId}> for approval.`)
        ],
      });
    }

    // Host → add directly
    if (songs.length === 1) {
      guildQueue.songs.push(songs[0]);
      if (!guildQueue.isPlaying) {
        guildQueue.next();
        await msg.delete().catch(() => {});
      } else {
        await msg.edit({ embeds: [addedToQueueEmbed(songs[0], guildQueue.songs.length)] });
      }
    } else {
      guildQueue.songs.push(...songs);
      if (!guildQueue.isPlaying) guildQueue.next();
      await msg.edit({ embeds: [playlistAddedEmbed(songs.length, songs[0]?.source || 'search')] });
    }
    return;
  }

  // ── join ──
  if (command === 'join') {
    if (!voiceChannel) return reply(errorEmbed('You need to be in a voice channel first!'));
    // If there's a queue already, check host permission
    if (queue && queue.hostId && message.author.id !== queue.hostId)
      return reply(errorEmbed(`Only <@${queue.hostId}> (the host) can move me with \`!s join\`.`));
    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId:   guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
      });
      const newQueue = new MusicQueue(guild.id, textChannel, voiceChannel, connection, message.author.id, message.author.tag);
      queues.set(guild.id, newQueue);
      return reply(new EmbedBuilder()
        .setColor('#1DB954')
        .setDescription(`🎶  Joined **${voiceChannel.name}**!\n👑  **${message.author.tag}** is the host.`));
    } catch (err) {
      return reply(errorEmbed(`Could not join: ${err.message}`));
    }
  }

  // ── public commands (no queue needed restriction) ──
  if (command === 'help') {
    return reply(new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎵  Sonara Commands')
      .setDescription(`All commands start with \`${PREFIX}\``)
      .addFields(
        { name: '▶  Playback',         value: '`play <song/link>` `stop` `skip` `pause` `resume`' },
        { name: '🔁  Queue',           value: '`queue` `clear` `shuffle` `remove <pos>` `nowplaying`' },
        { name: '🔊  Settings',        value: '`volume <1-100>` `vocal <0-100>` `loop song|queue|off`' },
        { name: '🔗  Voice',           value: '`join` `leave`' },
        { name: '👑  Host',            value: '`host @user` — transfer host to someone else' },
        { name: '📌  Permissions',     value: 'The person who calls Sonara is the **host**.\nOnly the host can control playback.\nOthers can request songs — host approves/denies.' },
      )
      .setFooter({ text: 'Sonara Music Bot  •  Supports YouTube & Spotify' }));
  }

  // ── commands that need an active queue ──
  if (!queue) {
    return reply(errorEmbed(`Nothing is playing right now! Start with \`${PREFIX} play <song>\``));
  }

  // ── host-only check ──
  if (HOST_ONLY.has(command) && queue.hostId && message.author.id !== queue.hostId) {
    return reply(new EmbedBuilder()
      .setColor('#ED4245')
      .setDescription(`🔒  Only <@${queue.hostId}> (the host) can use \`${PREFIX} ${command}\`.`));
  }

  if (command === 'stop') {
    queue.songs = [];
    queue.destroy();
    return reply(new EmbedBuilder().setColor('#ED4245').setDescription('⏹  Stopped and cleared the queue.'));
  }

  if (command === 'skip') {
    const skipped = queue.currentSong?.title || 'Unknown';
    queue.loop = false;
    queue.player.stop();
    return reply(new EmbedBuilder().setColor('#FEE75C').setDescription(`⏭  Skipped **${skipped}**`));
  }

  if (command === 'pause') {
    queue.player.pause();
    return reply(new EmbedBuilder().setColor('#FEE75C').setDescription('⏸  Paused.'));
  }

  if (command === 'resume') {
    queue.player.unpause();
    return reply(new EmbedBuilder().setColor('#1DB954').setDescription('▶️  Resumed.'));
  }

  if (command === 'leave') {
    queue.destroy();
    return reply(new EmbedBuilder().setColor('#5865F2').setDescription('👋  Left the voice channel. See you!'));
  }

  if (command === 'nowplaying') {
    if (!queue.currentSong) return reply(errorEmbed('Nothing is playing right now.'));
    return reply(nowPlayingEmbed(queue.currentSong, queue));
  }

  if (command === 'queue') {
    const current = queue.currentSong;
    const songs   = queue.songs;
    let desc = '';
    if (current) {
      const srcIcon = current.source === 'spotify' ? '🟢' : '🔴';
      desc += `**Now Playing ${srcIcon}**\n> **${current.title}** \`${current.duration || '??'}\`\n\n`;
    }
    if (songs.length === 0) {
      desc += '*Queue is empty — add songs with `!s play`*';
    } else {
      desc += `**Up Next (${songs.length} song${songs.length !== 1 ? 's' : ''}):**\n`;
      songs.slice(0, 15).forEach((s, i) => {
        const icon = s.source === 'spotify' ? '🟢' : '🔴';
        desc += `\`${i + 1}.\` ${icon} ${s.title} \`${s.duration || '??'}\` — ${s.requestedBy}\n`;
      });
      if (songs.length > 15) desc += `\n*...and ${songs.length - 15} more*`;
    }
    return reply(new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📋  Sonara Queue')
      .setDescription(desc)
      .setFooter({ text: `🔴 YouTube  •  🟢 Spotify  |  Loop: ${queue.loop ? 'Song' : queue.loopQueue ? 'Queue' : 'Off'}  |  Host: ${queue.hostTag || 'None'}` }));
  }

  if (command === 'loop') {
    const mode = query.toLowerCase().trim();
    if (!['song', 'queue', 'off'].includes(mode))
      return reply(errorEmbed('Usage: `!s loop song` | `!s loop queue` | `!s loop off`'));
    queue.loop      = mode === 'song';
    queue.loopQueue = mode === 'queue';
    const msgs = { song: '🔂  Looping current song.', queue: '🔁  Looping entire queue.', off: '🔁  Loop disabled.' };
    return reply(new EmbedBuilder().setColor('#5865F2').setDescription(msgs[mode]));
  }

  if (command === 'volume') {
    const level = parseInt(query);
    if (isNaN(level) || level < 1 || level > 100)
      return reply(errorEmbed('Usage: `!s volume <1-100>`'));
    queue.volume = level;
    queue.resource?.volume?.setVolume(level / 100);
    return reply(new EmbedBuilder().setColor('#5865F2').setDescription(`🔊  Volume set to **${level}%**`));
  }

  if (command === 'vocal') {
    const level = parseInt(query);
    if (isNaN(level) || level < 0 || level > 100)
      return reply(errorEmbed('Usage: `!s vocal <0-100>` (0 = off, 100 = max boost)'));
    queue.vocalGain = Math.round(level * 15 / 100);
    if (queue.currentSong) {
      const song = queue.currentSong;
      queue._restarting = true;
      queue.player.stop();
      queue._restarting = false;
      queue.play(song);
    }
    const label = level === 0 ? 'off' : `${level}%`;
    return reply(new EmbedBuilder()
      .setColor('#5865F2')
      .setDescription(`🎤  Vocal boost set to **${label}**${queue.currentSong ? ' — restarting track with new EQ' : ''}`));
  }

  if (command === 'shuffle') {
    for (let i = queue.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue.songs[i], queue.songs[j]] = [queue.songs[j], queue.songs[i]];
    }
    return reply(new EmbedBuilder().setColor('#5865F2').setDescription('🔀  Queue shuffled!'));
  }

  if (command === 'clear') {
    queue.songs = [];
    return reply(new EmbedBuilder().setColor('#5865F2').setDescription('🧹  Queue cleared!'));
  }

  if (command === 'remove') {
    const pos = parseInt(query);
    if (isNaN(pos) || pos < 1 || pos > queue.songs.length)
      return reply(errorEmbed(`Invalid position. Queue has **${queue.songs.length}** song(s).`));
    const removed = queue.songs.splice(pos - 1, 1)[0];
    return reply(new EmbedBuilder().setColor('#5865F2').setDescription(`🗑  Removed **${removed.title}** from queue.`));
  }

  if (command === 'host') {
    const mentioned = message.mentions.users.first();
    if (!mentioned) return reply(errorEmbed('Usage: `!s host @user` — transfer host to someone else'));
    if (mentioned.bot) return reply(errorEmbed('Cannot transfer host to a bot.'));
    queue.hostId  = mentioned.id;
    queue.hostTag = mentioned.tag;
    return reply(new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('👑  Host Transferred')
      .setDescription(`<@${mentioned.id}> is now the host and has full control over Sonara.`));
  }
});

// Keep-alive HTTP server for Render free tier
http.createServer((req, res) => res.end('Sonara is alive!')).listen(process.env.PORT || 3000);

client.login(process.env.DISCORD_TOKEN);
