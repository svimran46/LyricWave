/**
 * Unit Test for Lyrics Service and LRC Parser
 */

import { parseLRC, cleanTrackTitle, findActiveLineIndex, getStoredOffsetMs, setStoredOffsetMs } from './lyrics.js';

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${desc}`);
  }
}

console.log('--- Testing LRC Parser & Lyrics Utilities ---');

// 1. Title Cleaning
assert(cleanTrackTitle('Starboy - Remastered 2021') === 'Starboy', 'Remaster suffix cleaned');
assert(cleanTrackTitle('Die For You (feat. Ariana Grande)') === 'Die For You', 'feat. suffix cleaned');
assert(cleanTrackTitle('Blinding Lights') === 'Blinding Lights', 'Clean title preserved');

// 2. LRC Parser
const sampleLRC = `
[ti:Sample Track]
[ar:Sample Artist]
[00:10.50]First line of lyrics
[00:14.250]Second line with 3 digits
[00:18.0][00:22.50]Repeated line with two timestamps
[00:26.8]Single digit fraction
`;

const lines = parseLRC(sampleLRC);

assert(lines.length === 5, 'Parsed 5 lyric entries (including repeated line split)');
assert(lines[0].timeMs === 10500, 'First line timeMs is 10500ms');
assert(lines[0].text === 'First line of lyrics', 'First line text correctly parsed');
assert(lines[1].timeMs === 14250, 'Second line with 3 digits is 14250ms');
assert(lines[2].timeMs === 18000, 'Repeated timestamp 1 is 18000ms');
assert(lines[3].timeMs === 22500, 'Repeated timestamp 2 is 22500ms');
assert(lines[3].text === 'Repeated line with two timestamps', 'Repeated text mapped correctly');
assert(lines[4].timeMs === 26800, 'Single digit fraction .8 is 26800ms');

// 3. Active Line Lookup
assert(findActiveLineIndex(lines, 5000) === -1, 'Before first line returns -1');
assert(findActiveLineIndex(lines, 10500) === 0, 'Exact start of line 0 returns 0');
assert(findActiveLineIndex(lines, 12000) === 0, 'Mid line 0 returns 0');
assert(findActiveLineIndex(lines, 14250) === 1, 'Start of line 1 returns 1');
assert(findActiveLineIndex(lines, 30000) === 4, 'After last line returns last line index 4');

// 4. Offset Storage & Clamping
assert(getStoredOffsetMs() === 0, 'Initial stored offset defaults to 0');
assert(setStoredOffsetMs(1500) === 1500, 'Positive offset set and returned');
assert(setStoredOffsetMs(6000) === 5000, 'Offsets > +5000ms clamped to +5000ms');
assert(setStoredOffsetMs(-6000) === -5000, 'Offsets < -5000ms clamped to -5000ms');
assert(setStoredOffsetMs(0) === 0, 'Offset reset to 0');

// 5. [offset: ms] LRC Tag Support
const lrcWithOffset = `
[ti:Offset Song]
[offset:500]
[00:02.00]Line shifted by 500ms
`;
const parsedOffset = parseLRC(lrcWithOffset);
assert(parsedOffset.length === 1, 'Parsed 1 line from offset LRC');
assert(parsedOffset[0].timeMs === 2500, '[offset: 500] correctly added 500ms to 2000ms timestamp (2500ms)');

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
