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
    PermissionsBitField,
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
const DATE_OPTION_COUNT = 25;
const drafts = new Map();

const INTERVAL_OPTIONS = [
    ['5m', 'Every 5 minutes'],
    ['10m', 'Every 10 minutes'],
    ['15m', 'Every 15 minutes'],
    ['30m', 'Every 30 minutes'],
    ['1h', 'Every 1 hour'],
    ['2h', 'Every 2 hours'],
    ['3h', 'Every 3 hours'],
    ['6h', 'Every 6 hours'],
    ['12h', 'Every 12 hours'],
    ['24h', 'Every 24 hours'],
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
    const utc = Date.UTC(year, month - 1, day) + (days * 24 * 60 * 60 * 1000);
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

function buildDateOptions(startDateKey, selectedDate = null, count = DATE_OPTION_COUNT) {
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
            default: value === selected,
        };
    });
}

function makeSelectLabel(label, description, component) {
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

    if (draft?.channelId) channelSelect.setDefaultChannels(draft.channelId);

    return new LabelBuilder()
        .setLabel('Channel')
        .setDescription('Choose the text channel where the automatic message will be sent.')
        .setChannelSelectMenuComponent(channelSelect);
}

function buildMinuteInput(customId, value = '') {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setPlaceholder('00–59 (example: 10)')
        .setMinLength(1)
        .setMaxLength(2)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    if (value !== '') input.setValue(String(value));
    return input;
}

function showCreateModal(draft = null) {
    const now = new Date();
    const nowDateKey = dateKeyFromDate(now);
    const startDate = draft?.startDate || nowDateKey;
    const currentHour = new Intl.DateTimeFormat('en-US', {
        timeZone: AUTO_MESSAGE_DEFAULT_TIMEZONE,
        hour: '2-digit',
        hourCycle: 'h23',
    }).format(now);

    const messageInput = new TextInputBuilder()
        .setCustomId('message')
        .setPlaceholder('Message to send automatically')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(2000)
        .setRequired(true);

    if (draft?.message) messageInput.setValue(draft.message);

    const startDateSelect = new StringSelectMenuBuilder()
        .setCustomId('start_date')
        .setPlaceholder('Select start date')
        .setRequired(true)
        .addOptions(buildDateOptions(nowDateKey, startDate));

    const startHourSelect = new StringSelectMenuBuilder()
        .setCustomId('start_hour')
        .setPlaceholder('Select start hour')
        .setRequired(true)
        .addOptions(buildHourOptions(draft?.startHour || currentHour));

    const startMinuteInput = buildMinuteInput('start_minute', draft?.startMinute ?? '00');

    return new ModalBuilder()
        .setCustomId(CREATE_MODAL_ID)
        .setTitle('Create an Auto Message')
        .addLabelComponents(
            makeChannelLabel(draft),
            makeTextLabel('Message', 'The text Discord will send automatically.', messageInput),
            makeSelectLabel(
                'Start Date',
                `Choose the first day • ${AUTO_MESSAGE_DEFAULT_TIMEZONE}`,
                startDateSelect,
            ),
            makeSelectLabel(
                'Start Time',
                `Choose the hour • ${AUTO_MESSAGE_DEFAULT_TIMEZONE}`,
                startHourSelect,
            ),
            makeTextLabel(
                'Start Minute',
                'Enter a minute from 00 to 59. Example: 10 → 18:10.',
                startMinuteInput,
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
        .setPlaceholder('Select end hour')
        .setRequired(true)
        .addOptions(buildHourOptions(draft?.endHour || '23'));

    const endMinuteInput = buildMinuteInput('end_minute', draft?.endMinute ?? '00');

    return new ModalBuilder()
        .setCustomId(END_MODAL_ID)
        .setTitle('Set Auto Message End Time')
        .addLabelComponents(
            makeSelectLabel('End Date', 'Choose when the automatic message schedule stops.', endDateSelect),
            makeSelectLabel('End Time', `Choose the hour • ${AUTO_MESSAGE_DEFAULT_TIMEZONE}`, endHourSelect),
            makeTextLabel(
                'End Minute',
                'Enter a minute from 00 to 59. Example: 45 → 23:45.',
                endMinuteInput,
            ),
        );
}

function normalizeMinute(value, fieldName) {
    const raw = String(value ?? '').trim();
    if (!/^\d{1,2}$/.test(raw)) {
        throw new Error(`${fieldName} must be a number from 0 to 59.`);
    }

    const minute = Number(raw);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new Error(`${fieldName} must be between 0 and 59.`);
    }

    return String(minute).padStart(2, '0');
}

function parseDraftDateTime(draft, type) {
    const date = type === 'end' ? draft.endDate : draft.startDate;
    const hour = type === 'end' ? draft.endHour : draft.startHour;
    const minute = type === 'end' ? draft.endMinute : draft.startMinute;

    if (!date || hour == null || minute == null) return null;

    return parseScheduledDateTime(
        `${date} ${hour}:${minute}`,
        AUTO_MESSAGE_DEFAULT_TIMEZONE,
    );
}

function intervalLabel(intervalString) {
    const found = INTERVAL_OPTIONS.find(([value]) => value === intervalString);
    return found ? found[1] : String(intervalString || 'Not selected');
}

function intervalSelect(draft) {
    return new StringSelectMenuBuilder()
        .setCustomId('automessage_interval')
        .setPlaceholder('Select how often the message should repeat')
        .setRequired(true)
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
    const startAt = parseDraftDateTime(draft, 'start');
    const endAt = draft.endDate ? parseDraftDateTime(draft, 'end') : null;

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
            description: 'Your message details are saved temporarily. Choose the repeat interval below, then optionally set an end time.',
            fields: [
                { name: 'Channel', value: `<#${draft.channelId}>`, inline: true },
                { name: 'Interval', value: intervalLabel(draft.intervalString), inline: true },
                { name: 'Start', value: startAt ? `<t:${Math.floor(startAt / 1000)}:F>` : 'Invalid', inline: true },
                { name: 'End', value: endAt ? `<t:${Math.floor(endAt / 1000)}:F>` : 'No end time', inline: true },
                { name: 'Message', value: draft.message ? truncate(draft.message, 1024) : 'Not set', inline: false },
            ],
            footer: { text: `Timezone: ${AUTO_MESSAGE_DEFAULT_TIMEZONE}` },
        }],
        components: [
            new ActionRowBuilder().addComponents(intervalSelect(draft)),
            new ActionRowBuilder().addComponents(endButton, clearEndButton),
            new ActionRowBuilder().addComponents(createButton, cancelButton),
        ],
    };
}

