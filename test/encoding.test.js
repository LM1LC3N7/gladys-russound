// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã" + "©", the apostrophe "’" becoming "â" + "€" + "™"). No text
// claims that something is encrypted: the integration keeps no secret, and
// Gladys stores the configuration in clear in its database. And no control
// byte in any source or text file.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const ENCRYPTED = /chiffr|crypt|encrypt/i;
// Bidirectional overrides too ("Trojan Source", review 1 M5): escapes only in the files.
const CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
];
const SOURCES = [
  'index.js',
  'src/app.js',
  'src/config.js',
  'src/constants.js',
  'src/handlers.js',
  'src/model.js',
  'src/store.js',
  'src/russound/link.js',
  'src/russound/protocol.js',
  'test/fixtures/fakeRussound.js',
  'test/app.test.js',
  'test/config.test.js',
  'test/encoding.test.js',
  'test/manifest.test.js',
  'test/protocol.test.js',
  'scripts/cover.mjs',
  'Dockerfile',
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

for (const file of [...FILES, ...SOURCES]) {
  test(`${file}: no control byte`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const line = text.split('\n').findIndex((l) => CONTROL.test(l.replace(/\r$/, '')));
    assert.equal(line, -1, `control byte on line ${line + 1}`);
  });
}

for (const file of [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'src/i18n.js',
]) {
  test(`${file}: never says "encrypted"`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const line = text.split('\n').findIndex((l) => ENCRYPTED.test(l));
    assert.equal(line, -1, `"encrypted" on line ${line + 1}`);
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('finâ€¦', MOJIBAKE, '… read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
  assert.match('stocké chiffré', ENCRYPTED);
  assert.match('stored encrypted', ENCRYPTED);
  assert.match('a\u0001b', CONTROL);
  assert.match('a\u202eb', CONTROL);
  assert.match('a\u2066b', CONTROL);
  assert.doesNotMatch('a\tb', CONTROL);
});

test('LICENSE names nobody', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});
