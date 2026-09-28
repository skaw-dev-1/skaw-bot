import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    PermissionFlagsBits,
    MessageFlags,
} from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    AUTO_MESSAGE_DEFAULT_TIMEZONE,
    buildAutoMessageData,
    getGuildAutoMessages,
    saveGuildAutoMessages,
    validateMessage,
} from '../../services/autoMessageService.js';

const MODAL_ID = 'automessage_create_modal';

function requireManageGuild(interaction) {
    if (!interaction.inGuild()) {
        throw new TitanBotError(
            'Auto Message command used outside guild',
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

function createInput(customId, label, placeholder, style = TextInputStyle.Short, required = true) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setPlaceholder(placeholder)
        .setStyle(style)
        .setRequired(required);

    return new ActionRowBuilder().addComponents(input);
}

export async function showAutoMessageModal(interaction) {
    requireManageGuild(interaction);

    const modal = new ModalBuilder()
        .setCustomId(MODAL_ID)
        .setTitle('Create an Auto Message');

    modal.addComponents(
        createInput(
            'channel',
            'Channel',
            '#announcement or channel ID',
            TextInputStyle.Short,
            true
        ),
        createInput(
            'message',
            'Message',
            'Message to send automatically',
            TextInputStyle.Paragraph,
            true
        ),
        createInput(
            'start',
            'Start Time',
            '2026-09-30 18:00',
            TextInputStyle.Short,
            true
        ),
        createInput(
            'interval',
            'Interval',
            '10m, 1h, 6h, 1d, 1w, or once',
            TextInputStyle.Short,
            true
        ),
        createInput(
            'end',
            'End Time (Optional)',
            '2026-10-07 23:00',
            TextInputStyle.Short,
            false
        )
    );

    return interaction.showModal(modal);
}

function resolveTextChannel(guild, value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const mentionMatch = raw.match(/^<#(\d+)>$/);
    const idMatch = raw.match(/^\d{15,25}$/);
    const channelId = mentionMatch?.[1] || (idMatch ? raw : null);

    if (channelId) {
        const byId = guild.channels.cache.get(channelId);
        if (byId?.isTextBased() && !byId.isDMBased()) return byId;
    }

    const normalizedName = raw.replace(/^#/, '').trim().toLowerCase();
    return guild.channels.cache.find(channel =>
        channel.isTextBased() &&
        !channel.isDMBased() &&
        channel.name?.toLowerCase() === normalizedName
    ) || null;
}

export default {
    data: {
        name: 'automessage',
        description: 'Open the Auto Message scheduler form.',
        default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    },

    async execute(interaction) {
        try {
            return await showAutoMessageModal(interaction);
        } catch (error) {
            logger.error('Auto Message modal error:', error);

            const description = error instanceof TitanBotError
                ? error.publicMessage || error.message
                : error.message || 'An error occurred while opening the auto message form.';

            return InteractionHelper.safeReply(interaction, {
                flags: MessageFlags.Ephemeral,
                embeds: [errorEmbed('Auto Message Error', description)],
            });
        }
    },

    async handleModal(interaction) {
        try {
            requireManageGuild(interaction);

            const channelInput = interaction.fields.getTextInputValue('channel');
            const message = interaction.fields.getTextInputValue('message');
            const start = interaction.fields.getTextInputValue('start');
            const interval = interaction.fields.getTextInputValue('interval');
            const end = interaction.fields.getTextInputValue('end')?.trim() || null;

            const channel = resolveTextChannel(interaction.guild, channelInput);
            if (!channel) {
                throw new Error(
                    `Channel \`${channelInput}\` was not found. Use a channel mention like #announcement, the channel ID, or the exact channel name.`
                );
            }

            const schedule = buildAutoMessageData({
                guildId: interaction.guildId,
                channelId: channel.id,
                message: validateMessage(message),
                startString: start,
                intervalString: interval,
                endString: end,
                timezone: AUTO_MESSAGE_DEFAULT_TIMEZONE,
                createdBy: interaction.user.id,
            });

            const existing = await getGuildAutoMessages(interaction.client, interaction.guildId);
            existing.push(schedule);
            await saveGuildAutoMessages(interaction.client, interaction.guildId, existing);

            const intervalText = schedule.scheduleType === 'once'
                ? 'Once'
                : interval.trim();
            const endText = schedule.endAt ? `\n**Ends:** <t:${Math.floor(schedule.endAt / 1000)}:F>` : '';

            return InteractionHelper.safeReply(interaction, {
                flags: MessageFlags.Ephemeral,
                embeds: [{
                    title: 'Auto Message Created ✅',
                    description: [
                        `**Channel:** ${channel}`,
                        `**Start:** <t:${Math.floor(schedule.startAt / 1000)}:F>`,
                        `**Interval:** ${intervalText}`,
                        `**Status:** Enabled`,
                        `**ID:** \`${schedule.id}\``,
                        endText.replace(/^\n/, ''),
                    ].filter(Boolean).join('\n'),
                    fields: [{
                        name: 'Message',
                        value: message.length > 1024 ? `${message.slice(0, 1021)}...` : message,
                    }],
                    footer: { text: `Timezone: ${schedule.timezone}` },
                }],
            });
        } catch (error) {
            logger.error('Auto Message modal submit error:', error);

            const description = error instanceof TitanBotError
                ? error.publicMessage || error.message
                : error.message || 'An error occurred while creating the auto message.';

            return InteractionHelper.safeReply(interaction, {
                flags: MessageFlags.Ephemeral,
                embeds: [errorEmbed('Auto Message Error', description)],
            });
        }
    },

    modalId: MODAL_ID,
};
