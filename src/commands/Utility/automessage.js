import {
    ActionRowBuilder,
    EmbedBuilder,
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
import { ensureAutoMessageInteractionHandlers } from '../../services/autoMessageInteractionHandlers.js';
import {
    AUTO_MESSAGE_DEFAULT_TIMEZONE,
    buildAutoMessageData,
    getGuildAutoMessages,
    saveGuildAutoMessages,
    parseScheduledDateTime,
    formatDateTime,
    validateMessage,
    validateEmbedDescription,
    validateEmbedColor,
    validateEmbedUrl,
    startAutoMessageScheduler,
    SKAW_DEFAULT_EMBED_COLOR,
} from '../../services/autoMessageService.js';

const CREATE_MODAL_ID = 'skaw_am_v10_create_modal';
const END_MODAL_ID = 'skaw_am_v10_end_modal';
const CHANNEL_ID = 'skaw_am_v10_channel';
const MESSAGE_ID = 'skaw_am_v10_message';
const START_DATE_ID = 'skaw_am_v10_start_date';
const START_HOUR_ID = 'skaw_am_v10_start_hour';
const START_MINUTE_ID = 'skaw_am_v10_start_minute';
const MESSAGE_TYPE_ID = 'skaw_am_v10_message_type';
const EMBED_MODAL_ID = 'skaw_am_v10_embed_modal';
const EMBED_TITLE_ID = 'skaw_am_v10_embed_title';
const EMBED_DESCRIPTION_ID = 'skaw_am_v10_embed_description';
const EMBED_COLOR_ID = 'skaw_am_v10_embed_color';
const EMBED_FOOTER_ID = 'skaw_am_v10_embed_footer';
const EMBED_IMAGE_ID = 'skaw_am_v10_embed_image';
const END_DATE_ID = 'skaw_am_v10_end_date';
const END_HOUR_ID = 'skaw_am_v10_end_hour';
const END_MINUTE_ID = 'skaw_am_v10_end_minute';
const DRAFT_TTL_MS = 15 * 60 * 1000;
const DATE_OPTION_COUNT = 25;
const drafts = new Map();

const INTERVAL_OPTIONS = [
    ['1m', 'Every 1 minute'],
    ['5m', 'Every 5 minutes'],
    ['10m', 'Every 10 minutes'],
    ['15m', 'Every 15 minutes'],
    ['30m', 'Every 30 minutes'],
    ['45m', 'Every 45 minutes'],
    ['1h', 'Every 1 hour'],
    ['2h', 'Every 2 hours'],
    ['3h', 'Every 3 hours'],
    ['4h', 'Every 4 hours'],
    ['6h', 'Every 6 hours'],
    ['8h', 'Every 8 hours'],
    ['12h', 'Every 12 hours'],
    ['24h', 'Every 24 hours'],
    ['1d', 'Every day'],
    ['2d', 'Every 2 days'],
    ['3d', 'Every 3 days'],
    ['4d', 'Every 4 days'],
    ['7d', 'Every 7 days'],
    ['1w', 'Every week'],
    ['2w', 'Every 2 weeks'],
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

function getNextHourDefaults(now = new Date()) {
    const localParts = new Intl.DateTimeFormat('en-US', {
        timeZone: AUTO_MESSAGE_DEFAULT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);

    const values = {};
    for (const part of localParts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    const currentHour = Number(values.hour);
    const currentMinute = Number(values.minute);
    const nextHourTotal = currentHour + 1;

    if (nextHourTotal >= 24) {
        const baseDate = `${values.year}-${values.month}-${values.day}`;
        return {
            date: addDaysToDateKey(baseDate, 1),
            hour: '00',
            minute: '00',
        };
    }

    return {
        date: `${values.year}-${values.month}-${values.day}`,
        hour: String(nextHourTotal).padStart(2, '0'),
        minute: '00',
    };
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
        .setCustomId(CHANNEL_ID)
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

function buildMinuteInput(customId, value = '00') {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setPlaceholder('00–59 (example: 10)')
        .setMinLength(1)
        .setMaxLength(2)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    input.setValue(String(value).padStart(2, '0'));
    return input;
}

function messageTypeSelect(draft) {
    return new StringSelectMenuBuilder()
        .setCustomId(MESSAGE_TYPE_ID)
        .setPlaceholder('Select message type')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions([
            {
                label: 'Normal Text Message',
                description: 'Send the message as a normal Discord message.',
                value: 'text',
                default: (draft?.messageType || 'text') === 'text',
            },
            {
                label: 'Embed Message',
                description: 'Send the message as a Discord embed.',
                value: 'embed',
                default: draft?.messageType === 'embed',
            },
        ]);
}

function optionalTextInput(customId, placeholder, value = '', maxLength = 2000) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Short)
        .setMaxLength(maxLength)
        .setRequired(false);

    if (value) input.setValue(value);
    return input;
}

function showEmbedModal(draft = {}) {
    const titleInput = optionalTextInput(
        EMBED_TITLE_ID,
        'Optional embed title',
        draft.embed?.title || '',
        256,
    );

    const descriptionInput = new TextInputBuilder()
        .setCustomId(EMBED_DESCRIPTION_ID)
        .setPlaceholder('Embed description / message')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4096)
        .setRequired(true);
    descriptionInput.setValue(draft.embed?.description || draft.message || '');

    const colorInput = optionalTextInput(
        EMBED_COLOR_ID,
        `Default: ${SKAW_DEFAULT_EMBED_COLOR} • optional custom color`,
        draft.embed?.color || '',
        7,
    );

    const footerInput = optionalTextInput(
        EMBED_FOOTER_ID,
        'Optional footer text',
        draft.embed?.footer || '',
        2048,
    );

    const imageInput = optionalTextInput(
        EMBED_IMAGE_ID,
        'Optional HTTPS image URL',
        draft.embed?.imageUrl || '',
        1000,
    );

    return new ModalBuilder()
        .setCustomId(EMBED_MODAL_ID)
        .setTitle('Configure Embed Message')
        .addLabelComponents(
            makeTextLabel('Title', 'Optional.', titleInput),
            makeTextLabel('Description', 'Unicode emoji works. Server custom emoji can be pasted or typed as :name:.', descriptionInput),
            makeTextLabel('Color', 'Optional 6-digit hex color.', colorInput),
            makeTextLabel('Footer', 'Optional.', footerInput),
            makeTextLabel('Image URL', 'Optional HTTP/HTTPS image URL.', imageInput),
        );
}

function buildEmbedPreview(draft) {
    if (draft.messageType !== 'embed') return null;

    const embedData = draft.embed || {};
    const embed = new EmbedBuilder();
    if (embedData.title) embed.setTitle(embedData.title);
    embed.setDescription(embedData.description || draft.message || '');
    const previewColor = embedData.color || SKAW_DEFAULT_EMBED_COLOR;
    try {
        embed.setColor(Number.parseInt(previewColor.slice(1), 16));
    } catch {
        // Final validation will show the real error on submit.
    }
    if (embedData.footer) embed.setFooter({ text: embedData.footer });
    if (embedData.imageUrl && /^https?:\/\//i.test(embedData.imageUrl)) {
        embed.setImage(embedData.imageUrl);
    }
    return embed.toJSON();
}

function showCreateModal(draft = null) {
    const defaults = getNextHourDefaults();
    const startDate = draft?.startDate || defaults.date;
    const startHour = draft?.startHour || defaults.hour;
    const startMinute = draft?.startMinute ?? defaults.minute;

    const messageInput = new TextInputBuilder()
        .setCustomId(MESSAGE_ID)
        .setPlaceholder('Message to send automatically')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(2000)
        .setRequired(true);

    if (draft?.message) messageInput.setValue(draft.message);

    const startDateSelect = new StringSelectMenuBuilder()
        .setCustomId(START_DATE_ID)
        .setPlaceholder('Select start date')
        .setRequired(true)
        .addOptions(buildDateOptions(dateKeyFromDate(new Date()), startDate));

    const startHourSelect = new StringSelectMenuBuilder()
        .setCustomId(START_HOUR_ID)
        .setPlaceholder('Select start hour')
        .setRequired(true)
        .addOptions(buildHourOptions(startHour));

    const startMinuteInput = buildMinuteInput(START_MINUTE_ID, startMinute);

    return new ModalBuilder()
        .setCustomId(CREATE_MODAL_ID)
        .setTitle('Create an Auto Message')
        .addLabelComponents(
            makeChannelLabel(draft),
            makeTextLabel('Message', 'Unicode emoji works. Server custom emoji can be pasted or typed as :name:.', messageInput),
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
        .setCustomId(END_DATE_ID)
        .setPlaceholder('Select end date')
        .setRequired(true)
        .addOptions(buildDateOptions(safeBaseDate, draft?.endDate));

    const endHourSelect = new StringSelectMenuBuilder()
        .setCustomId(END_HOUR_ID)
        .setPlaceholder('Select end hour')
        .setRequired(true)
        .addOptions(buildHourOptions(draft?.endHour || '23'));

    const endMinuteInput = buildMinuteInput(END_MINUTE_ID, draft?.endMinute ?? '00');

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
    return found ? found[1] : 'Not selected';
}

function intervalSelect(draft) {
    // IMPORTANT: this select is rendered in a normal message ActionRow,
    // not inside a modal Label. `required` is a modal-only property.
    return new StringSelectMenuBuilder()
        .setCustomId('skaw_am_v10_interval')
        .setPlaceholder('Select how often the message should repeat')
        .setMinValues(1)
        .setMaxValues(1)
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

    const editButton = new ButtonBuilder()
        .setCustomId('skaw_am_v10_edit')
        .setLabel('Edit Details')
        .setStyle(ButtonStyle.Secondary);

    const endButton = new ButtonBuilder()
        .setCustomId('skaw_am_v10_set_end')
        .setLabel(draft.endDate ? 'Edit End Time' : 'Set End Time')
        .setStyle(ButtonStyle.Secondary);

    const clearEndButton = new ButtonBuilder()
        .setCustomId('skaw_am_v10_clear_end')
        .setLabel('Clear End')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!draft.endDate);

    const createButton = new ButtonBuilder()
        .setCustomId('skaw_am_v10_create')
        .setLabel('Create Auto Message')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!draft.intervalString);

    const cancelButton = new ButtonBuilder()
        .setCustomId('skaw_am_v10_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger);

    const setupEmbed = {
        title: 'Create an Auto Message',
        description: draft.intervalString
            ? 'Review the schedule below. You can edit the details, choose the message type, change the repeat interval, set an optional end time, or create the schedule.'
            : 'Choose the message type and repeat interval below before creating the schedule.',
        fields: [
            { name: 'Channel', value: `<#${draft.channelId}>`, inline: true },
            { name: 'Message Type', value: draft.messageType === 'embed' ? 'Embed Message' : 'Normal Text Message', inline: true },
            { name: 'Interval', value: intervalLabel(draft.intervalString), inline: true },
            { name: 'Start', value: startAt ? `<t:${Math.floor(startAt / 1000)}:F>` : 'Invalid', inline: true },
            { name: 'End', value: endAt ? `<t:${Math.floor(endAt / 1000)}:F>` : 'No end time', inline: true },
            { name: draft.messageType === 'embed' ? 'Embed Description' : 'Message', value: draft.message ? truncate(draft.message, 1024) : 'Not set', inline: false },
            ...(draft.messageType === 'embed' && draft.embed?.title
                ? [{ name: 'Embed Title', value: truncate(draft.embed.title, 256), inline: false }]
                : []),
            ...(draft.messageType === 'embed'
                ? [{ name: 'Embed Color', value: draft.embed?.color || SKAW_DEFAULT_EMBED_COLOR, inline: true }]
                : []),
        ],
        footer: { text: `Timezone: ${AUTO_MESSAGE_DEFAULT_TIMEZONE}` },
    };

    const preview = draft.messageType === 'embed' ? buildEmbedPreview(draft) : null;
    return {
        embeds: preview ? [setupEmbed, preview] : [setupEmbed],
        components: [
            new ActionRowBuilder().addComponents(messageTypeSelect(draft)),
            new ActionRowBuilder().addComponents(intervalSelect(draft)),
            new ActionRowBuilder().addComponents(
                editButton,
                ...(draft.messageType === 'embed'
                    ? [new ButtonBuilder()
                        .setCustomId('skaw_am_v10_edit_embed')
                        .setLabel('Edit Embed')
                        .setStyle(ButtonStyle.Primary)]
                    : []),
                endButton,
                clearEndButton,
            ),
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

function getSelectedChannel(interaction) {
    const selected = interaction.fields.getSelectedChannels(
        CHANNEL_ID,
        true,
        [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    );
    return selected?.first() || null;
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
        message: draft.messageType === 'embed' ? validateEmbedDescription(draft.embed?.description || draft.message) : validateMessage(draft.message),
        messageType: draft.messageType || 'text',
        embed: draft.messageType === 'embed' ? draft.embed : null,
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

const automessageCommand = {
    data: new SlashCommandBuilder()
        .setName('automessage')
        .setDescription('Open the Auto Message scheduler form.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        try {
            requireManageGuild(interaction);

            // Ensure background scheduling is active even if the host app has not yet
            // wired the startup scheduler. The service guard prevents duplicates.
            startAutoMessageScheduler(interaction.client);

            // Register the modal/button/select handlers directly into TitanBot's
            // native interaction collections before opening the modal. This means
            // the existing interactionCreate dispatcher will route subsequent
            // submissions without requiring a custom app.js handler.
            ensureAutoMessageInteractionHandlers(interaction.client, automessageCommand);

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
        if (![CREATE_MODAL_ID, END_MODAL_ID, EMBED_MODAL_ID].includes(interaction.customId)) {
            return false;
        }

        try {
            requireManageGuild(interaction);

            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === CREATE_MODAL_ID) {
                const channel = getSelectedChannel(interaction);
                if (!channel) throw new Error('Please select a channel.');

                const message = validateMessage(interaction.fields.getTextInputValue(MESSAGE_ID));
                const startDate = interaction.fields.getStringSelectValues(START_DATE_ID)?.[0];
                const startHour = interaction.fields.getStringSelectValues(START_HOUR_ID)?.[0];
                const startMinute = normalizeMinute(
                    interaction.fields.getTextInputValue(START_MINUTE_ID),
                    'Start Minute',
                );

                if (!startDate || !startHour) {
                    throw new Error('Please choose the start date and start time.');
                }

                const previous = getDraft(interaction);
                const draft = {
                    guildId: interaction.guildId,
                    userId: interaction.user.id,
                    channelId: channel.id,
                    message,
                    messageType: previous?.messageType || 'text',
                    embed: previous?.embed || {
                        title: '',
                        description: message,
                        color: '',
                        footer: '',
                        imageUrl: '',
                    },
                    startDate,
                    startHour,
                    startMinute,
                    intervalString: previous?.intervalString || null,
                    endDate: previous?.endDate || null,
                    endHour: previous?.endHour || null,
                    endMinute: previous?.endMinute || null,
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

                draft.endDate = interaction.fields.getStringSelectValues(END_DATE_ID)?.[0];
                draft.endHour = interaction.fields.getStringSelectValues(END_HOUR_ID)?.[0];
                draft.endMinute = normalizeMinute(
                    interaction.fields.getTextInputValue(END_MINUTE_ID),
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

            if (interaction.customId === EMBED_MODAL_ID) {
                const draft = getDraft(interaction);
                if (!draft) throw new Error('Your Auto Message setup session expired. Run /automessage again.');

                const title = interaction.fields.getTextInputValue(EMBED_TITLE_ID)?.trim() || '';
                const description = validateEmbedDescription(interaction.fields.getTextInputValue(EMBED_DESCRIPTION_ID));
                const color = validateEmbedColor(interaction.fields.getTextInputValue(EMBED_COLOR_ID)?.trim() || '');
                const footer = interaction.fields.getTextInputValue(EMBED_FOOTER_ID)?.trim() || '';
                const imageUrl = validateEmbedUrl(interaction.fields.getTextInputValue(EMBED_IMAGE_ID)?.trim() || '');

                draft.messageType = 'embed';
                draft.message = description;
                draft.embed = { title, description, color, footer, imageUrl };
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
            }).catch(() => null);
        }
    },

    async handleComponent(interaction) {
        const handledIds = new Set([
            'skaw_am_v10_message_type',
            'skaw_am_v10_interval',
            'skaw_am_v10_edit',
            'skaw_am_v10_edit_embed',
            'skaw_am_v10_set_end',
            'skaw_am_v10_clear_end',
            'skaw_am_v10_create',
            'skaw_am_v10_cancel',
        ]);
        if (!handledIds.has(interaction.customId)) {
            return false;
        }

        try {
            requireManageGuild(interaction);

            const draft = getDraft(interaction);
            if (!draft) {
                return interaction.reply({
                    flags: MessageFlags.Ephemeral,
                    embeds: [errorEmbed('Auto Message', 'Your setup session expired. Run `/automessage` again.')],
                });
            }

            if (interaction.customId === MESSAGE_TYPE_ID) {
                const selected = interaction.values?.[0];
                if (!['text', 'embed'].includes(selected)) throw new Error('Invalid message type selection.');

                draft.messageType = selected;
                if (selected === 'embed') {
                    draft.embed = {
                        title: draft.embed?.title || '',
                        description: draft.embed?.description || draft.message,
                        color: draft.embed?.color || '',
                        footer: draft.embed?.footer || '',
                        imageUrl: draft.embed?.imageUrl || '',
                    };
                }
                setDraft(interaction, draft);
                return interaction.update(buildDraftPanel(draft));
            }

            if (interaction.customId === 'skaw_am_v10_interval') {
                const selected = interaction.values?.[0];
                if (!INTERVAL_OPTIONS.some(([value]) => value === selected)) {
                    throw new Error('Invalid interval selection.');
                }

                draft.intervalString = selected;
                setDraft(interaction, draft);
                return interaction.update(buildDraftPanel(draft));
            }

            if (interaction.customId === 'skaw_am_v10_edit') {
                setDraft(interaction, draft);
                return interaction.showModal(showCreateModal(draft));
            }

            if (interaction.customId === 'skaw_am_v10_edit_embed') {
                if (draft.messageType !== 'embed') throw new Error('Select Embed Message first.');
                setDraft(interaction, draft);
                return interaction.showModal(showEmbedModal(draft));
            }

            if (interaction.customId === 'skaw_am_v10_set_end') {
                setDraft(interaction, draft);
                return interaction.showModal(showEndModal(draft));
            }

            if (interaction.customId === 'skaw_am_v10_clear_end') {
                draft.endDate = null;
                draft.endHour = null;
                draft.endMinute = null;
                setDraft(interaction, draft);
                return interaction.update(buildDraftPanel(draft));
            }

            if (interaction.customId === 'skaw_am_v10_create') {
                if (!draft.intervalString) {
                    throw new Error('Please select an interval before creating the schedule.');
                }

                await interaction.deferUpdate();

                const { schedule, channel } = await createScheduleFromDraft(interaction, draft);
                deleteDraft(interaction);

                return interaction.editReply({
                    embeds: successResponse(schedule, channel).embeds,
                    components: [],
                });
            }

            if (interaction.customId === 'skaw_am_v10_cancel') {
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

export default automessageCommand;
