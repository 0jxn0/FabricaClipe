import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMotion, isPaused, motionReduce } from '../src/embed/motion.js';

test('reduced-motion inicia pausado; sem preferência, rodando', () => {
  assert.equal(isPaused(initialMotion(true)), true);
  assert.equal(isPaused(initialMotion(false)), false);
  assert.equal(isPaused(initialMotion(undefined)), false);
});

test('pause/resume do host vencem o SO; mudança da media query descarta o override', () => {
  let s = initialMotion(true);
  s = motionReduce(s, 'resume'); assert.equal(isPaused(s), false);
  s = motionReduce(s, 'media', true); assert.equal(isPaused(s), true);
  s = motionReduce(s, 'media', false); assert.equal(isPaused(s), false);
  s = motionReduce(s, 'pause'); assert.equal(isPaused(s), true);
  s = motionReduce(s, 'media', false); assert.equal(isPaused(s), false);
  assert.equal(motionReduce(s, 'x'), s);
});
