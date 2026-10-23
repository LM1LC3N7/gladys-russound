# TODO — Russound v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control of the zones** (2026-10-22): controllers
      added by IP address (port 9621 by default), one persistent RIO
      connection per address with checks (version, type, MAC), snapshot,
      WATCH pushes, a poll a minute and spaced reconnection; one Gladys device
      per zone: power state, power on, standby, volume capped, mute, source
      dropdown, now playing; "Check" button; docs en/fr. Tested against a fake
      controller on the loopback interface only, never with a real device. The
      store validator could not be run from the development session (no
      access to it there): to run before the first release.
- [ ] **Milestone 2 — real controllers** (testers with an MCA or MBX). To
      check first:
  - the answers to GET (`S C[1].Z[1].volume="20"` assumed, with the full key),
    to WATCH and EVENT (a bare `S` assumed), and the order of the `N` dump
    after a WATCH;
  - whether `C[1].macAddress` is answered, and its format;
  - the turn-on volume behaviour (pushed `volume` after `ZoneOn`) and whether
    `KeyPress Volume` is refused (`E`) on a zone off;
  - whether `SelectSource` and `KeyPress Volume` turn a zone off on (review 1,
    I3): Source is refused on a zone read off until then; if it does turn the
    zone on, consider treating it as a Power on with every cap check;
  - whether several clients may be connected at once (the Russound app, a
    keypad bridge, Home Assistant);
  - the rendering on the Gladys dashboard (not checked here): the
    `television/volume-mute` press, the two `button/push`, the
    `unknown/binary` power, the `text/select` source and the `text/text`
    now playing.
- [ ] **Milestone 3 — more**: play / pause / next / previous buttons (on the
      streaming sources, `PROPERTY_AVAILABLE_CONTROLS`), tuner presets, the
      sources disabled per zone (`C[c].Z[z].S[s].enabled`, RIO 1.07.00+),
      bass / treble / balance / loudness, party mode, do not disturb.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: noahhusby/aiorussound 5.0.2 (MIT, 2026-08-14, the library of the Home
  Assistant Russound RIO integration) is Python, so its RIO protocol, the
  discovery of controllers, sources and zones, the zone events, the model
  facts (zones per model, RNET-capable models, type fixes) and the version
  gates (1.05.00 minimum, 1.09.00 for the explicit mute) are ported to
  JavaScript (`src/russound/`); MIT notice in `THIRD_PARTY_NOTICES.md`, copied
  into the image. **TCP only**: its serial transport and its RNET binary
  client are not ported (no serial port in a Gladys container). No runtime
  dependency besides the SDK (`node:net`). License checked in its `LICENSE`
  file (MIT, Noah Husby).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1. The
  manifest test never pins a version: it only checks the four agree and are
  semver.
- **Identity (frozen)**: the RIO protocol gives no serial number per zone and
  the MAC address of the controller is not always readable, so a zone is
  `gladys.externalIds('russound', '<host>[_<port>]_c<controller>_z<zone>')`
  (the port only when not 9621; `_` never appears in a host name). The docs
  ask for a fixed IP address. A created zone unknown to `/data` (file reset)
  is found again from its external id, its source options from the created
  device. The MAC address read at connection (`C[1].macAddress`) is kept per
  address in `/data` and checked at every connection and at every poll: a
  different, valid MAC means another controller (DHCP swap): connection
  refused (IDENTITY), its zones published off, never commanded, the status
  names the address. Unreadable or refused MAC: never "another controller".
  Lifted by removing the address and its zones (the address entry is
  forgotten with them), documented.
- One Gladys device per zone ("une zone par appareil"). Zones without a name
  are not published, as aiorussound skips them. 48 zones at most in all, 6
  controllers per connection, 16 zones per controller, 16 sources.
- Feature keys are frozen: `power`, `power_on`, `standby`, `volume`, `mute`,
  `source`, `now_playing`. Every publication carries the full, fixed feature
  list; only the source options grow (merged with the `supported_options` of
  the created device), relabelled when a source is renamed.
