/**
 * Quick smoke test for the new signal parser format.
 * Run with: node test_parser.mjs
 */
import TelegramSignalParser from './src/parsers/signalParser.js';

const parser = new TelegramSignalParser();

// ─── TEST 1: New format — SHORT with entry range ───────────────────────────
console.log('\n=== TEST 1: New Format (SHORT) ===');
const newFormatShort = `Pairs:  SCRT/USDT
👉 Trade Type = SHORT 🔴
👉 Leverage :- 20x
⚡ Entry = [ 0.1125 TO 0.1122 ]
❌ StopLoss :- 0.1167
✅ Take profit = [ 0.1109, 0.1095, 0.1080, 0.1066, 0.1050, 0.1032 ]`;

const result1 = parser.parseMessage(newFormatShort);
console.log(JSON.stringify(result1, null, 2));
console.assert(result1 !== null,                         'FAIL: result should not be null');
console.assert(result1.coin === 'SCRTUSDT',              `FAIL: coin should be SCRTUSDT, got ${result1?.coin}`);
console.assert(result1.direction === 'SHORT',            `FAIL: direction should be SHORT, got ${result1?.direction}`);
console.assert(result1.entryPrices[0] === 0.11235,      `FAIL: entryAvg should be 0.11235, got ${result1?.entryPrices[0]}`);
console.assert(result1.stopLoss === 0.1167,             `FAIL: stopLoss should be 0.1167, got ${result1?.stopLoss}`);
console.assert(result1.targets.length === 0,            `FAIL: targets should be [] (env TP used), got ${result1?.targets}`);
console.assert(result1.leverage === null,               `FAIL: leverage should be null (env used), got ${result1?.leverage}`);
console.assert(result1.isTakeProfit === false,          `FAIL: isTakeProfit should be false`);
console.assert(result1.slValid === true,                `FAIL: slValid should be true (SL 0.1167 > avg 0.11235 for SHORT)`);
console.log('✅ TEST 1 PASSED\n');

// ─── TEST 2: New format — LONG with entry range ────────────────────────────
console.log('=== TEST 2: New Format (LONG) ===');
const newFormatLong = `Pairs: BTC/USDT
Trade Type = LONG
Leverage :- 10x
Entry = [ 30000 TO 29800 ]
StopLoss :- 29000
Take profit = [ 30500, 31000, 32000 ]`;

const result2 = parser.parseMessage(newFormatLong);
console.log(JSON.stringify(result2, null, 2));
const expectedAvg = (30000 + 29800) / 2; // 29900
console.assert(result2 !== null,                        'FAIL: result should not be null');
console.assert(result2.coin === 'BTCUSDT',              `FAIL: coin should be BTCUSDT, got ${result2?.coin}`);
console.assert(result2.direction === 'LONG',            `FAIL: direction should be LONG, got ${result2?.direction}`);
console.assert(result2.entryPrices[0] === expectedAvg, `FAIL: entryAvg should be ${expectedAvg}, got ${result2?.entryPrices[0]}`);
console.assert(result2.stopLoss === 29000,              `FAIL: stopLoss should be 29000, got ${result2?.stopLoss}`);
console.assert(result2.slValid === true,                `FAIL: slValid should be true (SL 29000 < avg 29900 for LONG)`);
console.log('✅ TEST 2 PASSED\n');

// ─── TEST 3: SL direction validation mismatch (SHORT but SL below entry) ──
console.log('=== TEST 3: SL direction mismatch (should warn but not discard) ===');
const badSL = `Pairs: ETH/USDT
Trade Type = SHORT
Entry = [ 2000 TO 1990 ]
StopLoss :- 1900`;  // SL BELOW entry for SHORT — wrong!

const result3 = parser.parseMessage(badSL);
console.assert(result3 !== null,         'FAIL: signal should still be returned (just warned)');
console.assert(result3.slValid === false, `FAIL: slValid should be false for mismatched SL, got ${result3?.slValid}`);
console.log(`slValid=${result3?.slValid} — Warning logged (expected). ✅ TEST 3 PASSED\n`);

// ─── TEST 4: Old format (backward compat) ─────────────────────────────────
console.log('=== TEST 4: Old Format (backward compat) ===');
const oldFormat = `🔥#BEAT/USDT (Short📉, x20)🔥
Entry - 0.0542
0.0538 (50% of profit)
0.0530 (100% of profit)`;

const result4 = parser.parseMessage(oldFormat);
console.log(JSON.stringify(result4, null, 2));
console.assert(result4 !== null,              'FAIL: result should not be null');
console.assert(result4.coin === 'BEATUSDT',   `FAIL: coin should be BEATUSDT, got ${result4?.coin}`);
console.assert(result4.direction === 'SHORT', `FAIL: direction should be SHORT, got ${result4?.direction}`);
console.assert(result4.stopLoss === null,     `FAIL: old format has no SL, should be null, got ${result4?.stopLoss}`);
console.assert(result4.targets.length === 0, `FAIL: old format targets should be [] now (env TP used)`);
console.log('✅ TEST 4 PASSED\n');

// ─── TEST 5: Unrecognized message ─────────────────────────────────────────
console.log('=== TEST 5: Unrecognized message ===');
const garbage = 'Hello everyone! Please check out this great channel for signals.';
const result5 = parser.parseMessage(garbage);
console.assert(result5 === null, `FAIL: result should be null for unrecognized message`);
console.log('✅ TEST 5 PASSED\n');

console.log('🎉 All parser tests completed.');
