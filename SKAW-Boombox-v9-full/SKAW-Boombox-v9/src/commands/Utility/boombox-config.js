import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  getBoomboxConfig,
  getBoomboxHistory,
  resetBoomboxConfig,
  setBoomboxChannel,
  setBoomboxEnabled,
} from '../../services/boomboxStorageService.js';
import { ensureConverterReady } from '../../services/boomboxConversionService.js';
import { getBoomboxRuntimeStatus, startBoomboxService } from '../../services/boomboxService.js';

function requireManageGuild(interaction) {
  if (!interaction?.guildId) throw new Error('Command hanya bisa digunakan di server.');
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('Kamu membutuhkan permission Manage Server.');
  }
}

function durationLabel(seconds) {
  const total = Number(seconds || 0);
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}m ${String(remaining).padStart(2, '0')}s`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('boombox-config')
    .setDescription('Konfigurasi SKAW Boombox Converter.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub
      .setName('channel')
      .setDescription('Tentukan satu channel tempat command Boombox diterima.')
      .addChannelOption((opt) => opt
        .setName('channel')
        .setDescription('Text channel untuk /bb dan !bb.')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)))
    .addSubcommand((sub) => sub.setName('enable').setDescription('Aktifkan converter.'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Nonaktifkan converter.'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Lihat konfigurasi dan queue.'))
    .addSubcommand((sub) => sub.setName('test').setDescription('Tes Node, FFmpeg, yt-dlp, dan Top4toP.'))
    .addSubcommand((sub) => sub.setName('reset').setDescription('Reset konfigurasi dan riwayat Boombox.')),

  async execute(interaction) {
    try {
      requireManageGuild(interaction);
      const action = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (action === 'channel') {
        const channel = interaction.options.getChannel('channel', true);
        const config = await setBoomboxChannel(interaction.client, guildId, channel.id);
        await interaction.reply({
          content: `✅ Channel Boombox diatur ke ${channel}. Status: ${config.enabled ? '🟢 aktif' : '⚪ belum aktif'}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'enable') {
        const current = await getBoomboxConfig(interaction.client, guildId);
        if (!current.channelId) throw new Error('Atur channel dulu dengan `/boombox-config channel`.');
        const config = await setBoomboxEnabled(interaction.client, guildId, true);
        startBoomboxService(interaction.client);
        await interaction.reply({
          content: `✅ SKAW Boombox aktif di <#${config.channelId}>. Gunakan \/bb atau !bb di channel tersebut.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'disable') {
        const config = await setBoomboxEnabled(interaction.client, guildId, false);
        await interaction.reply({
          content: `⏸️ SKAW Boombox dinonaktifkan. Channel tersimpan: ${config.channelId ? `<#${config.channelId}>` : 'belum diatur'}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'reset') {
        await resetBoomboxConfig(interaction.client, guildId);
        await interaction.reply({
          content: '♻️ Konfigurasi dan riwayat SKAW Boombox berhasil di-reset.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'test') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const ready = await ensureConverterReady({ checkTop4Top: true });
          const top = ready.top4top;
          const embed = new EmbedBuilder()
            .setColor(0x0B3B8F)
            .setTitle('🧪 SKAW BOOMBOX • ENGINE TEST')
            .setDescription('Semua pemeriksaan dasar berhasil.')
            .addFields(
              { name: 'Node.js', value: `\`${ready.nodeVersion}\``, inline: true },
              { name: 'Linux libc', value: `\`${ready.libc}\``, inline: true },
              { name: 'yt-dlp', value: `\`${ready.ytDlpVersion}\``, inline: true },
              { name: 'Asset', value: `\`${ready.asset}\``, inline: true },
              { name: 'FFmpeg', value: '✅ executable', inline: true },
              { name: 'Top4toP', value: `✅ reachable\n\`${top.fileField}\``, inline: true },
            )
            .setFooter({ text: 'SKAW GROUP • Converter v9' });
          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          await interaction.editReply({ content: `❌ Engine test gagal.\n${text}`, embeds: [] });
        }
        return;
      }

      const config = await getBoomboxConfig(interaction.client, guildId);
      const history = await getBoomboxHistory(interaction.client, guildId);
      const runtime = getBoomboxRuntimeStatus(interaction.client);
      const embed = new EmbedBuilder()
        .setColor(0x0B3B8F)
        .setTitle('📻 SKAW BOOMBOX • STATUS')
        .addFields(
          { name: 'Status', value: config.enabled ? '🟢 Aktif' : '⚪ Nonaktif', inline: true },
          { name: 'Channel', value: config.channelId ? `<#${config.channelId}>` : 'Belum diatur', inline: true },
          { name: 'Queue', value: `${runtime.queue}/${config.queueLimit}`, inline: true },
          { name: 'Processing', value: `${runtime.processing}/${config.maxConcurrent}`, inline: true },
          { name: 'History', value: String(history.length), inline: true },
          { name: 'Max Duration', value: durationLabel(config.maxDurationSeconds), inline: true },
          { name: 'Max MP3', value: `${config.maxFileMb} MB`, inline: true },
          { name: 'Cooldown', value: `${config.cooldownSeconds}s`, inline: true },
        )
        .setDescription('Platform: YouTube • TikTok • Spotify • SoundCloud\nOutput: direct `http://` Top4toP MP3')
        .setFooter({ text: 'SKAW GROUP • /bb url:<URL> • ulang:true untuk URL baru' });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply({ content: `❌ ${text}`, embeds: [], components: [] }).catch(() => {});
      } else {
        await interaction.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },
};
