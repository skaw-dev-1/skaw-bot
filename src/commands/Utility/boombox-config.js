import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getBoomboxConfig, getBoomboxHistory, resetBoomboxConfig, setBoomboxChannel, setBoomboxEnabled } from '../../services/boomboxStorageService.js';
import { getBoomboxRuntimeStatus, startBoomboxService } from '../../services/boomboxService.js';

function requireManageGuild(interaction) {
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
            .addChannelOption((option) => option
                .setName('channel')
                .setDescription('Channel untuk menerima perintah Boombox.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)))
        .addSubcommand((sub) => sub.setName('enable').setDescription('Aktifkan converter.'))
        .addSubcommand((sub) => sub.setName('disable').setDescription('Nonaktifkan converter.'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Lihat status converter.'))
        .addSubcommand((sub) => sub.setName('test').setDescription('Test FFmpeg dan yt-dlp di server.'))
        .addSubcommand((sub) => sub.setName('reset').setDescription('Reset konfigurasi converter.')),

    async execute(interaction) {
        try {
            requireManageGuild(interaction);
            const action = interaction.options.getSubcommand();
            const guildId = interaction.guildId;

            if (action === 'channel') {
                const channel = interaction.options.getChannel('channel', true);
                const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
                const permissions = channel.permissionsFor(me || interaction.client.user);
                if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                    throw new Error('Bot membutuhkan View Channel, Send Messages, dan Embed Links pada channel tersebut.');
                }
                const config = await setBoomboxChannel(interaction.client, guildId, channel.id);
                startBoomboxService(interaction.client);
                await interaction.reply(`✅ Channel Boombox diset ke ${channel}. Status: ${config.enabled ? '🟢 Aktif' : '⚪ Nonaktif'}.`);
                return;
            }

            if (action === 'enable') {
                const current = await getBoomboxConfig(interaction.client, guildId);
                if (!current.channelId) throw new Error('Tentukan channel dulu dengan `/boombox-config channel`.');
                const config = await setBoomboxEnabled(interaction.client, guildId, true);
                startBoomboxService(interaction.client);
                await interaction.reply(`✅ SKAW Boombox **aktif** di <#${config.channelId}>. Gunakan \\`!bb <URL>\\` atau \\`/bb\\`.`);
                return;
            }

            if (action === 'disable') {
                const config = await setBoomboxEnabled(interaction.client, guildId, false);
                await interaction.reply(`⏸️ SKAW Boombox **nonaktif**. Channel tetap <#${config.channelId || 'unknown'}>.`);
                return;
            }

            if (action === 'reset') {
                await resetBoomboxConfig(interaction.client, guildId);
                await interaction.reply('♻️ Konfigurasi SKAW Boombox berhasil di-reset.');
                return;
            }

            if (action === 'test') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                try {
                    const { ensureConverterReady } = await import('../../services/boomboxConversionService.js');
                    const ready = await ensureConverterReady();
                    await interaction.editReply([
                        '✅ **Converter engine siap.**',
                        `FFmpeg: \\`${ready.ffmpeg}\\``,
                        `yt-dlp: \\`${ready.ytDlp}\\``,
                        `Platform: \\`${ready.platform}\\``,
                    ].join('\n'));
                } catch (error) {
                    const text = error instanceof Error ? error.message : String(error);
                    await interaction.editReply(`❌ **Converter engine belum siap.**\n${text}`);
                }
                return;
            }

            const config = await getBoomboxConfig(interaction.client, guildId);
            const live = getBoomboxRuntimeStatus(interaction.client);
            const history = await getBoomboxHistory(interaction.client, guildId);
            await interaction.reply({
                embeds: [{
                    color: 0x2F80ED,
                    title: '📻 SKAW BOOMBOX • STATUS',
                    fields: [
                        { name: 'Status', value: config.enabled ? '🟢 Aktif' : '⚪ Nonaktif', inline: true },
                        { name: 'Channel', value: config.channelId ? `<#${config.channelId}>` : '`Belum diatur`', inline: true },
                        { name: 'Queue', value: `${live.queue}/${config.queueLimit}`, inline: true },
                        { name: 'Processing', value: `${live.processing}/${live.maxConcurrent}`, inline: true },
                        { name: 'History', value: String(history.length), inline: true },
                        { name: 'Cooldown', value: `${config.cooldownSeconds}s`, inline: true },
                        { name: 'Supported', value: 'YouTube • TikTok • Spotify • SoundCloud', inline: false },
                    ],
                    footer: { text: 'Convert: !bb <URL> • /bb url:<URL> • Re-convert: !bb ulang <URL Top4toP>' },
                }],
            });
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
            } else {
                await interaction.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    },
};
