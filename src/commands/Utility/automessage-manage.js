import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    formatDateTime,
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
            { userId: interaction.user.id }
        );
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        throw new TitanBotError(
            'User lacks ManageGuild permission',
            ErrorTypes.PERMISSION,
            "You need the 'Manage Server' permission to manage auto messages.",
            { userId: interaction.user.id, guildId: interaction.guildId }
        );
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('automessage-manage')
        .setDescription('Manage existing automatic message schedules.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List configured automatic messages.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View one automatic message configuration.')
                .addStringOption(option =>
                    option
                        .setName('id')
                        .setDescription('Auto Message ID.')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Enable an automatic message.')
                .addStringOption(option =>
                    option
                        .setName('id')
                        .setDescription('Auto Message ID.')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable an automatic message.')
                .addStringOption(option =>
                    option
                        .setName('id')
                        .setDescription('Auto Message ID.')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete an automatic message configuration.')
                .addStringOption(option =>
                    option
                        .setName('id')
                        .setDescription('Auto Message ID.')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('test')
                .setDescription('Send one automatic message immediately for testing.')
                .addStringOption(option =>
                    option
                        .setName('id')
                        .setDescription('Auto Message ID.')
                        .setRequired(true)
                )
        ),

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
                    const next = schedule.nextRunAt
                        ? formatDateTime(schedule.nextRunAt, schedule.timezone)
                        : '—';
                    const interval = schedule.scheduleType === 'once'
                        ? 'once'
                        : `${Math.round(schedule.intervalMs / 60000)}m`;
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
                const interval = schedule.scheduleType === 'once'
                    ? 'Once'
                    : `${Math.round(schedule.intervalMs / 60000)} minutes`;
                const next = schedule.nextRunAt
                    ? formatDateTime(schedule.nextRunAt, schedule.timezone)
                    : '—';
                const end = schedule.endAt
                    ? formatDateTime(schedule.endAt, schedule.timezone)
                    : 'No end';

                return InteractionHelper.safeReply(interaction, {
                    embeds: [{
                        title: `Auto Message • ${schedule.id}`,
                        description: schedule.message,
                        fields: [
                            { name: 'Channel', value: `<#${schedule.channelId}>`, inline: true },
                            { name: 'Status', value: schedule.enabled ? 'Enabled' : 'Disabled', inline: true },
                            { name: 'Interval', value: interval, inline: true },
                            { name: 'Start', value: formatDateTime(schedule.startAt, schedule.timezone), inline: true },
                            { name: 'Next', value: next, inline: true },
                            { name: 'End', value: end, inline: true },
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
                    if (!schedule.nextRunAt || schedule.nextRunAt < now) {
                        schedule.nextRunAt = now;
                    }
                } else {
                    schedule.nextRunAt = null;
                }

                schedule.updatedAt = new Date().toISOString();

                const all = await getGuildAutoMessages(interaction.client, guildId);
                const updated = all.map(item => item.id === schedule.id ? schedule : item);
                await saveGuildAutoMessages(interaction.client, guildId, updated);

                return InteractionHelper.safeReply(interaction, {
                    embeds: [successEmbed(
                        `Auto Message ${schedule.enabled ? 'Enabled' : 'Disabled'} ✅`,
                        `\`${schedule.id}\` is now **${schedule.enabled ? 'enabled' : 'disabled'}**.`
                    )],
                });
            }

            if (subcommand === 'delete') {
                const all = await getGuildAutoMessages(interaction.client, guildId);
                await saveGuildAutoMessages(
                    interaction.client,
                    guildId,
                    all.filter(item => item.id !== schedule.id)
                );

                return InteractionHelper.safeReply(interaction, {
                    embeds: [successEmbed('Auto Message Deleted ✅', `Removed \`${schedule.id}\` from the schedule list.`)],
                });
            }

            if (subcommand === 'test') {
                const channel = await interaction.client.channels.fetch(schedule.channelId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    throw new Error('The configured channel is unavailable.');
                }

                const sent = await channel.send({ content: schedule.message });
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
