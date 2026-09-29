import { MessageFlags, SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('bb')
        .setDescription('Convert audio menjadi MP3 Boombox SKAW atau generate ulang.')
        .addStringOption((option) => option
            .setName('url')
            .setDescription('URL YouTube, TikTok, Spotify, SoundCloud, atau URL Top4toP saat ulang.')
            .setRequired(true))
        .addBooleanOption((option) => option
            .setName('ulang')
            .setDescription('Generate URL Top4toP baru dari sumber tersimpan.')
            .setRequired(false)),

    async execute(interaction) {
        try {
            const { executeBbSlash } = await import('../../services/boomboxService.js');
            await executeBbSlash(interaction);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            const payload = { content: `❌ ${text}`, flags: MessageFlags.Ephemeral };
            if (interaction?.replied || interaction?.deferred) await interaction.followUp(payload).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
        }
    },
};
