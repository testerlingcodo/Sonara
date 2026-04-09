const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const { constants: ytdlConstants } = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const ytSearch = require('yt-search');
require('dotenv').config();

const PREFIX = '!s';

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
      const audioUrl = await new Promise((resolve, reject) => {
        const proc = spawn(ytdlConstants.YOUTUBE_DL_PATH, [song.url, '--get-url', '-f', 'bestaudio']);
        let out = '', err = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('close', code => {
          const line = out.trim().split('\n')[0];
          if (code === 0 && line) resolve(line);
          else reject(new Error(`yt-dlp error: ${err.trim() || code}`));
        });
      });

      const eqFilter = this.vocalGain > 0
        ? ['-af', `equalizer=f=1000:width_type=o:width=2:g=${Math.round(this.vocalGain / 2)},equalizer=f=2500:width_type=o:width=2:g=${this.vocalGain}`]
        : [];

      const ffmpegProc = spawn(ffmpegPath, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl,
        '-vn', ...eqFilter, '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      ffmpegProc.stderr.on('data', d => console.error('ffmpeg:', d.toString().trim()));

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

client.login(process.env.DISCORD_TOKEN);
