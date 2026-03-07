import EventEmitter from 'events';
import { createRequire } from 'module';
import { PassThrough } from 'stream';

import {
  AudioPlayer,
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} from '@discordjs/voice';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  GuildBasedChannel,
  GuildMember,
  PermissionsBitField,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Snowflake,
  type VoiceBasedChannel,
} from 'discord.js';
import prism from 'prism-media';

import { logger } from '../../logger.js';
import type {
  VoiceEvent,
  VoicePlatform,
  VoicePlatformAdapter,
} from '../types.js';

const VOICE_JOIN_COMMAND = 'voice-join';
const VOICE_LEAVE_COMMAND = 'voice-leave';
const require = createRequire(import.meta.url);

function hasAnyDiscordEncryptionLibrary(): boolean {
  const candidates = [
    'sodium-native',
    'sodium',
    'libsodium-wrappers',
    'tweetnacl',
  ];

  for (const pkg of candidates) {
    try {
      require.resolve(pkg);
      return true;
    } catch {
      // continue
    }
  }

  return false;
}

export function pcmStereo48kToMono24kForTest(buffer: Buffer): Buffer {
  const sampleCount = Math.floor(buffer.length / 4);
  const monoSamples = new Int16Array(Math.ceil(sampleCount / 2));
  let outIndex = 0;

  for (let i = 0; i < sampleCount; i += 2) {
    const byteIndex = i * 4;
    const left = buffer.readInt16LE(byteIndex);
    const right = buffer.readInt16LE(byteIndex + 2);
    monoSamples[outIndex++] = Math.round((left + right) / 2);
  }

  return Buffer.from(monoSamples.buffer, 0, outIndex * 2);
}

export function pcmMonoToDiscordStereo48kForTest(
  buffer: Buffer,
  sampleRate: number,
): Buffer {
  const monoSamples = buffer.length / 2;
  const ratio = 48000 / sampleRate;

  if (!Number.isInteger(ratio) || ratio <= 0) {
    throw new Error(
      `Unsupported sample rate for Discord output: ${sampleRate}`,
    );
  }

  const stereo = Buffer.alloc(monoSamples * ratio * 4);
  let offset = 0;

  for (let i = 0; i < monoSamples; i++) {
    const sample = buffer.readInt16LE(i * 2);
    for (let r = 0; r < ratio; r++) {
      stereo.writeInt16LE(sample, offset);
      stereo.writeInt16LE(sample, offset + 2);
      offset += 4;
    }
  }

  return stereo;
}

interface ActiveDiscordSession {
  sessionId: string;
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  outputStream: PassThrough;
  outputResource: ReturnType<typeof createAudioResource>;
  subscribedUsers: Set<string>;
}

export class DiscordGatewayVoiceTransport {
  private readonly emitter = new EventEmitter();

  private readonly sessions = new Map<string, ActiveDiscordSession>();

  private readonly client: Client;

  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly token: string,
    private readonly commandGuildId?: string,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.on('voiceStateUpdate', (oldState, newState) => {
      void this.handleVoiceStateUpdate(oldState, newState);
    });