- **Power: read-only state + two `button/push` ("Power on", "Standby"), not a
  `switch`** (lesson of lot 6). `EVENT C[c].Z[z]!ZoneOn` / `ZoneOff`,
  confirmed by `status` read back.
- **Standby is protective, never blocked**: it skips the zone queue, goes
  first on the connection (after the one exchange already written), cancels a
  Power on still queued and, through `shouldSend` asked right before the
  write, one waiting on the connection ("Cancelled by Standby, nothing
  sent"), and the volume checks after a wake-up. It only needs the link to be
  `ready` (version, type and MAC checked), not the full snapshot: after a
  restart it is possible before the first full read (zone numbers kept in
  `/data`). When the link waits for its next attempt (backoff, restart
  delay), Standby opens it at once (`connectNow`): a pause never prevents
  turning a zone off. Sent but not confirmed: a reaffirmation chain reads the
  zone again every 5 s, 3 times at most, and sends `ZoneOff` again while it is
  on; a failed resend keeps the chain going; a Power on asked after the
  Standby ends it.
- **Volume cap** (brief: "volume plafonné par option"): the Russound scale is
  0..50; Gladys shows 0..100 % mapped linearly onto 0..`max_volume` (1..50, 25
  by default, half the scale as Home Assistant's own mapping would show 50 %).
  100 % is the cap: `percentToVolume` clamps, read inside the queued task
  just before the line leaves. The feature range stays 0..100 (frozen at
  creation). A volume above the cap shows 100 %, its raw value in "Check". A
  volume set on a keypad above the cap is not lowered, except by the two
  commands of Gladys that would make it heard: unmute (volume read first;
  above the cap, `KeyPress Volume <cap>`, read back at or under the cap, then
  `ZoneMuteOff`; unknown volume: refused; lowering not confirmed: refused,
  mute kept) and Power on (status and volume read after `ZoneOn`; above the
  cap, lowered and read back; otherwise checked again every 2.5 s, 6 times at
  most, through the zone queue; a volume pushed above the cap during that
  window is lowered too; the ack never depends on it). Never a guessed or
  capped "restore" value: the integration never restores a previous volume.
- Mute is a push: `C[c].Z[z].mute` read just before, the explicit
  `ZoneMuteOn` / `ZoneMuteOff` sent (RIO 1.09.00+), confirmed by the value
  read back. On an older firmware the only mute command is a toggle
  (`KeyRelease Mute`): refused, nothing sent (never a blind toggle).
- Commands: serialized per zone (mute before the commands waiting), budget
  3.5 s from the Gladys request, the waits included; each exchange bounded by
  what is left; a command still queued at its deadline is dropped, never sent
  late. **Confirmed only by the value read back** (GET after the `S`): a
  controller that answers `S` but keeps its value gives "sent, without
  confirmation". `E` gives "Refused by the controller". The ack never waits
  for a publication to Gladys.
- One exchange at a time per connection: RIO answers (`S`, `E`) carry no
  request id, so each answer is checked against the request it ends (a GET
  must be answered with its own key, VERSION with `VERSION`, WATCH and EVENT
  with a bare `S`). An answer without request or for another key means the
  two sides are out of step: the connection is closed and opened again,
  spaced out. Keyed answers and pushes are always applied to the state first:
  they carry the state of the controller.
- (Review 1, I1) The deadline of the caller and the life of an exchange on the
  wire are separate: at its deadline the caller gets "sent, without answer"
  (`sent: true`), but the exchange stays current, orphaned, until
  `requestTimeout` (1.5 s) at least after its write; its late answer is
  absorbed (it confirms nothing: a command is only confirmed by a GET read
  back, matched by key) and the next exchange follows. Only an exchange still
  unanswered past that ceiling closes the link. A command line (not Standby)
  is never written with less than `minSendBudget` (400 ms) left: "No time
  left, nothing sent" before any byte. A burst of volumes keeps the link.
- (Review 1, M2) An `S` line the strict expression refuses (a control
  character in a name) answers the current GET with an unreadable value,
  nothing applied (out of step otherwise); a bare `E` ends the request as
  refused. No reconnection loop on such a controller. (Review 2, R2-1) The
  answer keeps its `unreadable` mark: `readZone` then gives undefined, never
  the value in memory, so a read before a decision refuses ("nothing sent")
  and a read back never confirms ("sent, without confirmation").
- (Review 1, M3) Lines dropped as too long count in the flood guard.
- (Review 1, I2) Standby cancels the Power on, Source and Volume commands
  waiting in the zone queue, and every command line but its own gets
  `shouldSend: standbyAt < started`, so a command already running never
  writes after a Standby (a mute press included). (M1) A Power on whose
  `ZoneOn` left before a Standby is answered "sent, without confirmation".
  (M4) The Standby resend gets `shouldSend` too: a Power on asked while it
  waits on the connection wins. The reaffirmation can turn off, within its 15
  s, a zone turned on again from a keypad: wanted (a stop keeps its
  reaffirmation), documented.
- (Review 1, I3) Source is sent only on a zone whose status, read just
  before, is on; otherwise refused, nothing sent (`SelectSource` may turn a
  zone on at its turn-on volume, without the cap checks). Volume is left
  allowed: the value sent is already at or under the cap.
- (Review 1, M6) The queue of a zone holds 8 commands at most ("Too many
  commands waiting, nothing sent"); Standby never goes through it.
- Connection: one TCP connection per typed address and per address of a
  created zone, kept across reconnections to Gladys (`connected` only clears
  the status cache, the publication memory and `forgetPublishedStates`, then
  republishes the status, the devices and the states). Reconnection after
  10 s, doubled after each failure up to 5 minutes; the count is only reset by
  a connection that stayed up 60 s. **Never faster than the interval**: a
  configuration save or a Discovery scan asks for a reconnection never sooner
  than 10 s after the last attempt; a reconnection to Gladys asks nothing; the
  time of the last attempt is written to `/data` before the attempt, at most
  once a minute, with the failures in a row; a new link (restart,
  configuration save) waits until that time + 1 minute (the write period) +
  the interval of its failures, 6 minutes at most. A reconnection during a
  connection never starts another one (`connecting`).
- Late answers of an old link (address removed, configuration changed) are
  ignored: `linkEvent` checks the link is still the one of its address, the
  publications check the generation.
- Publication: grouped per zone (`publishDelay` 1 s), only the created zones,
  only the states that changed (own memory, cleared at `connected` and at
  device creation). **Global budget**: 240 states per 60 s for all zones
  together, reserved synchronously before any await (two simultaneous
  publications never both pass); over it, the publication waits for room. No
  `publishSceneEvent`, no energy index.
- Categories and types from the core only (`server/utils/constants.js`):
  `music/volume` (as the core Sonos service), `television/volume-mute` (music
  has no mute type), `text/select`, `text/text`, `button/push`,
  `unknown/binary`. No unit: `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none
  for music, television, text, button or unknown. Store category
  `multimedia`.
- Now playing: "artist - song", the song alone, else the channel or programme
  service name of the source of the zone; '' when the zone is off or nothing
  is known. 160 characters at most, cleaned of control and bidi characters.
- Hostile input: lines cut on CR or LF, 1024 characters at most (a longer one
  is dropped up to its end, parts kept in an array, never a quadratic
  concatenation), decoded as Latin-1, one anchored expression per line, only
  the known leaves of the known targets applied (zone: name, status, volume,
  mute, currentSource; source: names and metadata; controller: type,
  macAddress), values parsed strictly (ON/OFF, 0..50, 1..16, MAC), tables
  without prototype. Commands are built from a closed list, numbers only as
  arguments. Flood guard only for a real flood (3000 lines in 10 s; the WATCH
  dump of a large system is a few hundred lines): every line under it is
  decoded. 32 exchanges waiting at most.
- Discovery: no network capture in the manifest; Russound controllers
  announce nothing usable for RIO. The Discovery scan republishes the zones
  and asks the silent addresses again (never sooner than the interval).
- Port: 9621 as aiorussound. A serial port typed as an address (`COM3`,
  `/dev/ttyUSB0`) is refused as invalid.
- No secret, no account: no `secret` field, nothing to keep out of the logs
  but nothing to leak either; `/data` holds no personal data (addresses, zone
  and source names, MAC address of the controller, times).
