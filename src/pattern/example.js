import { isPixelOn, targetCommits, renderAscii } from './pattern.js';

console.log('2019-10-22 on?', isPixelOn('2019-10-22'));
console.log('2024-02-29 on?', isPixelOn('2024-02-29'), 'target:', targetCommits('2024-02-29'));
console.log('\nMon..Sun x 56 weeks from 2026-01-05:\n');
console.log(renderAscii('2026-01-05', 56));