    this.client.on('raw', (packet: any) => {
      if (
        packet?.t === 'VOICE_STATE_UPDATE' ||
        packet?.t === 'VOICE_SERVER_UPDATE'
      ) {
        logger.debug(
          {
            event: packet.t,
            guildId: packet.d?.guild_id,
            channelId: packet.d?.channel_id,
            userId: packet.d?.user_id,
            endpoint: packet.d?.endpoint,
            tokenPresent: Boolean(packet.d?.token),
            sessionIdPresent: Boolean(packet.d?.session_id),
          },
          'Received Discord raw voice gateway event',
        );
      }
    });
  }

  getClient(): Client {
    return this.client;
  }

  async connect(): Promise<void> {
    if (this.readyPromise) {
      logger.debug('Reusing existing Discord voice client connection promise');
      return await this.readyPromise;
    }

    logger.info(
      { report: generateDependencyReport() },
      'Discord voice dependency report',
    );

    logger.info(
      {
        commandGuildId: this.commandGuildId,
      },
      'Connecting Discord voice transport',
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.client.once('ready', async () => {
        try {
          // Register slash commands for voice functionality
          // Note: The Chat SDK has its own handlers for other commands (clear, status, etc.)
          // but voice commands are Discord-specific and handled here
          await this.registerCommands();
          logger.info(
            {
              botUserId: this.client.user?.id,
              botUsername: this.client.user?.username,
            },
            'Discord voice transport ready',
          );
          resolve();
        } catch (err) {
          logger.error({ err }, 'Failed to initialize Discord voice transport');
          reject(err);
        }
      });
      this.client.once('error', (err) => {
        logger.error({ err }, 'Discord client emitted an error during startup');
        reject(err);
      });
    });

    await this.client.login(this.token);
    return await this.readyPromise;
  }

  async startDirectSession(targetId: string): Promise<{ sessionId: string }> {
    logger.debug({ targetId }, 'Starting Discord direct voice session');
    return await this.joinExistingSession(targetId);
  }

  async joinExistingSession(targetId: string): Promise<{ sessionId: string }> {
    const [guildId, channelId] = targetId.split(':');
    if (!guildId || !channelId) {
      throw new Error(
        'Discord targetId must be in the form "guildId:channelId"',
      );
    }

    if (!hasAnyDiscordEncryptionLibrary()) {
      throw new Error(
        'Discord voice requires an encryption dependency. Install one of: sodium-native, sodium, libsodium-wrappers, or tweetnacl.',
      );
    }

    const channel = await this.fetchVoiceChannel(guildId, channelId);
    const sessionId = `${guildId}:${channelId}`;

    logger.info(
      { guildId, channelId, sessionId, targetId },
      'Joining Discord voice channel',
    );

    if (this.sessions.has(sessionId)) {
      logger.warn({ sessionId }, 'Discord voice session already active');
      return { sessionId };
    }

    const botMember =
      channel.guild.members.me ?? (await channel.guild.members.fetchMe());
    const perms = channel.permissionsFor(botMember);
    if (!perms) {
      throw new Error(
        `Cannot resolve bot permissions for voice channel ${channelId}`,
      );
    }

    const missingPermissions: string[] = [];
    if (!perms.has(PermissionsBitField.Flags.ViewChannel)) {
      missingPermissions.push('ViewChannel');
    }
    if (!perms.has(PermissionsBitField.Flags.Connect)) {
      missingPermissions.push('Connect');
    }
    if (!perms.has(PermissionsBitField.Flags.Speak)) {
      missingPermissions.push('Speak');
    }

    if (missingPermissions.length > 0) {
      throw new Error(
        `Missing Discord voice permissions in <#${channelId}>: ${missingPermissions.join(', ')}`,
      );
    }

    if (
      'userLimit' in channel &&
      typeof channel.userLimit === 'number' &&
      channel.userLimit > 0 &&
      channel.members.size >= channel.userLimit &&
      !channel.members.has(botMember.id)
    ) {
      throw new Error(
        `Discord voice channel <#${channelId}> is full (${channel.members.size}/${channel.userLimit}).`,
      );
    }

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
    });

    connection.on('debug', (message) => {
      logger.debug(
        { sessionId, guildId, channelId, message },
        'Discord voice connection debug',
      );
    });

    const stateTransitions: string[] = [connection.state.status];
    connection.on('stateChange', (oldState, newState) => {
      const oldDetails = oldState as {
        status: string;
        reason?: string;
        closeCode?: number;
      };
      const newDetails = newState as {
        status: string;
        reason?: string;
        closeCode?: number;
      };
      stateTransitions.push(newState.status);
      logger.debug(
        {
          sessionId,
          guildId,
          channelId,
          oldState: oldState.status,
          newState: newState.status,
          oldReason: oldDetails.reason,
          newReason: newDetails.reason,
          oldCloseCode: oldDetails.closeCode,
          newCloseCode: newDetails.closeCode,
        },
        'Discord voice connection state changed',
      );
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      logger.error(
        {
          err,
          sessionId,
          guildId,
          channelId,
          stateTransitions,
        },
        'Discord voice connection failed to reach ready state',
      );
      connection.destroy();
      throw new Error(
        `Timed out connecting to Discord voice channel <#${channelId}>. States: ${stateTransitions.join(' -> ')}. Check bot permissions and voice channel access.`,
      );
    }

    logger.info(
      { sessionId, guildId, channelId },
      'Discord voice connection ready',
    );

    const player = createAudioPlayer();
    const outputStream = new PassThrough();
    const outputResource = createAudioResource(outputStream, {
      inputType: StreamType.Raw,
      inlineVolume: false,
    });
    player.play(outputResource);
    connection.subscribe(player);

    const active: ActiveDiscordSession = {
      sessionId,
      guildId,
      channelId,
      connection,
      player,
      outputStream,
      outputResource,
      subscribedUsers: new Set(),
    };
    this.sessions.set(sessionId, active);

    connection.receiver.speaking.on('start', (userId) => {
      this.emitter.emit('event', {
        type: 'speech.started',
        sessionId,
        participantId: userId,
      } satisfies VoiceEvent);
      this.subscribeToUserAudio(active, userId);
    });

    connection.receiver.speaking.on('end', (userId) => {
      this.emitter.emit('event', {
        type: 'speech.stopped',
        sessionId,
        participantId: userId,
      } satisfies VoiceEvent);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      logger.warn({ sessionId }, 'Discord voice connection disconnected');
      this.cleanupSession(sessionId, 'disconnected');
    });

    player.on(AudioPlayerStatus.Idle, () => {
      // Keep a long-lived player alive by immediately attaching a fresh stream.
      if (!this.sessions.has(sessionId)) {
        return;
      }
      logger.debug(
        { sessionId },
        'Discord audio player went idle; resetting output stream',
      );
      this.resetOutputStream(sessionId);
    });

    for (const member of channel.members.values()) {
      this.emitter.emit('event', {
        type: 'participant.joined',
        sessionId,
        participantId: member.id,
        displayName: member.displayName,
      } satisfies VoiceEvent);
    }

    this.emitter.emit('event', {
      type: 'session.started',
      sessionId,
      platform: 'discord',
    } satisfies VoiceEvent);

    logger.info(
      {
        sessionId,
        guildId,
        channelId,
        memberCount: channel.members.size,
      },
      'Discord voice session started',
    );

    return { sessionId };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn(
        { sessionId },
        'Attempted to stop unknown Discord voice session',
      );
      return;
    }

    logger.info(
      { sessionId, guildId: session.guildId, channelId: session.channelId },
      'Stopping Discord voice session',
    );

    session.outputStream.end();
    session.player.stop();
    session.connection.destroy();
    this.sessions.delete(sessionId);
    this.emitter.emit('event', {
      type: 'session.ended',
      sessionId,
      reason: 'stopped',
    } satisfies VoiceEvent);
  }

  async sendAudio(
    sessionId: string,
    pcm16: Buffer,
    sampleRate: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.error(
        { sessionId },
        'Attempted to send audio to unknown Discord session',
      );
      throw new Error(`Unknown Discord voice session ${sessionId}`);
    }

    const discordPcm = pcmMonoToDiscordStereo48kForTest(pcm16, sampleRate);
    session.outputStream.write(discordPcm);
  }

  async interruptOutput(sessionId: string): Promise<void> {
    logger.debug({ sessionId }, 'Interrupting Discord voice output');
    this.resetOutputStream(sessionId);
  }

  onEvent(handler: (event: VoiceEvent) => void): void {
    this.emitter.on('event', handler);
  }

  private async registerCommands(): Promise<void> {
    const applicationId = this.client.application?.id;
    if (!applicationId) {
      return;
    }

    const commands = [
      new SlashCommandBuilder()
        .setName(VOICE_JOIN_COMMAND)
        .setDescription('Join your current Discord voice channel'),
      new SlashCommandBuilder()
        .setName(VOICE_LEAVE_COMMAND)
        .setDescription(
          'Leave the active NanoClaw voice session in this guild',
        ),
    ].map((command) => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(this.token);

    if (this.commandGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(applicationId, this.commandGuildId),
        { body: commands },
      );
      logger.info(
        { guildId: this.commandGuildId },
        'Registered Discord voice guild commands',
      );
      return;
    }

    await rest.put(Routes.applicationCommands(applicationId), {
      body: commands,
    });
    logger.info('Registered Discord voice global commands');
  }

  private async fetchVoiceChannel(
    guildId: string,
    channelId: string,
  ): Promise<VoiceBasedChannel> {
    logger.debug({ guildId, channelId }, 'Fetching Discord voice channel');
    const guild = await this.client.guilds.fetch(guildId);
    const channel = (await guild.channels.fetch(
      channelId,
    )) as GuildBasedChannel | null;

    if (!channel || !this.isVoiceChannel(channel)) {
      logger.error(
        { guildId, channelId },
        'Discord target channel is not voice-capable',
      );
      throw new Error(`Channel ${channelId} is not a Discord voice channel`);
    }

    return channel;
  }

  private isVoiceChannel(
    channel: GuildBasedChannel,
  ): channel is VoiceBasedChannel {
    return (
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice
    );
  }

  private subscribeToUserAudio(
    session: ActiveDiscordSession,
    userId: string,
  ): void {
    if (session.subscribedUsers.has(userId)) {
      logger.debug(
        { sessionId: session.sessionId, userId },
        'Already subscribed to Discord user audio',
      );
      return;
    }

    logger.debug(
      { sessionId: session.sessionId, userId },
      'Subscribing to Discord user audio',
    );
    session.subscribedUsers.add(userId);
    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 100,
      },
    });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48000,
    });

    opusStream.pipe(decoder);
    decoder.on('data', (chunk: Buffer) => {
      this.emitter.emit('event', {
        type: 'audio.input',
        sessionId: session.sessionId,
        participantId: userId,
        pcm16: pcmStereo48kToMono24kForTest(chunk),
        sampleRate: 24000,
      } satisfies VoiceEvent);
    });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      logger.debug(
        { sessionId: session.sessionId, userId },
        'Cleaning up Discord user audio subscription',
      );
      session.subscribedUsers.delete(userId);
      decoder.removeAllListeners();
    };

    opusStream.once('end', cleanup);
    opusStream.once('close', cleanup);
    opusStream.once('error', (err) => {
      logger.warn(
        { err, sessionId: session.sessionId, userId },
        'Discord user audio stream errored',
      );
      cleanup();
    });
  }

  private async handleVoiceStateUpdate(
    oldState: {
      channelId: Snowflake | null;
      member: GuildMember | null;
      guild: { id: string };
    },
    newState: {
      channelId: Snowflake | null;
      member: GuildMember | null;
      guild: { id: string };
    },
  ): Promise<void> {
    const guildId = newState.guild.id;
    for (const session of this.sessions.values()) {
      if (session.guildId !== guildId) {
        continue;
      }

      if (
        oldState.channelId !== session.channelId &&
        newState.channelId === session.channelId
      ) {
        if (newState.member) {
          logger.info(
            {
              sessionId: session.sessionId,
              participantId: newState.member.id,
              channelId: session.channelId,
            },
            'Discord participant joined active voice channel',
          );
          this.emitter.emit('event', {
            type: 'participant.joined',
            sessionId: session.sessionId,
            participantId: newState.member.id,
            displayName: newState.member.displayName,
          } satisfies VoiceEvent);
        }
      }

      if (
        oldState.channelId === session.channelId &&
        newState.channelId !== session.channelId
      ) {
        if (oldState.member) {
          logger.info(
            {
              sessionId: session.sessionId,
              participantId: oldState.member.id,
              channelId: session.channelId,
            },
            'Discord participant left active voice channel',
          );
          this.emitter.emit('event', {
            type: 'participant.left',
            sessionId: session.sessionId,
            participantId: oldState.member.id,
          } satisfies VoiceEvent);
        }
      }
    }
  }

  private cleanupSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    logger.warn(
      {
        sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        reason,
      },
      'Cleaning up Discord voice session',
    );

    session.outputStream.end();
    session.player.stop();
    this.sessions.delete(sessionId);
    this.emitter.emit('event', {
      type: 'session.ended',
      sessionId,
      reason,
    } satisfies VoiceEvent);
  }

  private resetOutputStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn(
        { sessionId },
        'Attempted to reset output stream for unknown Discord session',
      );
      return;
    }

    logger.debug({ sessionId }, 'Resetting Discord output stream');

    session.outputStream.end();
    session.outputStream = new PassThrough();
    session.outputResource = createAudioResource(session.outputStream, {
      inputType: StreamType.Raw,
      inlineVolume: false,
    });
    session.player.play(session.outputResource);
    session.connection.subscribe(session.player);
  }
}

