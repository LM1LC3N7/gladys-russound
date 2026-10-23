# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

### Changed

- A duplicate code comment removed in the RIO link; no change in behaviour.
  The decision recorded in `TODO.md` for unreadable answers (already in
  0.1.1: an unreadable value never stands for a read, so nothing is decided
  or confirmed on it) is now written down.

## [0.1.1] - 2026-10-22

### Added

- Russound multiroom controllers with the RIO protocol on their network port
  (TCP 9621 by default), added by IP address, without any cloud; the
  controllers chained over RNET are found through the first one. The RS-232
  serial port is not supported.
- One Gladys device per zone: power state (read only), "Power on" and
  "Standby" buttons, volume (0 to 100 %, validated strictly, mapped onto 0 to
  the new `max_volume` option of the Russound 0-50 scale: 100 % is the cap, 25
  by default, never exceeded), mute (each press reads the mute and sets the
  opposite), a "Source" dropdown with the names of the controller, and a "Now
  playing" text.
- Changes made on a keypad, a remote or the app are pushed to Gladys (WATCH),
  grouped per zone and under a global budget of 240 states a minute; the
  zones are also read again every minute.
- Every command is confirmed by the value read back, answered to Gladys
  within 4 seconds, or dropped, never sent late.
- Unmuting lowers a volume above the cap to the cap first (mute kept when the
  lowering is not confirmed); Power on brings the turn-on volume back to the
  cap.
- Standby goes before every command waiting, cancels a Power on still
  waiting, opens the connection at once when it waits for its next attempt
  (also right after a restart), and is sent again up to three times when not
  confirmed.
- The MAC address of a controller is kept and checked: another controller at
  the same address is neither read nor commanded, and named in the status.
- A controller that does not answer shows its zones off and is named in the
  status; it is connected again after 10 s, then at intervals doubled up to 5
  minutes; the time of the last attempt is kept in `/data`, so a restart never
  asks sooner.
- "Check the controllers" button.

### Fixed

- A burst of commands on a slow controller no longer closes the connection:
  a command line is never written with less than 400 ms left, and an exchange
  past its deadline waits for its late answer (which confirms nothing) before
  the next one.
- Standby also cancels a Source or Volume command waiting, and drops the one
  waiting on the connection: a zone is never turned on again after it.
- Source on a zone read off is refused ("turn it on first, nothing sent"): it
  could turn the zone on at its turn-on volume, above the cap.
- A Power on overridden by a Standby after it left is reported "sent, without
  confirmation", never as done.
- An answer with an unreadable value (a control character in a name) or a
  bare `E` ends its request instead of a reconnection loop.
- The Standby resend is dropped when a Power on is asked while it waits.
- The command queue of a zone is bounded (8).

### Security

- Commands are built from a closed list (numbers only as arguments); lines are
  bounded (1024 characters) and parsed once by an anchored expression; only the
  expected keys are read; an answer out of step closes the connection; the
  tables of the state and of `/data` have no prototype.
- Lines dropped as too long count in the flood guard; no bidirectional control
  character is written as such in the sources (checked by a test).

[Unreleased]: https://github.com/LM1LC3N7/gladys-russound/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-russound/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-russound/releases/tag/v0.1.1
