import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Interaction,
} from 'discord.js';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { resolveAgentId } from '../router.js';
import { saveAttachment, buildMediaNote } from '../attachments/store.js';
import type { Attachment } from '../types.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  executeCommand: (
    chatJid: string,
    command: 'clear' | 'status' | 'update' | string,
    sender?: string,
  ) => Promise<string>;
}

// Slash command definitions
const CLEAR_COMMAND = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Clear the conversation session and start fresh');

const STATUS_COMMAND = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show current agent status and session information');

const CHATID_COMMAND = new SlashCommandBuilder()
  .setName('chatid')
  .setDescription('Get the Discord channel ID for routing configuration');

const UPDATE_COMMAND = new SlashCommandBuilder()
  .setName('update')
  .setDescription(
    'Update the bot by pulling latest code, installing deps, and restarting',
  );

const COMMANDS = [
  CLEAR_COMMAND,
  STATUS_COMMAND,
  CHATID_COMMAND,
  UPDATE_COMMAND,
];

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private processingMessages: Map<
    string,
    { messageId: string; timeout: NodeJS.Timeout }
  > = new Map();
  // Track typing intervals per channel to keep typing indicator alive
  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private async addAcknowledgement(
    jid: string,
    message: Message,
  ): Promise<void> {
    try {
      await message.react('👀');

      // Set a safety timeout to auto-remove reaction after 5 minutes
      const timeout = setTimeout(
        () => {
          this.clearAcknowledgement(jid);
        },
        5 * 60 * 1000,
      );

      this.processingMessages.set(jid, { messageId: message.id, timeout });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to add acknowledgement reaction');
    }
  }

  private async clearAcknowledgement(jid: string): Promise<void> {
    const entry = this.processingMessages.get(jid);
    if (!entry) return;

    clearTimeout(entry.timeout);

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client?.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;

      const textChannel = channel as TextChannel;
      const message = await textChannel.messages.fetch(entry.messageId);
      if (message) {
        // Remove the bot's own reaction (👀)
        await message.reactions.cache
          .get('👀')
          ?.users.remove(this.client?.user?.id || '');
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to clear acknowledgement reaction');
    } finally {
      this.processingMessages.delete(jid);
    }
  }

  private async registerCommands(): Promise<void> {
    if (!this.client?.user) {
      logger.warn('Cannot register commands: client not ready');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(this.botToken);
    const clientId = this.client.user.id;

    try {
      // Get all guilds the bot is in
      const guilds = await this.client.guilds.fetch();

      logger.info(
        { guildCount: guilds.size },
        'Registering slash commands for guilds',
      );

      for (const [guildId] of guilds) {
        try {
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
            body: COMMANDS.map((cmd) => cmd.toJSON()),
          });
          logger.debug({ guildId }, 'Registered commands for guild');
        } catch (err) {
          logger.warn(
            { guildId, err },
            'Failed to register commands for guild',
          );
        }
      }

      logger.info('Slash commands registered successfully');
    } catch (err) {
      logger.error({ err }, 'Failed to register slash commands');
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const chatJid = `dc:${interaction.channelId}`;
    const commandName = interaction.commandName;

    logger.info(
      { command: commandName, chatJid, user: interaction.user.tag },
      'Discord slash command received',
    );

    try {
      if (commandName === 'chatid') {
        await interaction.reply({
          content: `This channel's ID is: \`${interaction.channelId}\`

Add this to your \\\`ROUTES\\\` in \\\`src/router.ts\\\`:
\`\`\`typescript
'dc:${interaction.channelId}': 'main',
\`\`\``,
          ephemeral: true,
        });
        return;
      }

      // For clear, status, and update, use the existing command execution logic
      if (
        commandName === 'clear' ||
        commandName === 'status' ||
        commandName === 'update'
      ) {
        // Defer reply since command execution might take a moment
        await interaction.deferReply({ ephemeral: true });

        const senderId = `discord:${interaction.user.id}`;
        const response = await this.opts.executeCommand(
          chatJid,
          commandName,
          senderId,
        );

        await interaction.editReply({
          content: response,
        });
        return;
      }
    } catch (err) {
      logger.error(
        { err, command: commandName },
        'Error handling slash command',
      );

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({
          content: 'An error occurred while processing the command.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while processing the command.',
          ephemeral: true,
        });
      }
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      const rawContent = content;
      let isBotMentioned = false;

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      logger.info(
        {
          chatJid,
          channelId,
          sender: senderName,
          isBotMentioned,
          hasTrigger: TRIGGER_PATTERN.test(content),
          messageId: msgId,
          rawLength: rawContent.length,
        },
        'Discord message received',
      );

      // Handle attachments — download and store with media notes
      const attachments: Attachment[] = [];
      const mediaNotes: string[] = [];

      if (message.attachments.size > 0) {
        for (const att of message.attachments.values()) {
          try {
            // Download from Discord CDN with 30 second timeout
            const response = await fetch(att.url, {
              signal: AbortSignal.timeout(30000),
            });
            if (!response.ok) {
              logger.warn(
                { attachment: att.name, status: response.status },
                'Failed to download Discord attachment',
              );
              mediaNotes.push(
                `[File: ${att.name || 'file'} - download failed]`,
              );
              continue;
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const mimeType = att.contentType || 'application/octet-stream';

            // Save to filesystem
            const attachment = await saveAttachment(
              buffer,
              att.name || 'attachment',
              mimeType,
            );
            attachments.push(attachment);

            // Build media note
            mediaNotes.push(buildMediaNote(attachment));
          } catch (err) {
            logger.error(
              {
                attachment: att.name,
                attachmentUrl: att.url,
                attachmentSize: att.size,
                error: err instanceof Error ? err.message : String(err),
                errorStack: err instanceof Error ? err.stack : undefined,
                errorCode: (err as any)?.code,
                errorStatus: (err as any)?.status,
                chatJid,
              },
              'Error processing Discord attachment',
            );
            mediaNotes.push(`[File: ${att.name || 'file'} - error processing]`);
          }
        }

        // Append media notes to content
        if (mediaNotes.length > 0) {
          if (content) {
            content = `${content}\n\n${mediaNotes.join('\n')}`;
          } else {
            content = mediaNotes.join('\n');
          }
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const agentId = resolveAgentId(chatJid);
      if (!agentId) {
        logger.info(
          { chatJid, chatName },
          'Discord channel not routed; message ignored',
        );
        return;
      }

      // Add acknowledgement reaction to show we're processing
      await this.addAcknowledgement(chatJid, message);

      // Deliver message — startMessageLoop() will pick it up
      // Note: Attachment metadata is stored by the onMessage handler in index.ts
      logger.info(
        { chatJid, chatName, sender: senderName, agentId, messageId: msgId },
        'Dispatching inbound message',
      );
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, agentId },
        'Discord message stored',
      );
    });

    // Handle slash command interactions
    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      this.handleInteraction(interaction);
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err: Error) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(
        Events.ClientReady,
        async (readyClient: Client<true>) => {
          logger.info(
            { username: readyClient.user.tag, id: readyClient.user.id },
            'Discord bot connected',
          );
          console.log(`\n  Discord bot: ${readyClient.user.tag}`);
          console.log(`  Slash commands will be registered automatically\n`);

          // Register slash commands for all guilds
          await this.registerCommands();

          resolve();
        },
      );

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    // Clear acknowledgement reaction before sending response
    await this.clearAcknowledgement(jid);

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error(
        {
          jid,
          error: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          errorCode: (err as any)?.code,
          errorStatus: (err as any)?.status,
          textLength: text.length,
        },
        'Failed to send Discord message',
      );
    }
  }

  async sendMessageWithAttachments(
    jid: string,
    text: string,
    filePaths: string[],
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    // Clear acknowledgement reaction before sending response
    await this.clearAcknowledgement(jid);

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Prepare file attachments
      const attachments = filePaths.map((filePath) => ({
        attachment: filePath,
        name: path.basename(filePath),
      }));

      // Send message with attachments
      // Discord has a 2000 character limit for text with files too
      const MAX_LENGTH = 2000;
      const content =
        text.length <= MAX_LENGTH ? text : text.slice(0, MAX_LENGTH);

      await textChannel.send({
        content: content || undefined,
        files: attachments,
      });

      // If text was truncated, send remaining text as follow-up
      if (text.length > MAX_LENGTH) {
        for (let i = MAX_LENGTH; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }

      logger.info(
        { jid, fileCount: filePaths.length, textLength: text.length },
        'Discord message with attachments sent',
      );
    } catch (err) {
      logger.error(
        {
          jid,
          error: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          errorCode: (err as any)?.code,
          errorStatus: (err as any)?.status,
          fileCount: filePaths.length,
          filePaths,
        },
        'Failed to send Discord message with attachments',
      );
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals before disconnect
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    // Clear existing interval if any
    const existingInterval = this.typingIntervals.get(jid);
    if (existingInterval) {
      clearInterval(existingInterval);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    // Send initial typing indicator
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      return;
    }

    // Set up interval to keep typing alive (Discord typing expires after ~10 seconds)
    const interval = setInterval(async () => {
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client?.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug(
          { jid, err },
          'Failed to maintain Discord typing indicator',
        );
      }
    }, 8000); // Refresh every 8 seconds

    this.typingIntervals.set(jid, interval);
  }
}
