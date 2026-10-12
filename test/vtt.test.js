'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Vtt = require('../src/shared/vtt');

const SAMPLE = `WEBVTT

NOTE a comment --> not a cue

00:00:01.000 --> 00:00:03.500 align:center
{\\an8}Hello <i>world</i>

1
00:01:02.250 --> 00:01:04.000
Line one
Line <b>two</b> <font color="red">x</font>

00:00:02.000 --> 00:00:02.800
Overlap & stuff
`;

test('parses cues, strips ASS tags and sorts by start', () => {
  const cues = Vtt.parse(SAMPLE);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((c) => c.start), [1, 2, 62.25]);
  assert.equal(cues[0].text, 'Hello <i>world</i>');
});

test('active cues and HTML escaping', () => {
  const cues = Vtt.parse(SAMPLE);
  assert.deepEqual(Vtt.active(cues, 2.5).map((c) => c.start), [1, 2]);
  assert.deepEqual(Vtt.active(cues, 3.6), []);
  assert.equal(Vtt.toHtml('a <i>b</i> <script>x</script> & c\nd'), 'a <i>b</i> x &amp; c<br>d');
  assert.equal(Vtt.toHtml(cues[2].text), 'Line one<br>Line <b>two</b> x');
});
