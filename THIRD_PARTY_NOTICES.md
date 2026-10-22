# Third-party notices

This integration ports to JavaScript the logic of the following project: the
Russound RIO protocol over TCP (commands ended by `\r`: `VERSION`,
`GET <key>`, `WATCH <branch> ON`, `EVENT C[c].Z[z]!<event>`; answers `S`,
`S <key>="<value>"`, `E <message>`; pushed changes `N <key>="<value>"`), the
reading of the answers (a value `------` is empty), the minimum RIO version
(1.05.00) and the version of the explicit mute events (1.09.00), the discovery
of the controllers (`C[1].type`, the RNET chain `C[2]` to `C[6]` on the models
that have it, `C[1].macAddress`), of the sources (`S[1].name`..., stopped at
the first refusal) and of the zones (`C[c].Z[z].name`, the number of zones per
model, the names some firmwares give to a model), the zone events (`ZoneOn`,
`ZoneOff`, `ZoneMuteOn`, `ZoneMuteOff`, `KeyPress Volume <n>`,
`SelectSource <n>`), the volume scale 0 to 50, and the port 9621
(`src/russound/`). Only its TCP transport is ported: its RS-232 serial
transport and its RNET binary protocol are not. Nothing of it is installed at
runtime; its notice is reproduced below.

## aiorussound 5.0.2

<https://github.com/noahhusby/aiorussound> (the library behind the Home
Assistant Russound RIO integration), version 5.0.2 of 2026-08-14

```
MIT License

Copyright (c) 2024 Noah Husby

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LM1LC3N7/gladys-nad

The structure of the app, the persistent link with its queue, deadlines and
spaced reconnection, the command queue and budget, the volume cap on unmute
and power on, the `/data` store and the handler wiring follow this
integration of the same author, under the Apache License 2.0 of this
repository.
