import { oneLine } from 'common-tags';
import { ButtonStyle, CommandContext, CommandOptionType, ComponentType, SlashCreator } from 'slash-create';

import Recording from '../modules/recorder/recording';
import { checkMaintenance, processCooldown } from '../redis';
import GeneralCommand from '../slashCommand';
import { checkBan, checkRecordingPermission, cutoffText, makeDownloadMessage, parseRewards } from '../util';

export default class Join extends GeneralCommand {
  constructor(creator: SlashCreator) {
    super(creator, {
      name: 'join',
      description: 'Start recording in a channel.',
      dmPermission: false,
      options: [
        {
          type: CommandOptionType.CHANNEL,
          name: 'channel',
          description: 'The channel to record in.',
          channel_types: [2, 13]
        }
      ]
    });

    this.filePath = __filename;
  }

  async run(ctx: CommandContext) {
    if (!ctx.guildID) return 'This command can only be used in a guild.';
    const guild = this.client.bot.guilds.get(ctx.guildID)!;

    if (await checkBan(ctx.user.id))
      return {
        content: 'You are not allowed to use the bot at this time.',
        ephemeral: true
      };

    const userCooldown = await processCooldown(`command:${ctx.user.id}`, 5, 3);
    if (userCooldown !== true)
      return {
        content: 'You are running commands too often! Try again in a few seconds.',
        ephemeral: true
      };

    const guildData = await this.prisma.guild.findFirst({ where: { id: ctx.guildID } });
    const hasPermission = checkRecordingPermission(ctx.member!, guildData);
    if (!hasPermission)
      return {
        content: 'You need the `Manage Server` permission or have an access role to manage recordings.',
        ephemeral: true
      };
    const member = guild.members.get(ctx.user.id) || (await guild.fetchMembers({ userIDs: [ctx.user.id] }))[0];

    // Check for existing recording
    if (this.recorder.recordings.has(ctx.guildID)) {
      const recording = this.recorder.recordings.get(ctx.guildID)!;
      if (recording.messageID && recording.messageChannelID) {
        const message = await this.client.bot.getMessage(recording.messageChannelID, recording.messageID).catch(() => null);
        if (message)
          return {
            content: 'Already recording in this guild.',
            ephemeral: true,
            components: [
              {
                type: ComponentType.ACTION_ROW,
                components: [
                  {
                    type: ComponentType.BUTTON,
                    style: ButtonStyle.LINK,
                    label: 'Jump to recording panel',
                    url: `https://discordapp.com/channels/${ctx.guildID}/${recording.messageChannelID}/${recording.messageID}`,
                    emoji: { id: '949782524131942460' }
                  }
                ]
              }
            ]
          };
      }
      await ctx.send(recording.messageContent() as any);
      const { id: messageID } = await ctx.fetch();
      recording.messageID = messageID;
      recording.messageChannelID = ctx.channelID;
      return;
    }

    // Check channel
    let channel = guild.channels.get(ctx.options.channel);
    if (!channel && member?.voiceState?.channelID) channel = guild.channels.get(member.voiceState.channelID);
    else if (!channel)
      return {
        content: 'Please specify a channel to record in, or join a channel.',
        ephemeral: true
      };
    if (channel!.type !== 2 && channel!.type !== 13)
      return {
        content: 'That channel is not a voice channel.',
        ephemeral: true
      };

    // Check permissions
    if (!channel!.permissionsOf(this.client.bot.user.id).has('voiceConnect'))
      return {
        content: `I do not have permission to connect to <#${channel!.id}>.`,
        ephemeral: true
      };
    if (!guild.permissionsOf(this.client.bot.user.id).has('changeNickname'))
      return {
        content: 'I do not have permission to change my nickname. I will not record without this permission.',
        ephemeral: true
      };

    // Check for maintenence
    const maintenence = await checkMaintenance(this.client.bot.user.id);
    if (maintenence)
      return {
        content: `⚠️ __The bot is currently undergoing maintenance. Please try again later.__\n\n${maintenence.message}`,
        ephemeral: true
      };

    // Check guild-wide cooldown
    const guildCooldown = await processCooldown(`join:guild:${ctx.guildID}`, 30, 2);
    if (guildCooldown !== true)
      return {
        content: 'This server is recording too often! Try again in a few seconds.',
        ephemeral: true
      };

    // Get rewards
    const userData = await this.prisma.user.findFirst({ where: { id: ctx.user.id } });
    const blessing = await this.prisma.blessing.findFirst({ where: { guildId: guild.id } });
    const blessingUser = blessing ? await this.prisma.user.findFirst({ where: { id: blessing.userId } }) : null;
    const parsedRewards = parseRewards(this.recorder.client.config, userData?.rewardTier ?? 0, blessingUser?.rewardTier ?? 0);

    // Check if user can record
    if (parsedRewards.rewards.recordHours <= 0)
      return {
        content: 'Sorry, but this bot is only for patrons. Please use Craig.',
        components: [
          {
            type: ComponentType.ACTION_ROW,
            components: [
              {
                type: ComponentType.BUTTON,
                style: ButtonStyle.LINK,
                label: 'craig.chat',
                url: 'https://craig.chat/'
              }
            ]
          }
        ],
        ephemeral: true
      };

    // Check for DM permissions
    const dmChannel = await member.user.getDMChannel().catch(() => null);
    if (!dmChannel) {
      return {
        content: "I can't DM you, so I can't record. I need to be able to DM you to send you the download link.",
        ephemeral: true
      };
    }

    // Nickname the bot
    const selfUser = (await guild.fetchMembers({ userIDs: [this.client.bot.user.id] }))[0];
    const recNick = cutoffText(`![RECORDING] ${selfUser.nick ?? selfUser.username}`, 32);
    await ctx.defer();
    let nickChanged = false;
    if (!selfUser.nick || !selfUser.nick.includes('[RECORDING]'))
      try {
        const nickWarnTimeout = setTimeout(() => {
          if (!nickChanged)
            ctx.editOriginal(oneLine`
              It's taking a while for me to change my nickname to indicate that I'm recording.
              I cannot start recording until I've changed my nickname. Please be patient.
            `);
        }, 3000) as unknown as number;
        await this.client.bot.editGuildMember(ctx.guildID, '@me', { nick: recNick }, 'Setting recording status');
        nickChanged = true;
        clearTimeout(nickWarnTimeout);
      } catch (e) {
        nickChanged = true;
        this.client.commands.logger.error('Failed to change nickname', e);
        return `An error occurred while changing my nickname: ${e}`;
      }

    // Start recording
    const recording = new Recording(this.recorder, channel as any, member.user);
    this.recorder.recordings.set(ctx.guildID, recording);
    await ctx.editOriginal(recording.messageContent() as any);
    const { id: messageID } = await ctx.fetch();
    recording.messageID = messageID;
    recording.messageChannelID = ctx.channelID;
    await recording.start(parsedRewards, userData?.webapp ?? false);

    // Send DM
    const dmMessage = await dmChannel.createMessage(makeDownloadMessage(recording, parsedRewards, this.client.config)).catch(() => null);

    if (dmMessage)
      await ctx.sendFollowUp({
        content: `Started recording in <#${channel!.id}>.`,
        ephemeral: true,
        components: [
          {
            type: ComponentType.ACTION_ROW,
            components: [
              {
                type: ComponentType.BUTTON,
                style: ButtonStyle.LINK,
                label: 'Jump to DM',
                url: `https://discord.com/channels/@me/${dmChannel.id}/${dmMessage.id}`,
                emoji: { id: '949782524131942460' }
              }
            ]
          }
        ]
      });
  }
}