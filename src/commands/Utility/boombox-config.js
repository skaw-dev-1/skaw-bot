import {
    ChannelType,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';

import {
    getBoomboxConfig,
    resetBoomboxConfig,
    setBoomboxChannel,
    setBoomboxEnabled,
} from '../../services/boomboxStorageService.js';

function ensureAdmin(interaction) {
    if (!interaction.inGuild()) {
        throw new Error('Command ini hanya bisa digunakan di server.');
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('Kamu membutuhkan permission Manage Server.');
    }
}

function channelText(channelId) {
    return channelId ? `<#${channelId}>` : '`Belum diatur`';
}

export default {
    data: new SlashCommandBuilder()
        .setName('boombox-config')
        .setDescription('Konfigurasi SKAW Boombox Converter.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) => sub
            .setName('channel')
            .setDescription('Pilih satu channel untuk converter.')
            .addChannelOption((opt) => opt
                .setName('channel')
                .setDescription('Channel converter.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)))
        .addSubcommand((sub) => sub
            .setName('enable')
            .setDescription('Aktifkan converter.'))
        .addSubcommand((sub) => sub
            .setName('disable')
            .setDescription('Nonaktifkan converter.'))
        .addSubcommand((sub) => sub
            .setName('status')
            .setDescription('Lihat status converter.'))
        .addSubcommand((sub) => sub
            .setName('reset')
            .setDescription('Reset channel dan status converter.')),

    async execute(interaction) {
        try {
            ensureAdmin(interaction);

            const guildId = interaction.guildId;
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'channel') {
                const channel = interaction.options.getChannel('channel', true);
                const config = await setBoomboxChannel(interaction.client, guildId, channel.id);

                await interaction.reply({
                    embeds: [{
                        title: 'SKAW BOOMBOX • CHANNEL',
                        description: `Channel converter sekarang ${channelText(config.channelId)}.`,
                        fields: [
                            { name: 'Status', value: config.enabled ? '🟢 Aktif' : '⚪ Nonaktif', inline: true },
                            { name: 'Platform', value: 'YouTube • TikTok • Spotify • SoundCloud', inline: true },
                        ],
                    }],
                });
                return;
            }

            if (subcommand === 'enable') {
                const current = await getBoomboxConfig(interaction.client, guildId);
                if (!current.channelId) {
                    await interaction.reply({
                        content: 'Set channel dulu dengan `/boombox-config channel`.',
                    });
                    return;
                }

                const config = await setBoomboxEnabled(interaction.client, guildId, true);
                await interaction.reply({
                    content: `✅ SKAW Boombox Converter **aktif** di ${channelText(config.channelId)}.`,
                });
                return;
            }

            if (subcommand === 'disable') {
                const config = await setBoomboxEnabled(interaction.client, guildId, false);
                await interaction.reply({
                    content: `⏸️ SKAW Boombox Converter **nonaktif**. Channel tetap ${channelText(config.channelId)}.`,
                });
                return;
            }

            if (subcommand === 'reset') {
                await resetBoomboxConfig(interaction.client, guildId);
                await interaction.reply({
                    content: '♻️ Konfigurasi SKAW Boombox Converter berhasil di-reset.',
                });
                return;
            }

            const config = await getBoomboxConfig(interaction.client, guildId);
            const { getBoomboxRuntimeStatus } = await import('../../services/boomboxService.js');
            const runtime = getBoomboxRuntimeStatus(interaction.client);
            await interaction.reply({
                embeds: [{
                    title: 'SKAW BOOMBOX • STATUS',
                    fields: [
                        { name: 'Status', value: config.enabled ? '🟢 Aktif' : '⚪ Nonaktif', inline: true },
                        { name: 'Channel', value: channelText(config.channelId), inline: true },
                        { name: 'Queue', value: String(runtime.queue), inline: true },
                        { name: 'Processing', value: `${runtime.processing}/${runtime.maxConcurrent}`, inline: true },
                    ],
                    footer: { text: 'URL hanya diproses pada channel yang dipilih.' },
                }],
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Terjadi error.';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: `❌ ${message}`, ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ content: `❌ ${message}`, ephemeral: true }).catch(() => {});
            }
        }
    },
};
