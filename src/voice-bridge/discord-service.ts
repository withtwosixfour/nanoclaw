import { GuildMember, type ChatInputCommandInteraction } from 'discord.js';

import { logger } from '../logger.js';
import {
  DiscordGatewayVoiceTransport,
  DiscordVoiceAdapter,
  isDiscordVoiceJoinCommand,
  isDiscordVoiceLeaveCommand,
} from './adapters/discord.js';
import type { VoiceBridgeSessionManager } from './core/session-manager.js';

function getInteractionVoiceChannel(
  interaction: ChatInputCommandInteraction,
): { guildId: string; channelId: string; member: GuildMember } | null {
  if (!interaction.inGuild() || !interaction.guildId) {
    return null;
  }

  const member = interaction.member;
  if (!member || !(member instanceof GuildMember)) {
    return null;
  }

  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    return null;
  }

  return {
    guildId: interaction.guildId,
    channelId: voiceChannel.id,
    member,
  };
}

export async function createDiscordVoiceIntegration(
  manager: VoiceBridgeSessionManager,
): Promise<DiscordVoiceAdapter | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    return null;
  }

  const transport = new DiscordGatewayVoiceTransport(
    token,
    process.env.DISCORD_VOICE_COMMAND_GUILD_ID,
  );
  const adapter = new DiscordVoiceAdapter(transport);

  transport.getClient().on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (isDiscordVoiceJoinCommand(interaction)) {
      const voiceState = getInteractionVoiceChannel(interaction);
      if (!voiceState) {
        await interaction.reply({
          content: 'Join a voice channel first, then run `/voice-join`.',
          ephemeral: true,
        });
        return;
      }

      const platformSessionId = `${voiceState.guildId}:${voiceState.channelId}`;
      const existing = manager.findActiveSessionByPlatform(
        'discord',
        platformSessionId,
      );
      if (existing) {
        await interaction.reply({
          content: `NanoClaw is already active in <#${voiceState.channelId}>.`,
          ephemeral: true,
        });
        return;
      }

      const participants = Array.from(
        voiceState.member.voice.channel!.members.values(),
      ).map((member) => ({
        participantId: member.id,
        displayName: member.displayName,
      }));

      const routeKey = `voice:discord:${voiceState.guildId}:${voiceState.channelId}`;
      const linkedTextThreadId = interaction.channelId
        ? `discord:${voiceState.guildId}:${interaction.channelId}`
        : undefined;

      try {
        await manager.startSession({
          platform: 'discord',
          mode: 'join',
          targetId: platformSessionId,
          routeKey,
          startedBy: interaction.user.id,
          participants,
          link: linkedTextThreadId
            ? { textThreadId: linkedTextThreadId }
            : undefined,
          metadata: {
            summonChannelId: interaction.channelId,
            guildId: voiceState.guildId,
            voiceChannelId: voiceState.channelId,
          },
        });

        await interaction.reply({
          content: `Joining <#${voiceState.channelId}> and starting a realtime voice session.`,
          ephemeral: true,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to start Discord voice session');
        await interaction.reply({
          content: `Failed to join voice: ${err instanceof Error ? err.message : String(err)}`,
          ephemeral: true,
        });
      }
      return;
    }

    if (isDiscordVoiceLeaveCommand(interaction)) {
      const voiceState = getInteractionVoiceChannel(interaction);
      const platformSessionId = voiceState
        ? `${voiceState.guildId}:${voiceState.channelId}`
        : interaction.guildId
          ? manager
              .listActiveSessions()
              .find(
                (session) =>
                  session.platform === 'discord' &&
                  session.platformSessionId.startsWith(
                    `${interaction.guildId}:`,
                  ),
              )?.platformSessionId
          : undefined;

      if (!platformSessionId) {
        await interaction.reply({
          content: 'No active NanoClaw voice session found in this guild.',
          ephemeral: true,
        });
        return;
      }

      const existing = manager.findActiveSessionByPlatform(
        'discord',
        platformSessionId,
      );
      if (!existing) {
        await interaction.reply({
          content: 'No active NanoClaw voice session found for that channel.',
          ephemeral: true,
        });
        return;
      }

      await manager.stopSession(existing.voiceSessionId);
      await interaction.reply({
        content: 'Leaving the active NanoClaw voice session.',
        ephemeral: true,
      });
    }
  });

  return adapter;
}