export class DiscordVoiceAdapter implements VoicePlatformAdapter {
  readonly platform: VoicePlatform = 'discord';

  constructor(private readonly transport: DiscordGatewayVoiceTransport) {}

  async connect(): Promise<void> {
    await this.transport.connect();
  }

  async startDirectSession(targetId: string): Promise<{ sessionId: string }> {
    return await this.transport.startDirectSession(targetId);
  }

  async joinExistingSession(targetId: string): Promise<{ sessionId: string }> {
    return await this.transport.joinExistingSession(targetId);
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.transport.stopSession(sessionId);
  }

  async sendAudio(
    sessionId: string,
    pcm16: Buffer,
    sampleRate: number,
  ): Promise<void> {
    await this.transport.sendAudio(sessionId, pcm16, sampleRate);
  }

  async interruptOutput(sessionId: string): Promise<void> {
    await this.transport.interruptOutput(sessionId);
  }

  onEvent(handler: (event: VoiceEvent) => void): void {
    this.transport.onEvent(handler);
  }
}

export function isDiscordVoiceJoinCommand(
  interaction: ChatInputCommandInteraction,
): boolean {
  return interaction.commandName === VOICE_JOIN_COMMAND;
}

export function isDiscordVoiceLeaveCommand(
  interaction: ChatInputCommandInteraction,
): boolean {
  return interaction.commandName === VOICE_LEAVE_COMMAND;
}
