// difficulty-adjustment.ts (final)

import config from '../config';
import { IDifficultyAdjustment } from '../mempool.interfaces';
import blocks from './blocks';

export interface DifficultyAdjustment {
  progressPercent: number;       // 0..100
  difficultyChange: number;      // %
  estimatedRetargetDate: number; // ms epoch
  remainingBlocks: number;
  remainingTime: number;         // ms
  previousRetarget: number;      // %
  previousTime: number;          // s epoch
  nextRetargetHeight: number;    // height
  timeAvg: number;               // ms
  adjustedTimeAvg: number;       // ms
  timeOffset: number;            // ms (testnet UX tweak)
  expectedBlocks: number;        // count
}

/* ---------------- Activation height ---------------- */

function getActivationHeight(network: string): number {

  switch ((network || '').toLowerCase()) {
    case 'mainnet':
    case 'main':
      return 115000;
    default:
      return 0;  // testnet/simnet/regtest: Digishield active from genesis
  }
}

const BLOCK_SECONDS_TARGET = 60;
const TESTNET_MAX_BLOCK_SECONDS = 1200;

/* ---------------- Compact → target helpers ---------------- */

export function compactToTarget(bits: number): bigint {
  if (!Number.isInteger(bits) || bits <= 0) throw new Error('Invalid bits');
  const exp = (bits >>> 24) & 0xff;
  const mant = BigInt(bits & 0x007fffff);
  if ((bits & 0x00800000) !== 0 || mant === 0n) throw new Error('Invalid bits');

  if (exp <= 3) return mant >> BigInt(8 * (3 - exp));
  return mant << BigInt(8 * (exp - 3));
}

/** % change in *difficulty* from oldBits → newBits; no clamping. */
function pctChangeFromBits(oldBits: number, newBits: number): number {
  const oldT = compactToTarget(oldBits);
  const newT = compactToTarget(newBits);
  const SCALE = 1_000_000n;
  const ratioFp = (oldT * SCALE) / newT; // ≈ old/new
  const ratio = Number(ratioFp) / Number(SCALE);
  return (ratio - 1) * 100; // +% when target shrinks (harder)
}

/* ---------------- Public: 2-arg API with internal context ---------------- */

/**
 * Difficulty % change between two nBits values, activation-aware.
 * Uses current app state for context:
 *  - height:  blocks.getCurrentBlockHeight()
 *  - network: config.MEMPOOL.NETWORK (defaults to 'mainnet')
 *
 * Pre-activation (legacy): clamp to +300% / −75%.
 * Post-activation (Digishield per-block): clamp to ≈ +33.34% / −33.34%.
 */
export function calcBitsDifference(oldBits: number, newBits: number): number {
  const height = typeof blocks.getCurrentBlockHeight === 'function'
    ? Number(blocks.getCurrentBlockHeight())
    : 0;

  const network = config.MEMPOOL.NETWORK;
  const activation = getActivationHeight(network);
  const raw = pctChangeFromBits(oldBits, newBits);

  if (height < activation) {
    // Legacy per-period display clamp
    return Math.max(Math.min(raw, 300), -75);
  }

  // Digishield per-block clamp derived from timespan clamp [0.75T .. 1.5T]
  const DIGI_MAX_UP = 33.34;
  const DIGI_MAX_DOWN = -33.34;
  return Math.max(Math.min(raw, DIGI_MAX_UP), DIGI_MAX_DOWN);
}

/* ---------------- DifficultyAdjustment (UI summary) ---------------- */

