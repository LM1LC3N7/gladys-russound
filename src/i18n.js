// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration button, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');
const onOff = (value, [en1, en0, enU], [fr1, fr0, frU]) =>
  value === true ? [en1, fr1] : value === false ? [en0, fr0] : [enU, frU];

export const T = {
  noDevice: both(
    'No controller known yet: type their IP addresses in the configuration.',
    'Aucun contrôleur connu : saisissez leurs adresses IP dans la configuration.',
  ),
  check: (lines, range) => ({
    en: [
      ...lines.map((l) => l.en),
      `Volume: 100 % in Gladys is ${range.maxVolume} on the Russound scale (0 to 50), the cap`,
    ].join(' · '),
    fr: [
      ...lines.map((l) => l.fr),
      `Volume : 100 % dans Gladys correspond à ${range.maxVolume} sur l'échelle Russound (0 à 50), le plafond`,
    ].join(' · '),
  }),
  checkController: (label, info, error) => {
    if (!info) {
      const reason = error ? ` (${error})` : '';
      return both(`${label}: not connected${reason}`, `${label} : non connecté${reason}`);
    }
    const mac = info.mac ? `, MAC ${info.mac}` : '';
    return both(
      `${label}: connected, RIO ${info.version}${mac}, ${info.zones} zone(s)`,
      `${label} : connecté, RIO ${info.version}${mac}, ${info.zones} zone(s)`,
    );
  },
  checkZone: (label, zone) => {
    const [enPower, frPower] = onOff(
      zone?.status,
      ['on', 'off', 'power unknown'],
      ['allumée', 'éteinte', 'marche inconnue'],
    );
    const [enMute, frMute] = onOff(
      zone?.mute,
      ['muted', 'not muted', 'mute unknown'],
      ['sourdine', 'sans sourdine', 'sourdine inconnue'],
    );
    const volume = Number.isFinite(zone?.volume) ? `volume ${zone.volume}` : undefined;
    const source = zone?.currentSource ? `source ${zone.currentSource}` : undefined;
    return both(
      `${label}: ${[enPower, volume ?? 'volume unknown', enMute, source].filter(Boolean).join(', ')}`,
      `${label} : ${[frPower, volume ?? 'volume inconnu', frMute, source].filter(Boolean).join(', ')}`,
    );
  },
  unreachable: (names) =>
    both(
      `Not connected (off or unreachable), tried again at spaced intervals: ${list(names)}.`,
      `Non connectés (éteints ou injoignables), réessayés à intervalles espacés : ${list(names)}.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No Russound controller answers yet at: ${list(addresses)}.`,
      `Aucun contrôleur Russound ne répond encore à : ${list(addresses)}.`,
    ),
  otherController: (addresses) =>
    both(
      `Another controller (another MAC address) answers at: ${list(addresses)}; its zones are neither read nor commanded. Give your controller a fixed IP address.`,
      `Un autre contrôleur (autre adresse MAC) répond à : ${list(addresses)} ; ses zones ne sont ni lues ni commandées. Donnez une adresse IP fixe à votre contrôleur.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved zone list was unreadable and was reset; the zones are found again from their addresses.',
    'La liste enregistrée des zones était illisible et a été réinitialisée ; les zones sont retrouvées par leurs adresses.',
  ),
};
