import {
    ChannelType,
    PermissionFlagsBits,
    SlashCommandBuilder,
    MessageFlags,
} from 'discord.js';
import { getBoomboxConfig, setBoomboxConfig } from '../../services/boomboxStorageService.js';
import { getBoomboxRuntimeStatus } from '../../services/boomboxService.js';

function requireManageGuild(interaction) {
    if (!interaction.inGuild()) {
        throw new Error('This command can only be used in a server.');
    }
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('You need the Manage Server permission to use this command.');
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('boombox-config')
        .setDescription('Configure the SKAW Boombox Converter.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) => sub
            .setName('channel')
            .setDescription('Set the only channel where supported URLs will be converted.')
            .addChannelOption((opt) => opt
                .setName('channel')
                .setDescription('Converter channel.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)))
        .addSubcommand((sub) => sub
            .setName('enable')
            .setDescription('Enable automatic conversion in the configured channel.'))
        .addSubcommand((sub) => sub
            .setName('disable')
            .setDescription('Disable automatic conversion.'))
        .addSubcommand((sub) => sub
            .setName('status')
            .setDescription('Show converter status.'))
        .addSubcommand((sub) => sub
            .setName('reset')
            .setDescription('Remove the configured channel and disable the converter.')),

    async execute(interaction) {
        requireManageGuild(interaction);
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (sub === 'channel') {
            const channel = interaction.options.getChannel('channel', true);
            const cfg = await setBoomboxConfig(interaction.client, guildId, {
                channelId: channel.id,
            }, interaction.user.id);
            return interaction.reply({
                flags: MessageFlags.Ephemeral,
                content: `✅ SKAW Boombox Converter channel set to <#${cfg.channelId}>.`,
            });
        }

        if (sub === 'enable') {
            const current = await getBoomboxConfig(interaction.client, guildId);
            if (!current.channelId) {
                return interaction.reply({
                    flags: MessageFlags.Ephemeral,
                    content: '❌ Set a converter channel first with `/boombox-config channel`. ',
                });
            }
            const cfg = await setBoomboxConfig(interaction.client, guildId, { enabled: true }, interaction.user.id);
            return interaction.reply({
                flags: MessageFlags.Ephemeral,
                content: `🟢 SKAW Boombox Converter enabled in <#${cfg.channelId}>.`,
            });
        }

        if (sub === 'disable') {
            await setBoomboxConfig(interaction.client, guildId, { enabled: false }, interaction.user.id);
            return interaction.reply({
                flags: MessageFlags.Ephemeral,
                content: '⚪ SKAW Boombox Converter disabled.',
            });
        }

        if (sub === 'reset') {
            await setBoomboxConfig(interaction.client, guildId, {
                enabled: false,
                channelId: null,
            }, interaction.user.id);
            return interaction.reply({
                flags: MessageFlags.Ephemeral,
                content: '♻️ SKAW Boombox Converter configuration reset.',
            });
        }

        const cfg = await getBoomboxConfig(interaction.client, guildId);
        const runtime = getBoomboxRuntimeStatus();
        return interaction.reply({
            flags: MessageFlags.Ephemeral,
            embeds: [{
                title: 'SKAW BOOMBOX CONVERTER — STATUS',
                color: 0x0A5EA8,
                fields: [
                    { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
                    { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not configured', inline: true },
                    { name: 'Queue', value: `${runtime.queueLength}/${runtime.maxQueue}`, inline: true },
                    { name: 'Processing', value: `${runtime.active}/${runtime.maxConcurrent}`, inline: true },
                    { name: 'Cooldown', value: `${runtime.cooldownSeconds}s`, inline: true },
                    { name: 'Max Duration', value: `${Math.floor(runtime.maxDurationSeconds / 60)} minutes`, inline: true },
                    { name: 'Max MP3', value: `${runtime.maxFileMb} MB`, inline: true },
                    { name: 'Supported', value: 'YouTube · TikTok · Spotify · SoundCloud', inline: false },
                ],
                footer: { text: 'URLs are processed only inside the configured converter channel.' },
            }],
        });
    },
};
