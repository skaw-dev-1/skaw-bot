import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getBoomboxConfig, getBoomboxHistory, resetBoomboxConfig, setBoomboxChannel, setBoomboxEnabled } from '../../services/boomboxStorageService.js';

function assertGuildAdmin(interaction) {
    if (!interaction?.guildId) throw new Error('Command hanya bisa digunakan di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Kamu membutuhkan permission Manage Server.');
}

export default {
    data: new SlashCommandBuilder()
        .setName('boombox-config')
        .setDescription('Konfigurasi SKAW Boombox Converter.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) => sub.setName('channel').setDescription('Pilih channel converter.').addChannelOption((opt) => opt
            .setName('channel').setDescription('URL hanya diproses pada channel ini.').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand((sub) => sub.setName('enable').setDescription('Aktifkan converter.'))
        .addSubcommand((sub) => sub.setName('disable').setDescription('Nonaktifkan converter.'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Lihat status converter.'))
        .addSubcommand((sub) => sub.setName('test').setDescription('Tes FFmpeg dan yt-dlp standalone.'))
        .addSubcommand((sub) => sub.setName('reset').setDescription('Reset konfigurasi converter.')),

    async execute(interaction) {
        try {
            assertGuildAdmin(interaction);
            const action = interaction.options.getSubcommand();
            const guildId = interaction.guildId;

            if (action === 'channel') {
                const channel = interaction.options.getChannel('channel', true);
                const config = await setBoomboxChannel(interaction.client, guildId, channel.id);
                await interaction.reply(`✅ Channel Boombox diset ke ${channel}. Status: ${config.enabled ? '🟢 Aktif' : '⚪ Nonaktif'}.`);
                return;
            }

            if (action === 'enable') {
                const current = await getBoomboxConfig(interaction.client, guildId);
                if (!current.channelId) throw new Error('Set channel dulu dengan `/boombox-config channel`.');
                const config = await setBoomboxEnabled(interaction.client, guildId, true);
                const { startBoomboxService } = await import('../../services/boomboxService.js');
                startBoomboxService(interaction.client);
                await interaction.reply(`✅ SKAW Boombox aktif di <#${config.channelId}>. Gunakan \`!bb <URL>\` atau \`/bb\`.`);
                return;
            }

            if (action === 'disable') {
                const config = await setBoomboxEnabled(interaction.client, guildId, false);
                await interaction.reply(`⏸️ SKAW Boombox dinonaktifkan. Channel tetap <#${config.channelId || 'belum diatur'}>.`);
                return;
            }

            if (action === 'reset') {
                await resetBoomboxConfig(interaction.client, guildId);
                await interaction.reply('♻️ Konfigurasi SKAW Boombox di-reset.');
                return;
            }

            if (action === 'test') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                try {
                    const { ensureConverterReady } = await import('../../services/boomboxConversionService.js');
                    const ready = await ensureConverterReady();
                    await interaction.editReply(`✅ Converter engine siap.\n**FFmpeg:** \`${ready.ffmpeg}\`\n**yt-dlp:** \`${ready.ytDlpVersion}\`\n**Asset:** \`${ready.asset}\`\n**Path:** \`${ready.ytDlpPath}\``);
                } catch (error) {
                    const text = error instanceof Error ? error.message : String(error);
                    await interaction.editReply(`❌ Converter engine belum siap.\n${text}`);
                }
                return;
            }

            const config = await getBoomboxConfig(interaction.client, guildId);
            const history = await getBoomboxHistory(interaction.client, guildId);
            const { getBoomboxRuntimeStatus } = await import('../../services/boomboxService.js');
            const runtime = getBoomboxRuntimeStatus(interaction.client);

            await interaction.reply({
                embeds: [{
                    color: 0x2F80ED,
                    title: '📻 SKAW BOOMBOX • STATUS',
                    fields: [
                        { name: 'Status', value: config.enabled ? '🟢 Aktif' : '⚪ Nonaktif', inline: true },
                        { name: 'Channel', value: config.channelId ? `<#${config.channelId}>` : '`Belum diatur`', inline: true },
                        { name: 'Queue', value: `${runtime.queue}/${config.queueLimit}`, inline: true },
                        { name: 'Processing', value: `${runtime.processing}/${runtime.maxConcurrent}`, inline: true },
                        { name: 'History', value: String(history.length), inline: true },
                        { name: 'Platform', value: 'YouTube • TikTok • Spotify • SoundCloud', inline: true },
                    ],
                    footer: { text: 'SKAW GROUP • !bb / /bb • ulang untuk re-convert' },
                }],
            });
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (interaction?.deferred || interaction?.replied) await interaction.followUp({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
            else await interaction.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    },
};
