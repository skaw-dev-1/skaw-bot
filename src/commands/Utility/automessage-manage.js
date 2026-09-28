import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, MessageFlags } from 'discord.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    formatDateTime,
    buildAutoMessagePayload,
    getAutoMessage,
    getGuildAutoMessages,
    saveGuildAutoMessages,
} from '../../services/autoMessageService.js';

const MAX_LIST_ITEMS = 15;


function requireManageGuild(interaction) {
    if (!interaction.inGuild()) {
        throw new TitanBotError(
            'Auto Message management used outside guild',
            ErrorTypes.VALIDATION,
            'This command can only be used in a server.',
            { userId: interaction.user.id },
        );
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        throw new TitanBotError(
            'User lacks ManageGuild permission',
            ErrorTypes.PERMISSION,
            "You need the 'Manage Server' permission to manage auto messages.",
            { userId: interaction.user.id, guildId: interaction.guildId },
        );
    }
}

function formatInterval(intervalMs, type) {
    if (type === 'once' || intervalMs == null) return 'Once';
    if (intervalMs % (7 * 24 * 60 * 60 * 1000) === 0) return `Every ${intervalMs / (7 * 24 * 60 * 60 * 1000)} week(s)`;
    if (intervalMs % (24 * 60 * 60 * 1000) === 0) return `Every ${intervalMs / (24 * 60 * 60 * 1000)} day(s)`;
    if (intervalMs % (60 * 60 * 1000) === 0) return `Every ${intervalMs / (60 * 60 * 1000)} hour(s)`;
    return `Every ${intervalMs / (60 * 1000)} minute(s)`;
}

