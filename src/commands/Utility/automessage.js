import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
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
    parseScheduledDateTime,
    formatDateTime,
    validateMessage,
} from '../../services/autoMessageService.js';

const CREATE_MODAL_ID = 'automessage_create_modal';
const END_MODAL_ID = 'automessage_end_modal';
const DRAFT_TTL_MS = 15 * 60 * 1000;
const drafts = new Map();

const INTERVAL_OPTIONS = [
    ['10m', 'Every 10 minutes'],
    ['30m', 'Every 30 minutes'],
    ['1h', 'Every hour'],
    ['2h', 'Every 2 hours'],
    ['6h', 'Every 6 hours'],
    ['12h', 'Every 12 hours'],
    ['1d', 'Every day'],
    ['1w', 'Every week'],
    ['once', 'Send once only'],
];

function requireManageGuild(interaction) {
    if (!interaction.inGuild()) {
        throw new TitanBotError(
            'Auto Message command used outside guild',
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

function draftKey(interaction) {
    return `${interaction.guildId}:${interaction.user.id}`;
}

function cleanupDrafts() {
    const now = Date.now();
    for (const [key, draft] of drafts) {
        if (now - draft.updatedAt > DRAFT_TTL_MS) drafts.delete(key);
    }
}

function getDraft(interaction) {
    cleanupDrafts();
    return drafts.get(draftKey(interaction)) || null;
}

function setDraft(interaction, draft) {
    draft.updatedAt = Date.now();
    drafts.set(draftKey(interaction), draft);
}

function deleteDraft(interaction) {
    drafts.delete(draftKey(interaction));
}

function dateKeyFromDate(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: AUTO_MESSAGE_DEFAULT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

function addDaysToDateKey(dateKey, days) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const utc = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
    const date = new Date(utc);
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

function formatDateLabel(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: AUTO_MESSAGE_DEFAULT_TIMEZONE,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function buildDateOptions(startDateKey, selectedDate = null, count = 25) {
    return Array.from({ length: count }, (_, index) => {
        const value = addDaysToDateKey(startDateKey, index);
        return {
            label: formatDateLabel(value),
            value,
            description: value,
            default: value === selectedDate,
        };
    });
}

function buildHourOptions(selected = null) {
    return Array.from({ length: 24 }, (_, hour) => {
        const value = String(hour).padStart(2, '0');
        return {
            label: `${value}:00`,
            value,
            description: `${value}:00 (${AUTO_MESSAGE_DEFAULT_TIMEZONE})`,
            default: value === selected,
        };
    });
}

function buildMinuteOptions(selected = null) {
    return ['00', '15', '30', '45'].map(value => ({
        label: value,
        value,
        description: `:${value}`,
        default: value === selected,
    }));
}

function makeLabel(label, description, component) {
    return new LabelBuilder()
        .setLabel(label)
        .setDescription(description)
        .setStringSelectMenuComponent(component);
}

function makeTextLabel(label, description, component) {
    return new LabelBuilder()
        .setLabel(label)
        .setDescription(description)
        .setTextInputComponent(component);
}

function makeChannelLabel(draft) {
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('channel')
        .setPlaceholder(draft?.channelId ? 'Channel selected' : 'Select a channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    if (draft?.channelId) {
        channelSelect.setDefaultChannels(draft.channelId);
    }

    return new LabelBuilder()
        .setLabel('Channel')
        .setDescription('Choose the text channel where the automatic message will be sent.')
        .setChannelSelectMenuComponent(channelSelect);
}

function showCreateModal(draft = null) {
    const nowDateKey = dateKeyFromDate(new Date());
    const startDate = draft?.startDate || nowDateKey;

    const messageInput = new TextInputBuilder()
        .setCustomId('message')
        .setPlaceholder('Message to send automatically')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

    if (draft?.message) messageInput.setValue(draft.message);

    const startDateSelect = new StringSelectMenuBuilder()
        .setCustomId('start_date')
        .setPlaceholder('Select start date')
        .setRequired(true)
        .addOptions(buildDateOptions(nowDateKey, startDate));

    const startHourSelect = new StringSelectMenuBuilder()
        .setCustomId('start_hour')
        .setPlaceholder('Select hour')
        .setRequired(true)
        .addOptions(buildHourOptions(draft?.startHour));

    const startMinuteSelect = new StringSelectMenuBuilder()
        .setCustomId('start_minute')
        .setPlaceholder('Select minute')
        .setRequired(true)
        .addOptions(buildMinuteOptions(draft?.startMinute));

    return new ModalBuilder()
        .setCustomId(CREATE_MODAL_ID)
        .setTitle('Create an Auto Message')
        .addLabelComponents(
            makeChannelLabel(draft),
            makeTextLabel('Message', 'The text Discord will send automatically.', messageInput),
            makeLabel(
                'Start Date',
                `Choose the first day • ${AUTO_MESSAGE_DEFAULT_TIMEZONE}`,
                startDateSelect,
            ),
            makeLabel(
                'Start Time',
                `Choose the hour • ${AUTO_MESSAGE_DEFAULT_TIMEZONE}`,
                startHourSelect,
            ),
            makeLabel(
                'Start Minute',
                'Choose the minute (15-minute intervals).',
                startMinuteSelect,
            ),
        );
}

function showEndModal(draft) {
    const nowDateKey = dateKeyFromDate(new Date());
    const baseDate = draft?.startDate || nowDateKey;
    const safeBaseDate = baseDate < nowDateKey ? nowDateKey : baseDate;

    const endDateSelect = new StringSelectMenuBuilder()
        .setCustomId('end_date')
        .setPlaceholder('Select end date')
        .setRequired(true)
        .addOptions(buildDateOptions(safeBaseDate, draft?.endDate));

    const endHourSelect = new StringSelectMenuBuilder()
        .setCustomId('end_hour')
        .setPlaceholder('Select hour')
        .setRequired(true)
        .addOptions(buildHourOptions(draft?.endHour));

    const endMinuteSelect = new StringSelectMenuBuilder()
        .setCustomId('end_minute')
        .setPlaceholder('Select minute')
        .setRequired(true)
        .addOptions(buildMinuteOptions(draft?.endMinute));

    return new ModalBuilder()
        .setCustomId(END_MODAL_ID)
        .setTitle('Set Auto Message End Time')
        .addLabelComponents(
            makeLabel('End Date', 'Choose when the automatic message schedule stops.', endDateSelect),
            makeLabel('End Time', `Choose the hour • ${AUTO_MESSAGE_DEFAULT_TIMEZONE}`, endHourSelect),
            makeLabel('End Minute', 'Choose the minute (15-minute intervals).', endMinuteSelect),
        );
}

function intervalSelect(draft) {
    return new StringSelectMenuBuilder()
        .setCustomId('automessage_interval')
        .setPlaceholder('Select how often the message should repeat')
        .addOptions(INTERVAL_OPTIONS.map(([value, description]) => ({
            label: value === 'once' ? 'Once' : value,
            description,
            value,
            default: value === draft.intervalString,
        })));
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildDraftPanel(draft) {
    const channelText = draft.channelId ? `<#${draft.channelId}>` : 'Not selected';
    const startText = draft.startDate && draft.startHour !== null && draft.startMinute !== null
        ? `${draft.startDate} ${draft.startHour}:${draft.startMinute}`
        : 'Not selected';
    const endText = draft.endDate && draft.endHour !== null && draft.endMinute !== null
        ? `${draft.endDate} ${draft.endHour}:${draft.endMinute}`
        : 'No end time';

    const endButton = new ButtonBuilder()
        .setCustomId('automessage_set_end')
        .setLabel(draft.endDate ? 'Edit End Time' : 'Set End Time')
        .setStyle(ButtonStyle.Secondary);

    const clearEndButton = new ButtonBuilder()
        .setCustomId('automessage_clear_end')
        .setLabel('Clear End')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!draft.endDate);

    const createButton = new ButtonBuilder()
        .setCustomId('automessage_create')
        .setLabel('Create Auto Message')
        .setStyle(ButtonStyle.Success);

    const cancelButton = new ButtonBuilder()
        .setCustomId('automessage_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger);

    return {
        embeds: [{
            title: 'Create an Auto Message',
            description: 'Configure the schedule below. Channel, date and time use Discord selection menus — no ID or date/time typing is required.',
            fields: [
                { name: 'Channel', value: channelText, inline: true },
                { name: 'Interval', value: draft.intervalString === 'once' ? 'Once' : draft.intervalString, inline: true },
                { name: 'Start', value: startText, inline: true },
                { name: 'End', value: endText, inline: true },
                { name: 'Message', value: draft.message ? truncate(draft.message, 1024) : 'Not set', inline: false },
            ],
            footer: { text: `Timezone: ${AUTO_MESSAGE_DEFAULT_TIMEZONE}` },
        }],
        components: [
            new ActionRowBuilder().addComponents(intervalSelect(draft)),
            new ActionRowBuilder().addComponents(endButton, clearEndButton, createButton, cancelButton),
        ],
    };
}

function parseDraftDateTime(draft, type) {
    const date = type === 'end' ? draft.endDate : draft.startDate;
    const hour = type === 'end' ? draft.endHour : draft.startHour;
    const minute = type === 'end' ? draft.endMinute : draft.startMinute;
    if (!date || hour === null || minute === null) return null;
    return parseScheduledDateTime(
        `${date} ${hour}:${minute}`,
        AUTO_MESSAGE_DEFAULT_TIMEZONE,
    );
}

async function createScheduleFromDraft(interaction, draft) {
    if (!draft.channelId) throw new Error('Please select a channel.');
    if (!draft.message) throw new Error('Please enter a message.');
    if (!draft.intervalString) throw new Error('Please select an interval.');

    const startAt = parseDraftDateTime(draft, 'start');
    if (!startAt) throw new Error('Please select a valid start date and time.');
    if (startAt <= Date.now()) {
        throw new Error('Start time must be in the future. Please choose a later date/time.');
    }

    const endAt = draft.endDate ? parseDraftDateTime(draft, 'end') : null;
    if (draft.endDate && !endAt) throw new Error('Please select a valid end date and time.');
    if (endAt !== null && endAt <= startAt) {
        throw new Error('End time must be after the start time.');
    }

    const channel = await interaction.guild.channels.fetch(draft.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error('The selected channel is unavailable or cannot receive messages.');
    }

    const schedule = buildAutoMessageData({
        guildId: interaction.guildId,
        channelId: channel.id,
        message: validateMessage(draft.message),
        startString: `${draft.startDate} ${draft.startHour}:${draft.startMinute}`,
        intervalString: draft.intervalString,
        endString: endAt !== null ? `${draft.endDate} ${draft.endHour}:${draft.endMinute}` : null,
        timezone: AUTO_MESSAGE_DEFAULT_TIMEZONE,
        createdBy: interaction.user.id,
    });

    const existing = await getGuildAutoMessages(interaction.client, interaction.guildId);
    existing.push(schedule);
    await saveGuildAutoMessages(interaction.client, interaction.guildId, existing);

    return schedule;
}

function successResponse(schedule, channel) {
    const endText = schedule.endAt
        ? `\n**Ends:** <t:${Math.floor(schedule.endAt / 1000)}:F>`
        : '';

    return {
        flags: MessageFlags.Ephemeral,
        embeds: [{
            title: 'Auto Message Created ✅',
            description: [
                `**Channel:** ${channel}`,
                `**Start:** <t:${Math.floor(schedule.startAt / 1000)}:F>`,
                `**Interval:** ${schedule.scheduleType === 'once' ? 'Once' : `${Math.round(schedule.intervalMs / 60000)} minutes`}`,
                `**Status:** Enabled`,
                `**ID:** \`${schedule.id}\``,
                endText.replace(/^\n/, ''),
            ].filter(Boolean).join('\n'),
            footer: { text: `Timezone: ${schedule.timezone}` },
        }],
    };
}

export default {
    data: new SlashCommandBuilder()
        .setName('automessage')
        .setDescription('Open the Auto Message scheduler form.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        try {
            requireManageGuild(interaction);
            const existingDraft = getDraft(interaction);
            if (existingDraft) deleteDraft(interaction);
            return await interaction.showModal(showCreateModal());
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

            if (interaction.customId === CREATE_MODAL_ID) {
                const selectedChannels = interaction.fields.getSelectedChannels(
                    'channel',
                    true,
                    [ChannelType.GuildText, ChannelType.GuildAnnouncement],
                );
                const channel = selectedChannels?.first();
                if (!channel) throw new Error('Please select a channel.');

                const message = validateMessage(interaction.fields.getTextInputValue('message'));
                const startDate = interaction.fields.getStringSelectValues('start_date')[0];
                const startHour = interaction.fields.getStringSelectValues('start_hour')[0];
                const startMinute = interaction.fields.getStringSelectValues('start_minute')[0];

                const draft = {
                    guildId: interaction.guildId,
                    userId: interaction.user.id,
                    channelId: channel.id,
                    message,
                    startDate,
                    startHour,
                    startMinute,
                    intervalString: '1h',
                    endDate: null,
                    endHour: null,
                    endMinute: null,
                    updatedAt: Date.now(),
                };

                const startAt = parseDraftDateTime(draft, 'start');
                if (!startAt || startAt <= Date.now()) {
                    throw new Error('Start time must be in the future. Please choose a later date/time.');
                }

                setDraft(interaction, draft);

                return InteractionHelper.safeReply(interaction, {
                    flags: MessageFlags.Ephemeral,
                    ...buildDraftPanel(draft),
                });
            }

            if (interaction.customId === END_MODAL_ID) {
                const draft = getDraft(interaction);
                if (!draft) {
                    throw new Error('Your Auto Message setup session expired. Run /automessage again.');
                }

                draft.endDate = interaction.fields.getStringSelectValues('end_date')[0];
                draft.endHour = interaction.fields.getStringSelectValues('end_hour')[0];
                draft.endMinute = interaction.fields.getStringSelectValues('end_minute')[0];

                const startAt = parseDraftDateTime(draft, 'start');
                const endAt = parseDraftDateTime(draft, 'end');
                if (!endAt || endAt <= startAt) {
                    throw new Error('End time must be after the start time. Please choose another end date/time.');
                }

                setDraft(interaction, draft);

                return InteractionHelper.safeReply(interaction, {
                    flags: MessageFlags.Ephemeral,
                    ...buildDraftPanel(draft),
                });
            }

            throw new Error('Unknown Auto Message modal.');
        } catch (error) {
            logger.error('Auto Message modal submit error:', error);
            const description = error instanceof TitanBotError
                ? error.publicMessage || error.message
                : error.message || 'An error occurred while processing the Auto Message form.';

            return InteractionHelper.safeReply(interaction, {
                flags: MessageFlags.Ephemeral,
                embeds: [errorEmbed('Auto Message Error', description)],
            });
        }
    },

    async handleComponent(interaction) {
        try {
            requireManageGuild(interaction);

            const draft = getDraft(interaction);
            if (!draft) {
                return interaction.reply({
                    flags: MessageFlags.Ephemeral,
                    embeds: [errorEmbed('Auto Message', 'Your setup session expired. Run `/automessage` again.')],
                });
            }

            if (interaction.customId === 'automessage_interval') {
                draft.intervalString = interaction.values[0];
                setDraft(interaction, draft);
                return interaction.update(buildDraftPanel(draft));
            }

            if (interaction.customId === 'automessage_set_end') {
                setDraft(interaction, draft);
                return interaction.showModal(showEndModal(draft));
            }

            if (interaction.customId === 'automessage_clear_end') {
                draft.endDate = null;
                draft.endHour = null;
                draft.endMinute = null;
                setDraft(interaction, draft);
                return interaction.update(buildDraftPanel(draft));
            }

            if (interaction.customId === 'automessage_create') {
                const schedule = await createScheduleFromDraft(interaction, draft);
                const channel = await interaction.guild.channels.fetch(schedule.channelId);
                deleteDraft(interaction);

                return interaction.update({
                    embeds: successResponse(schedule, channel).embeds,
                    components: [],
                });
            }

            if (interaction.customId === 'automessage_cancel') {
                deleteDraft(interaction);
                return interaction.update({
                    embeds: [{
                        title: 'Auto Message Cancelled',
                        description: 'No schedule was created.',
                    }],
                    components: [],
                });
            }

            throw new Error('Unknown Auto Message component.');
        } catch (error) {
            logger.error('Auto Message component error:', error);

            const description = error instanceof TitanBotError
                ? error.publicMessage || error.message
                : error.message || 'An error occurred while managing the Auto Message setup.';

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({
                    embeds: [errorEmbed('Auto Message Error', description)],
                    components: [],
                }).catch(() => null);
            }

            return interaction.reply({
                flags: MessageFlags.Ephemeral,
                embeds: [errorEmbed('Auto Message Error', description)],
            });
        }
    },
};