export function calcDifficultyAdjustment(
  DATime: number,
  quarterEpochTime: number | null,
  nowSeconds: number,
  blockHeight: number,
  previousRetarget: number,
  network: string,
  latestBlockTimestamp: number,
): DifficultyAdjustment {
  const activation = getActivationHeight(network);

  // ------- Pre-activation: legacy-style view (kept for UI continuity) -------
  if (blockHeight < activation) {
    const EPOCH_BLOCK_LENGTH = 1; // your chain uses per-block retarget already

    const diffSeconds = Math.max(0, nowSeconds - DATime);
    const blocksInEpoch = blockHeight >= 0 ? blockHeight % EPOCH_BLOCK_LENGTH : 0;
    const progressPercent = blockHeight >= 0 ? (blocksInEpoch / EPOCH_BLOCK_LENGTH) * 100 : 100;
    const remainingBlocks = EPOCH_BLOCK_LENGTH - blocksInEpoch;
    const nextRetargetHeight = blockHeight >= 0 ? blockHeight + remainingBlocks : 0;
    const expectedBlocks = diffSeconds / BLOCK_SECONDS_TARGET;
    const actualTimespan = (blocksInEpoch === 2015 ? latestBlockTimestamp : nowSeconds) - DATime;

    let difficultyChange: number;
    let timeAvgSecs = blocksInEpoch ? diffSeconds / blocksInEpoch : BLOCK_SECONDS_TARGET;
    let adjustedTimeAvgSecs = timeAvgSecs;

    if (quarterEpochTime && blocksInEpoch < 503) {
      const timeLastEpoch = DATime - quarterEpochTime;
      const adjustedTimeLastEpoch = timeLastEpoch * (1 + previousRetarget / 100);
      const adjustedTimeSpan = diffSeconds + adjustedTimeLastEpoch;
      adjustedTimeAvgSecs = adjustedTimeSpan / 503;
      difficultyChange = (BLOCK_SECONDS_TARGET / (adjustedTimeSpan / 504) - 1) * 100;
    } else {
      difficultyChange = (BLOCK_SECONDS_TARGET / (actualTimespan / (blocksInEpoch + 1)) - 1) * 100;
    }

    // Legacy clamp
    if (difficultyChange > 300) difficultyChange = 300;
    if (difficultyChange < -75) difficultyChange = -75;

    // Testnet UX tweak
    let timeOffset = 0;
    if ((network || '').toLowerCase() === 'testnet') {
      if (timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) timeAvgSecs = TESTNET_MAX_BLOCK_SECONDS;
      const secondsSinceLastBlock = nowSeconds - latestBlockTimestamp;
      if (secondsSinceLastBlock + timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) {
        timeOffset = -Math.min(secondsSinceLastBlock, TESTNET_MAX_BLOCK_SECONDS) * 1000;
      }
    }

    const timeAvg = Math.floor(timeAvgSecs * 1000);
    const adjustedTimeAvg = Math.floor(adjustedTimeAvgSecs * 1000);
    const remainingTime = remainingBlocks * adjustedTimeAvg;
    const estimatedRetargetDate = remainingTime + nowSeconds * 1000;

    return {
      progressPercent,
      difficultyChange,
      estimatedRetargetDate,
      remainingBlocks,
      remainingTime,
      previousRetarget,
      previousTime: DATime,
      nextRetargetHeight,
      timeAvg,
      adjustedTimeAvg,
      timeOffset,
      expectedBlocks,
    };
  }

  // ------- Post-activation: Digishield per-block view -------
  const cache = blocks.getBlocks?.() ?? [];
  const latest = cache[cache.length - 1];
  const prev = cache[cache.length - 2];

  let perBlockChange = 0;
  if (latest && prev) {
    const raw = pctChangeFromBits(prev.bits, latest.bits);
    const DIGI_MAX_UP = 33.34;
    const DIGI_MAX_DOWN = -33.34;
    perBlockChange = Math.max(Math.min(raw, DIGI_MAX_UP), DIGI_MAX_DOWN);
  }

  const progressPercent = 100;
  const remainingBlocks = 1;
  const timeAvgSecs = Math.max(1, nowSeconds - latestBlockTimestamp) || BLOCK_SECONDS_TARGET;
  const adjustedTimeAvgSecs = BLOCK_SECONDS_TARGET;
  const timeAvg = Math.floor(timeAvgSecs * 1000);
  const adjustedTimeAvg = Math.floor(adjustedTimeAvgSecs * 1000);
  const remainingTime = adjustedTimeAvg;
  const estimatedRetargetDate = nowSeconds * 1000 + remainingTime;

  return {
    progressPercent,
    difficultyChange: perBlockChange,
    estimatedRetargetDate,
    remainingBlocks,
    remainingTime,
    previousRetarget, // keep last legacy value for continuity
    previousTime: DATime,
    nextRetargetHeight: blockHeight + 1,
    timeAvg,
    adjustedTimeAvg,
    timeOffset: 0,
    expectedBlocks: 1,
  };
}

/* ---------------- API wrapper ---------------- */

class DifficultyAdjustmentApi {
  public getDifficultyAdjustment(): IDifficultyAdjustment | null {
    const DATime = blocks.getLastDifficultyAdjustmentTime?.();
    const previousRetarget = blocks.getPreviousDifficultyRetarget?.();
    const blockHeight = Number(blocks.getCurrentBlockHeight?.() ?? 0);
    const cache = blocks.getBlocks?.() ?? [];
    const latest = cache[cache.length - 1];
    if (!latest || typeof DATime !== 'number' || typeof previousRetarget !== 'number') {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const quarterEpochBlockTime = blocks.getQuarterEpochBlockTime?.() ?? null;
    const network = config.MEMPOOL.NETWORK;

    return calcDifficultyAdjustment(
      DATime,
      quarterEpochBlockTime,
      nowSeconds,
      blockHeight,
      previousRetarget,
      network,
      latest.timestamp,
    );
  }
}

export default new DifficultyAdjustmentApi();