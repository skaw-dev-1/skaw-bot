// Registers SKAW Auto Message handlers into TitanBot's native interaction
// collections. The command installs these handlers automatically the first
// time /automessage is executed.

import { logger } from '../utils/logger.js';

const CREATE_MODAL_ID = 'skaw_am_v8_create_modal';
const END_MODAL_ID = 'skaw_am_v8_end_modal';
const INTERVAL_ID = 'skaw_am_v8_interval';
const EDIT_ID = 'skaw_am_v8_edit';
const SET_END_ID = 'skaw_am_v8_set_end';
const CLEAR_END_ID = 'skaw_am_v8_clear_end';
const CREATE_ID = 'skaw_am_v8_create';
const CANCEL_ID = 'skaw_am_v8_cancel';

const registeredClients = new WeakSet();

export function ensureAutoMessageInteractionHandlers(client, command) {
    if (!client || !command) return false;
    if (registeredClients.has(client)) return true;

    const handleModal = async (interaction) => command.handleModal(interaction);
    const handleComponent = async (interaction) => command.handleComponent(interaction, client);

    let registered = false;

    // TitanBot's app/client exposes native collections for modals, buttons and
    // select menus. Register directly so the existing interactionCreate event
    // can dispatch these interactions exactly like the built-in handlers.
    if (client.modals?.set) {
        client.modals.set(CREATE_MODAL_ID, {
            customId: CREATE_MODAL_ID,
            execute: handleModal,
        });
        client.modals.set(END_MODAL_ID, {
            customId: END_MODAL_ID,
            execute: handleModal,
        });
        registered = true;
    }

    if (client.selectMenus?.set) {
        client.selectMenus.set(INTERVAL_ID, {
            customId: INTERVAL_ID,
            execute: handleComponent,
        });
        registered = true;
    }

    if (client.buttons?.set) {
        for (const customId of [EDIT_ID, SET_END_ID, CLEAR_END_ID, CREATE_ID, CANCEL_ID]) {
            client.buttons.set(customId, {
                customId,
                execute: handleComponent,
            });
        }
        registered = true;
    }

    if (registered) {
        registeredClients.add(client);
        logger.debug('SKAW Auto Message native interaction handlers registered.');
        return true;
    }

    logger.warn('SKAW Auto Message could not register native interaction collections.');
    return false;
}
