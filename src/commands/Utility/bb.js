import { SlashCommandBuilder } from 'discord.js';
import { handleBbSlashCommand } from '../../services/boomboxService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('bb')
        .setDescription('Convert audio ke MP3 Boombox atau cari riwayat.')
        .addStringOption((option) => option
            .setName('url')
            .setDescription('URL sumber atau kata kunci pencarian riwayat.')
            .setRequired(true))
        .addBooleanOption((option) => option
            .setName('ulang')
            .setDescription('Generate ulang dari URL sumber/Top4toP yang pernah dibuat SKAW.')
            .setRequired(false)),

    async execute(interaction) {
        try {
            await handleBbSlashCommand(interaction);
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
