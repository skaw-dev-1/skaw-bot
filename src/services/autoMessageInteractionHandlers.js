// SKAW GROUP Auto Message interaction router.
//
// TitanBot's generic interaction loader is startup-based. The Auto Message
// flow is created dynamically from /automessage, so we register ONE direct
// interactionCreate listener per Client and route only our v10 custom IDs.
// This avoids relying on mutating client.buttons/client.selectMenus/client.modals
// after startup, which can be missed by a dispatcher that uses startup snapshots.

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const registeredClients = new WeakSet();

const PREFIX = 'skaw_am_v10_';

export const AUTO_MESSAGE_INTERACTION_PREFIX = PREFIX;

export function isAutoMessageInteraction(interaction) {
    return typeof interaction?.customId === 'string'
        && interaction.customId.startsWith(PREFIX);
}

export function ensureAutoMessageInteractionHandlers(client, command) {
    if (!client || !command) return false;
    if (registeredClients.has(client)) return true;

    const listener = async (interaction) => {
        if (!isAutoMessageInteraction(interaction)) return;

        try {
            if (interaction.isModalSubmit()) {
                await command.handleModal(interaction);
                return;
            }

            if (interaction.isButton() || interaction.isStringSelectMenu()) {
                await command.handleComponent(interaction);
            }
        } catch (error) {
            logger.error('SKAW Auto Message interaction dispatch error:', error);

            try {
                const payload = {
                    content: 'Something went wrong while processing the Auto Message. Please try again.',
                    ephemeral: true,
                };

                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp(payload).catch(() => null);
                } else {
                    await interaction.reply(payload).catch(() => null);
                }
            } catch {
                // Never let a secondary reply failure become an unhandled rejection.
            }
        }
    };

    client.on(Events.InteractionCreate, listener);
    registeredClients.add(client);
    logger.info('SKAW Auto Message v10 direct interaction router registered.');
    return true;
}
