import { SlashCommandBuilder } from 'discord.js';
import { executeBbSlash } from '../../services/boomboxService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('bb')
    .setDescription('Convert audio menjadi URL MP3 Boombox SKAW.')
    .addStringOption((option) => option
      .setName('url')
      .setDescription('YouTube, TikTok, Spotify, SoundCloud; Top4toP hanya untuk ulang.')
      .setRequired(true))
    .addBooleanOption((option) => option
      .setName('ulang')
      .setDescription('Buat URL Top4toP baru dari source yang tersimpan.')
      .setRequired(false)),

  async execute(interaction) {
    await executeBbSlash(interaction);
  },
};