async function assertCanSend(channel, guild) {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(me || guild.client.user);
    if (!permissions) throw new Error('Could not verify the bot permissions for the selected channel.');

    const required = PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages;
    if (!permissions.has(required)) {
        throw new Error('The bot needs View Channel and Send Messages permissions in the configured channel.');
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('automessage-manage')
        .setDescription('Manage existing automatic message schedules.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand => subcommand.setName('list').setDescription('List configured automatic messages.'))
        .addSubcommand(subcommand => subcommand
            .setName('view')
            .setDescription('View one automatic message configuration.')
            .addStringOption(option => option.setName('id').setDescription('Auto Message ID.').setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('enable')
            .setDescription('Enable an automatic message.')
            .addStringOption(option => option.setName('id').setDescription('Auto Message ID.').setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('disable')
            .setDescription('Disable an automatic message.')
            .addStringOption(option => option.setName('id').setDescription('Auto Message ID.').setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('delete')
            .setDescription('Delete an automatic message configuration.')
            .addStringOption(option => option.setName('id').setDescription('Auto Message ID.').setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('test')
            .setDescription('Send one automatic message immediately for testing.')
            .addStringOption(option => option.setName('id').setDescription('Auto Message ID.').setRequired(true))),

    async execute(interaction) {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        try {
            requireManageGuild(interaction);

            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guildId;

            if (subcommand === 'list') {
                const schedules = await getGuildAutoMessages(interaction.client, guildId);
                if (schedules.length === 0) {
                    return InteractionHelper.safeReply(interaction, {
                        embeds: [successEmbed('Auto Messages', 'No automatic messages are configured yet.')],
                    });
                }

                const lines = schedules.slice(0, MAX_LIST_ITEMS).map(schedule => {
                    const status = schedule.enabled ? '🟢 ON' : '⚪ OFF';
                    const next = schedule.nextRunAt ? formatDateTime(schedule.nextRunAt, schedule.timezone) : '—';
                    const interval = formatInterval(schedule.intervalMs, schedule.scheduleType);
                    return `${status} \`${schedule.id}\` → <#${schedule.channelId}> · ${interval} · next: ${next}`;
                });

                const extra = schedules.length > MAX_LIST_ITEMS
                    ? `\n…and ${schedules.length - MAX_LIST_ITEMS} more.`
                    : '';

                return InteractionHelper.safeReply(interaction, {
                    embeds: [successEmbed('Auto Messages', `${lines.join('\n')}${extra}`)],
                });
            }

            const id = interaction.options.getString('id')?.trim();
            const schedule = await getAutoMessage(interaction.client, guildId, id);

            if (!schedule) {
                return InteractionHelper.safeReply(interaction, {
                    embeds: [errorEmbed('Auto Message Not Found', `No automatic message with ID \`${id || 'unknown'}\` was found.`)],
                });
            }

            if (subcommand === 'view') {
                return InteractionHelper.safeReply(interaction, {
                    embeds: [{
                        title: `Auto Message • ${schedule.id}`,
                        description: schedule.message,
                        fields: [
                            { name: 'Channel', value: `<#${schedule.channelId}>`, inline: true },
                            { name: 'Status', value: schedule.enabled ? 'Enabled' : 'Disabled', inline: true },
                            { name: 'Type', value: schedule.messageType === 'embed' ? 'Embed Message' : 'Normal Text Message', inline: true },
                            { name: 'Interval', value: formatInterval(schedule.intervalMs, schedule.scheduleType), inline: true },
                            { name: 'Start', value: formatDateTime(schedule.startAt, schedule.timezone), inline: true },
                            { name: 'Next', value: schedule.nextRunAt ? formatDateTime(schedule.nextRunAt, schedule.timezone) : '—', inline: true },
                            { name: 'End', value: schedule.endAt ? formatDateTime(schedule.endAt, schedule.timezone) : 'No end', inline: true },
                            { name: 'Runs', value: String(schedule.runCount), inline: true },
                        ],
                        footer: { text: `Timezone: ${schedule.timezone}` },
                    }],
                });
            }

            if (subcommand === 'enable' || subcommand === 'disable') {
                schedule.enabled = subcommand === 'enable';

                if (schedule.enabled) {
                    const now = Date.now();
                    if (schedule.endAt && now >= schedule.endAt) {
                        throw new Error('This automatic message has already passed its end time. Create a new schedule.');
                    }
                    schedule.nextRunAt = schedule.nextRunAt && schedule.nextRunAt > now
                        ? schedule.nextRunAt
                        : now;
                } else {
                    schedule.nextRunAt = null;
                }

                schedule.updatedAt = new Date().toISOString();

                const all = await getGuildAutoMessages(interaction.client, guildId);
                await saveGuildAutoMessages(
                    interaction.client,
                    guildId,
                    all.map(item => item.id === schedule.id ? schedule : item),
                );

                return InteractionHelper.safeReply(interaction, {
                    embeds: [successEmbed(
                        `Auto Message ${schedule.enabled ? 'Enabled' : 'Disabled'} ✅`,
                        `\`${schedule.id}\` is now **${schedule.enabled ? 'enabled' : 'disabled'}**.`,
                    )],
                });
            }

            if (subcommand === 'delete') {
                const all = await getGuildAutoMessages(interaction.client, guildId);
                await saveGuildAutoMessages(
                    interaction.client,
                    guildId,
                    all.filter(item => item.id !== schedule.id),
                );

                return InteractionHelper.safeReply(interaction, {
                    embeds: [successEmbed('Auto Message Deleted ✅', `Removed \`${schedule.id}\` from the schedule list.`)],
                });
            }

            if (subcommand === 'test') {
                const channel = await interaction.client.channels.fetch(schedule.channelId).catch(() => null);
                if (!channel || !channel.isTextBased() || channel.isDMBased()) {
                    throw new Error('The configured channel is unavailable.');
                }

                await assertCanSend(channel, interaction.guild);
                const sent = await channel.send(buildAutoMessagePayload(schedule, interaction.guild));

                return InteractionHelper.safeReply(interaction, {
                    embeds: [successEmbed('Auto Message Test Sent ✅', `Message sent to ${channel}.\nMessage ID: \`${sent.id}\``)],
                });
            }

            throw new Error(`Unsupported subcommand: ${subcommand}`);
        } catch (error) {
            logger.error('Auto Message management error:', error);

            const description = error instanceof TitanBotError
                ? error.publicMessage || error.message
                : error.message || 'An error occurred while managing auto messages.';

            return InteractionHelper.safeReply(interaction, {
                embeds: [errorEmbed('Auto Message Error', description)],
            });
        }
    },
};
