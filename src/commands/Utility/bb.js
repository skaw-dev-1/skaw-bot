import { SlashCommandBuilder } from 'discord.js';
import { executeBbSlash } from '../../services/boomboxService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('bb')
        .setDescription('Convert audio menjadi MP3 Boombox SKAW.')
        .addStringOption((option) => option
            .setName('url')
            .setDescription('URL YouTube, TikTok, Spotify, SoundCloud, atau Top4toP saat ulang.')
            .setRequired(true))
        .addBooleanOption((option) => option
            .setName('ulang')
            .setDescription('Buat URL Top4toP baru dari source yang tersimpan.')
            .setRequired(false)),

    async execute(interaction) {
        await executeBbSlash(interaction);
    },
};