async function assertBotCanSend(channel, guild) {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(me || guild.client.user);

    if (!permissions) {
        throw new Error('Could not verify the bot permissions for the selected channel.');
    }

    const required = PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages;
    if (!permissions.has(required)) {
        throw new Error('The bot needs View Channel and Send Messages permissions in the selected channel.');
    }
}

async function getSelectedChannel(interaction) {
    if (typeof interaction.fields.getSelectedChannels === 'function') {
        const selected = interaction.fields.getSelectedChannels(
            'channel',
            true,
            [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        );
        return selected?.first() || null;
    }

    throw new Error('This bot needs a compatible discord.js version that supports Channel Select in modals.');
}

async function createScheduleFromDraft(interaction, draft) {
    if (!draft.channelId) throw new Error('Please select a channel.');
    if (!draft.message) throw new Error('Please enter a message.');
    if (!draft.intervalString) throw new Error('Please select an interval.');

    const startAt = parseDraftDateTime(draft, 'start');
    if (!startAt) throw new Error('Please select a valid start date/time.');
    if (startAt <= Date.now()) throw new Error('Start time must be in the future.');

    const endAt = draft.endDate ? parseDraftDateTime(draft, 'end') : null;
    if (draft.endDate && !endAt) throw new Error('Please select a valid end date/time.');
    if (endAt !== null && endAt <= startAt) throw new Error('End time must be after the start time.');

    const channel = await interaction.guild.channels.fetch(draft.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error('The selected channel is unavailable or cannot receive messages.');
    }

    await assertBotCanSend(channel, interaction.guild);

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

    return { schedule, channel };
}

function successResponse(schedule, channel) {
    return {
        flags: MessageFlags.Ephemeral,
        embeds: [{
            title: 'Auto Message Created ✅',
            description: [
                `**Channel:** ${channel}`,
                `**Start:** <t:${Math.floor(schedule.startAt / 1000)}:F>`,
                `**Interval:** ${intervalLabel(schedule.scheduleType === 'once' ? 'once' : formatIntervalFromMs(schedule.intervalMs))}`,
                `**Status:** Enabled`,
                schedule.endAt ? `**Ends:** <t:${Math.floor(schedule.endAt / 1000)}:F>` : '**Ends:** No end time',
                `**ID:** \`${schedule.id}\``,
            ].join('\n'),
            footer: { text: `Timezone: ${schedule.timezone}` },
        }],
    };
}

function formatIntervalFromMs(intervalMs) {
    if (!Number.isFinite(intervalMs)) return 'once';
    if (intervalMs % (7 * 24 * 60 * 60 * 1000) === 0) return `${intervalMs / (7 * 24 * 60 * 60 * 1000)}w`;
    if (intervalMs % (24 * 60 * 60 * 1000) === 0) return `${intervalMs / (24 * 60 * 60 * 1000)}d`;
    if (intervalMs % (60 * 60 * 1000) === 0) return `${intervalMs / (60 * 60 * 1000)}h`;
    return `${intervalMs / (60 * 1000)}m`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('automessage')
        .setDescription('Open the Auto Message scheduler form.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        try {
            requireManageGuild(interaction);
            deleteDraft(interaction);
            await interaction.showModal(showCreateModal());
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

            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === CREATE_MODAL_ID) {
                const channel = await getSelectedChannel(interaction);
                if (!channel) throw new Error('Please select a channel.');

                const message = validateMessage(interaction.fields.getTextInputValue('message'));
                const startDate = interaction.fields.getStringSelectValues('start_date')?.[0];
                const startHour = interaction.fields.getStringSelectValues('start_hour')?.[0];
                const startMinute = normalizeMinute(
                    interaction.fields.getTextInputValue('start_minute'),
                    'Start Minute',
                );

                if (!startDate || !startHour) {
                    throw new Error('Please choose the start date and start time.');
                }

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

                return interaction.editReply(buildDraftPanel(draft));
            }

            if (interaction.customId === END_MODAL_ID) {
                const draft = getDraft(interaction);
                if (!draft) {
                    throw new Error('Your Auto Message setup session expired. Run /automessage again.');
                }

                draft.endDate = interaction.fields.getStringSelectValues('end_date')?.[0];
                draft.endHour = interaction.fields.getStringSelectValues('end_hour')?.[0];
                draft.endMinute = normalizeMinute(
                    interaction.fields.getTextInputValue('end_minute'),
                    'End Minute',
                );

                if (!draft.endDate || !draft.endHour) {
                    throw new Error('Please choose the end date and end time.');
                }

                const startAt = parseDraftDateTime(draft, 'start');
                const endAt = parseDraftDateTime(draft, 'end');
                if (!startAt || !endAt || endAt <= startAt) {
                    throw new Error('End time must be after the start time.');
                }

                setDraft(interaction, draft);

                return interaction.editReply(buildDraftPanel(draft));
            }

            throw new Error('Unknown Auto Message modal.');
        } catch (error) {
            logger.error('Auto Message modal submit error:', error);
            const description = error instanceof TitanBotError
                ? error.publicMessage || error.message
                : error.message || 'An error occurred while processing the Auto Message form.';

            return interaction.editReply({
                embeds: [errorEmbed('Auto Message Error', description)],
                components: [],
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
                const selected = interaction.values?.[0];
                if (!INTERVAL_OPTIONS.some(([value]) => value === selected)) {
                    throw new Error('Invalid interval selection.');
                }

                draft.intervalString = selected;
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
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.deferUpdate();
                }

                const { schedule, channel } = await createScheduleFromDraft(interaction, draft);
                deleteDraft(interaction);

                return interaction.editReply({
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
