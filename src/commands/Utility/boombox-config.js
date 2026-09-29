import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getBoomboxConfig, resetBoomboxConfig, setBoomboxChannel, setBoomboxEnabled } from '../../services/boomboxStorageService.js';
import { getBoomboxRuntimeStatus } from '../../services/boomboxService.js';

function ensureAdmin(interaction) {
    if (!interaction.inGuild()) throw new Error('Command hanya bisa digunakan di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Kamu membutuhkan permission Manage Server.');
}

export default {
    data: new SlashCommandBuilder()
        .setName('boombox-config')
        .setDescription('Konfigurasi SKAW Boombox Converter.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) => sub
            .setName('channel')
            .setDescription('Pilih channel khusus converter.')
            .addChannelOption((opt) => opt
                .setName('channel')
                .setDescription('Channel converter.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)))
        .addSubcommand((sub) => sub.setName('enable').setDescription('Aktifkan converter.'))
        .addSubcommand((sub) => sub.setName('disable').setDescription('Nonaktifkan converter.'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Lihat status converter.'))
        .addSubcommand((sub) => sub.setName('test').setDescription('Cek yt-dlp dan FFmpeg tanpa melakukan upload.'))
        .addSubcommand((sub) => sub.setName('reset').setDescription('Reset konfigurasi converter.')),

    async execute(interaction) {
        try {
            ensureAdmin(interaction);
            const guildId = interaction.guildId;
            const action = interaction.options.getSubcommand();

            if (action === 'channel') {
                const channel = interaction.options.getChannel('channel', true);
                const config = await setBoomboxChannel(interaction.client, guildId, channel.id);
                await interaction.reply(`📻 Channel Boombox diset ke ${channel}. Status: ${config.enabled ? '🟢 Aktif' : '⚪ Nonaktif'}.`);
                return;
            }

            if (action === 'enable') {
                const current = await getBoomboxConfig(interaction.client, guildId);
                if (!current.channelId) {
                    await interaction.reply('⚠️ Set channel dulu dengan `/boombox-config channel`.');
                    return;
                }
                const config = await setBoomboxEnabled(interaction.client, guildId, true);
                const { startBoomboxService } = await import('../../services/boomboxService.js');
                startBoomboxService(interaction.client);
                await interaction.reply(`✅ SKAW Boombox aktif di <#${config.channelId}>. Gunakan \/bb atau !bb.`);
                return;
            }

            if (action === 'disable') {
                const config = await setBoomboxEnabled(interaction.client, guildId, false);
                await interaction.reply(`⏸️ SKAW Boombox dinonaktifkan. Channel tetap <#${config.channelId}>.`);
                return;
            }

            if (action === 'reset') {
                await resetBoomboxConfig(interaction.client, guildId);
                await interaction.reply('♻️ Konfigurasi SKAW Boombox berhasil di-reset.');
                return;
            }

            if (action === 'test') {
                await interaction.deferReply({ ephemeral: true });
                try {
                    const { ensureConverterReady } = await import('../../services/boomboxConversionService.js');
                    const ready = await ensureConverterReady();
                    await interaction.editReply(`✅ Converter engine siap.\nFFmpeg: ${ready.ffmpeg}\nyt-dlp: ${ready.version}`);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await interaction.editReply(`❌ Converter engine belum siap.\n${message}`);
                }
                return;
            }

            const config = await getBoomboxConfig(interaction.client, guildId);
            const live = getBoomboxRuntimeStatus(interaction.client);
            const history = await (await import('../../services/boomboxStorageService.js')).getBoomboxHistory(interaction.client, guildId);
            await interaction.reply({
                embeds: [{
                    title: '📻 SKAW BOOMBOX • STATUS',
                    fields: [
                        { name: 'Status', value: config.enabled ? '🟢 Aktif' : '⚪ Nonaktif', inline: true },
                        { name: 'Channel', value: config.channelId ? `<#${config.channelId}>` : '`Belum diatur`', inline: true },
                        { name: 'Queue', value: `${live.queue}/${config.queueLimit}`, inline: true },
                        { name: 'Processing', value: `${live.processing}/${live.maxConcurrent}`, inline: true },
                        { name: 'Riwayat', value: String(history.length), inline: true },
                        { name: 'Platform', value: 'YouTube • TikTok • Spotify • SoundCloud', inline: true },
                    ],
                    footer: { text: 'Prefix: !bb • Slash: /bb • Re-convert: ulang:true' },
                }],
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: `❌ ${message}`, ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ content: `❌ ${message}`, ephemeral: true }).catch(() => {});
            }
        }
    },
};
