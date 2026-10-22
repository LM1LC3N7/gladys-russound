# gladys-russound

[Gladys Assistant](https://gladysassistant.com) external integration for
**Russound** multiroom controllers with the RIO protocol on their network port
(MCA-66, MCA-88, MCA-88X, MCA-C3, MCA-C5, MBX-PRE, MBX-AMP…), on the local
network: one Gladys device per zone, with power on, standby, volume (capped by
an option), mute, source and what is playing, over TCP (port 9621), without
any cloud. The RS-232 serial port is not supported. Unofficial, not
affiliated with Russound.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake controller
> only, never with a real Russound device.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (RussoundApp)
                                   ├─ src/russound/link.js      one address: TCP connection, checks, snapshot, WATCH, poll, spaced reconnection
                                   ├─ src/russound/protocol.js  commands (closed list), lines, values, state (ported, untrusted input)
                                   ├─ src/model.js              known zones -> Gladys devices and states (pure)
                                   ├─ src/config.js             addresses, frozen zone ids, volume cap (0..50 <-> %)
                                   └─ src/store.js              /data/russound.json: zones, their sources, per address MAC and last attempt
```

- **Zones** are found from the typed IP addresses: `VERSION` (1.05.00 at
  least), `C[1].type`, `C[1].macAddress`, the RNET chain `C[2]`..`C[6]`, the
  sources `S[n].name` and the zones `C[c].Z[z].name`. The external id of a
  zone is frozen: `russound:<host>[_<port>]_c<c>_z<z>`. The MAC address,
  when readable, is kept per address and checked at every connection and
  poll: another controller at the address (DHCP swap) is neither read nor
  commanded; an unreadable MAC is never "another one".
- **One TCP connection per address**, kept open, with a `WATCH` on every zone
  and named source: pushed changes are published (grouped per zone, and all
  zones together under a global budget of 240 states a minute). A poll every
  minute. The RIO answers carry no request id: one exchange at a time, each
  answer checked against its request; a request without answer or an answer
  out of step closes the connection. Reconnection after 10 s, doubled up to
  5 minutes; the time of the last attempt and the failures are kept in
  `/data`, so a restart never asks sooner.
- **Commands**: validated first (volume an integer 0..100, source among the
  dropdown options), serialized per zone, each within a 3.5 s budget (Gladys
  acks in 5 s), and confirmed only by the value read back. The volume is
  mapped onto 0..`max_volume` (0..50 scale, 25 by default), read just before
  sending: 100 % is the cap. Mute is a press: the state is read and the
  explicit `ZoneMuteOn`/`ZoneMuteOff` sent (RIO 1.09.00+); unmuting and Power
  on first bring a volume above the cap back to it. Standby skips the zone
  queue, goes first on the connection, cancels a Power on waiting, opens the
  connection at once when needed, and is sent again (3 times at most) when
  not confirmed.
- **Features**: `music/volume`, `television/volume-mute`, `text/select`
  (source), `text/text` (now playing), `button/push` (power on, standby) and a
  read-only `unknown/binary` power state. No switch, no unit.
- **Bounded input**: lines of 1024 characters at most (longer ones dropped),
  one anchored expression per line, only the known keys read, values parsed
  strictly, tables without prototype, 32 exchanges waiting at most; only a
  real flood (more than 3000 lines in 10 s) closes the connection.

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake controller)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeRussound.js` is a fake Russound controller on 127.0.0.1
(VERSION, GET, WATCH and pushes, zone events, silent, slow and ignoring
modes). The end-to-end tests run the real handlers against the SDK's fake
Gladys.

## Credits

- [`aiorussound`](https://github.com/noahhusby/aiorussound) 5.0.2 (MIT, Noah
  Husby), the library behind the Home Assistant Russound RIO integration: the
  protocol, the discovery of controllers, sources and zones, and the commands
  are ported from its TCP transport to JavaScript.
- The app structure follows
  [LM1LC3N7/gladys-nad](https://github.com/LM1LC3N7/gladys-nad) (same author,
  Apache-2.0).

Russound is a trademark of its owner, used here only to name the compatible
products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (aiorussound, MIT):
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
