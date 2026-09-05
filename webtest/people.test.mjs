import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personFor, residentSeed, NAMES, OCCUPATIONS, EMPLOYERS, BLOOD_TYPES, EYE_COLOURS, HAIR_COLOURS } from '../web/people.js';

test('the same resident is always the same person', () => {
  const seed = residentSeed('prometheus', 17);
  assert.equal(seed, residentSeed('prometheus', 17));
  assert.deepEqual({ ...personFor(seed) }, { ...personFor(seed) });
  assert.equal(personFor(seed).name, personFor(seed).name);
  assert.notEqual(residentSeed('prometheus', 17), residentSeed('prometheus', 18));
  assert.notEqual(residentSeed('prometheus', 17), residentSeed('grafana', 17));
});

test('identities come from the lookup tables and are internally consistent', () => {
  const sexes = new Set(), names = new Set();
  for (let i = 0; i < 500; i++) {
    const p = personFor(residentSeed('repo', i));
    sexes.add(p.sex); names.add(p.name);
    assert.ok(['Male', 'Female'].includes(p.sex));
    assert.ok((p.sex === 'Male' ? NAMES.male : NAMES.female).includes(p.firstName), `${p.firstName} matches ${p.sex}`);
    assert.ok(NAMES.surnames.includes(p.surname) && OCCUPATIONS.includes(p.occupation) && EMPLOYERS.includes(p.employer));
    assert.ok(BLOOD_TYPES.includes(p.bloodType) && EYE_COLOURS.includes(p.eyeColour) && HAIR_COLOURS.includes(p.hairColour));
    assert.ok(Number.isInteger(p.age) && p.age >= 18 && p.age <= 80);
    assert.match(p.id, /^CN-[0-9A-F]{8}$/);
  }
  assert.equal(sexes.size, 2);
  assert.ok(names.size > 300, `plenty of variety (${names.size} names)`);
});
