'use strict';

/**
 * Översätter tekniska anslutningsfel till begripliga, lokaliserade meddelanden
 * med en konkret felsökningsledtråd. `t` är homey.__ (eller Homey.__ i UI).
 */
module.exports = function explainError(err, t, { host, port } = {}) {
  const where = `${host || '?'}:${port || 502}`;
  switch (err && err.code) {
    case 'CONNECT_TIMEOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return t('errors.unreachable', { where });
    case 'ECONNREFUSED':
      return t('errors.refused', { where });
    case 'CLOSED':
    case 'ECONNRESET':
    case 'EPIPE':
      return t('errors.slot_taken');
    case 'RESPONSE_TIMEOUT':
      return t('errors.no_response');
    case 'MODBUS_EXCEPTION':
      return t('errors.modbus_exception', { code: err.modbusCode });
    default:
      return (err && err.message) || String(err);
  }
};
