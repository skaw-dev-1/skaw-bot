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
            .setDescription('Generate URL Top4toP baru dari sumber asli tersimpan.')
            .setRequired(false)),

    async execute(interaction) {
        try {
            await executeBbSlash(interaction);
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
