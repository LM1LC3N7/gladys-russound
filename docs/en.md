# Russound for Gladys

Control from Gladys each **zone** of your **Russound** multiroom controllers
with the RIO protocol on their network port (MCA-66, MCA-88, MCA-88X,
MCA-C3, MCA-C5, MBX-PRE, MBX-AMP…), locally, without any cloud: power on,
standby, volume (capped), mute, source and what is playing.

> **Important.** This integration has never been tested with a real device:
> it was written from the `aiorussound` library (the one Home Assistant
> uses) and tested against a fake controller only. Your feedback is welcome.
> Unofficial integration, not affiliated with Russound.

## Installation

1. Plug the controller into your network and give it a **fixed IP address**
   in your router (reserved DHCP lease).
2. In Gladys, install the **Russound** integration, then open its
   configuration.
3. Type the IP addresses of the controllers, separated by commas (for
   example `192.168.1.40`). The RIO port is 9621; for another one, add it:
   `192.168.1.40:9622`. One address is enough for controllers chained over
   RNET behind the first one.
4. Choose the **volume cap** (25 out of 50 by default).
5. The zones appear in the **Discovery** tab (one per named zone): create
   the ones you want.

The integration keeps a connection open with each controller and watches
every zone and source: what is changed on a keypad, a remote or the app
shows at once in Gladys. The zones are also read again every minute.

Only the network port is supported: the **RS-232 serial port** is not (a
Gladys integration runs in a container without access to the serial port),
nor the RNET-only protocol of older models (CAV, CAM) without a RIO port.

## What you get, for each zone

| Feature     | Gladys type                | Note                                                  |
| ----------- | -------------------------- | ----------------------------------------------------- |
| Power       | binary state (read only)   | 1 zone on, 0 off or controller unreachable            |
| Power on    | button                     | `ZoneOn`                                              |
| Standby     | button                     | `ZoneOff`                                             |
| Volume      | music / volume (0 to 100)  | 100 % = the cap                                       |
| Mute        | button (television / mute) | each press reads the state, then sets the opposite    |
| Source      | dropdown                   | the named sources of the controller                   |
| Now playing | text (read only)           | "artist - title", or the station; empty when zone off |

On purpose, no **switch**: an "everything off" or "everything on" of a voice
assistant or a scene neither turns your zones on nor off.

## Volume cap

Russound controllers count the volume from 0 to 50. In Gladys, the volume
goes from 0 to 100 %: 100 % is the **cap** of the configuration (25 by
default). Gladys (dashboard, scene, voice assistant) can never set a volume
above the cap. The cap is read again just before sending: a new value saved
applies at once.

The volume set on a keypad or a remote is not changed by the integration
(above the cap, Gladys shows 100 %), except in the two cases where Gladys
would make it heard:

- **Unmute**: when the volume of the zone is above the cap, it is first
  brought back to the cap, then the mute is removed. When the volume cannot
  be read, nothing is sent; when the controller does not confirm the
  lowering, the mute is kept.
- **Power on**: a zone turns on at its "turn-on volume"; above the cap, it is
  brought back to it, until the controller confirms a volume at or under the
  cap. When the zone is slow, the integration checks a few more times for
  about 15 seconds, and lowers a volume reported above the cap meanwhile.

## Commands

A command succeeds only when the value read back from the controller is the
one asked. Every command is answered within 4 seconds (Gladys waits 5
seconds). A command that left without confirmation is reported "sent,
without confirmation"; a command that could not leave is reported "nothing
sent".

**Standby** goes before every command waiting, cancels a Power on still
waiting, and stays possible right after a restart, before the first full
read: when the connection waits for its next attempt, it is opened at once.
A Standby not confirmed is read again and sent again up to three times,
unless a Power on is asked meanwhile.

**Mute** uses the explicit `ZoneMuteOn` / `ZoneMuteOff` commands (RIO
1.09.00 or later); on an older firmware, which can only toggle the mute, it
is refused without sending anything.

## Identity of the zones

Each zone is known by the address of the controller, the number of the
controller and the one of the zone (for example `192.168.1.40_c1_z3`): keep
a fixed IP address. The MAC address of the controller, when it tells it, is
kept: when another controller answers at this address one day (DHCP swap),
its zones are neither read nor commanded and the status says so. If you
replaced the controller, remove its address from the configuration, delete
its zones in Gladys, then add it again. An unreadable MAC address is never
taken for another controller.

## Reconnection

A controller that does not answer (off, unplugged) shows the power of its
zones at 0 and is named in the integration status. The integration connects
again after 10 s, then at intervals doubled after each failure, up to 5
minutes; a request without answer closes the connection, then the same
spaced reconnection applies. The time of the last attempt is kept: a restart
of the integration never asks the controller faster.

## Configuration button

- **Check the controllers**: the connection, the RIO version, the MAC
  address and the number of zones of each controller, the state of each zone
  (power, volume out of 50, mute, source), and the cap in force.

## Data and privacy

The integration asks for no account and no password: the RIO port has none.
It keeps in `/data/russound.json` the known zones (address, numbers, name,
sources), and for each address the MAC address of the controller, the time
of the last connection attempt and the number of failures. Nothing leaves
your local network.

## Known limits

- No play / pause / next yet, no tuner presets, bass, treble, balance,
  loudness, party mode nor "do not disturb".
- The source list does not take into account the sources disabled for a
  zone.
- Limited use in France, Belgium and Switzerland: Russound is mostly
  installed in North America.
- Never tested with a real device: the real answers may differ.
