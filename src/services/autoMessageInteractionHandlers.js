// Reliable SKAW Auto Message interaction registration for TitanBot.
// Registers both v9 IDs and keeps compatibility with older v8 registrations
// so a mixed deployment cannot strand the modal after Submit.

import { logger } from '../utils/logger.js';

const CREATE_MODAL_ID = 'skaw_am_v8_create_modal';
const END_MODAL_ID = 'skaw_am_v8_end_modal';
const LEGACY_CREATE_MODAL_ID = 'automessage_create_modal';
const LEGACY_END_MODAL_ID = 'automessage_end_modal';

const INTERVAL_ID = 'skaw_am_v8_interval';
const EDIT_ID = 'skaw_am_v8_edit';
const SET_END_ID = 'skaw_am_v8_set_end';
const CLEAR_END_ID = 'skaw_am_v8_clear_end';
const CREATE_ID = 'skaw_am_v8_create';
const CANCEL_ID = 'skaw_am_v8_cancel';

const registeredClients = new WeakSet();

function register(map, ids, handler) {
    if (!map?.set) return false;
    for (const customId of ids) {
        map.set(customId, { customId, execute: handler });
    }
    return true;
}

export function ensureAutoMessageInteractionHandlers(client, command) {
    if (!client || !command) return false;
    if (registeredClients.has(client)) return true;

    const handleModal = async (interaction) => command.handleModal(interaction, client);
    const handleComponent = async (interaction) => command.handleComponent(interaction, client);

    let registered = false;

    // Canonical IDs used by v9, plus legacy modal IDs so an older modal that is
    // still open during a rolling deployment can still be submitted safely.
    registered ||= register(
        client.modals,
        [CREATE_MODAL_ID, END_MODAL_ID, LEGACY_CREATE_MODAL_ID, LEGACY_END_MODAL_ID],
        handleModal,
    );

    registered ||= register(client.selectMenus, [INTERVAL_ID], handleComponent);
    registered ||= register(
        client.buttons,
        [EDIT_ID, SET_END_ID, CLEAR_END_ID, CREATE_ID, CANCEL_ID],
        handleComponent,
    );

    if (registered) {
        registeredClients.add(client);
        logger.info('SKAW Auto Message interaction handlers registered.');
        return true;
    }

    logger.warn('SKAW Auto Message could not register interaction handlers: native client collections unavailable.');
    return false;
}
