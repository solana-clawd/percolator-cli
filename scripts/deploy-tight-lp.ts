/**
 * Deploy a tighter-spread LP on the devnet percolator market.
 *
 * The existing LP #0 uses 50bps passive spread.
 * This script creates a new LP with 10bps spread using the same
 * percolator-match program but with a vAMM context configured for
 * tighter pricing.
 *
 * Steps:
 * 1. Create matcher context account (320 bytes, owned by matcher program)
 * 2. Initialize vAMM context with 10bps spread
 * 3. Init LP on the slab pointing to our matcher context
 * 4. Deposit collateral (0.5 SOL)
 * 5. Run keeper crank
 * 6. Execute a test trade
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ---- Config ----
const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const SLAB = new PublicKey("A7wQtRT9DhFqYho8wTVqQCDc7kYPTUXGPATiyVbZKVFs");
const ORACLE = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const VAULT = new PublicKey("63juJmvm1XHCHveWv9WdanxqJX6tD6DLFTZD7dvH12dc");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

const MATCHER_CONTEXT_LEN = 320;
const COLLATERAL_LAMPORTS = 500_000_000; // 0.5 SOL

// vAMM config: tighter spread
const VAMM_MAGIC = BigInt("0x5045524334d415443"); // "PERCMATC"
const VAMM_MAGIC_CORRECT = BigInt("0x5045524334d41544"); // Let's compute it properly

// ---- Helpers ----

function loadKeypair(p: string): Keypair {
  // Check common locations
  const candidates = [
    p.replace(/^~/, process.env.HOME || ""),
    path.join(process.env.HOME || "", ".openclaw/workspace/solana-wallet.json"),
    path.join(process.env.HOME || "", ".config/solana/devnet-percolator.json"),
  ];
  const resolved = candidates.find(c => fs.existsSync(c)) || candidates[0];
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function encU8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(v, 0);
  return b;
}
function encU16LE(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}
function encU32LE(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}
function encU64LE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}
function encU128LE(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & BigInt("0xFFFFFFFFFFFFFFFF"), 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return b;
}
function encI128LE(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  // Two's complement for negative values
  let unsigned = v;
  if (v < 0n) {
    unsigned = (1n << 128n) + v;
  }
  b.writeBigUInt64LE(unsigned & BigInt("0xFFFFFFFFFFFFFFFF"), 0);
  b.writeBigUInt64LE((unsigned >> 64n) & BigInt("0xFFFFFFFFFFFFFFFF"), 8);
  return b;
}
function encPubkey(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

/**
 * Build InitVamm instruction data (tag=2, 66 bytes)
 * Layout:
 *   tag(1) + mode(1) + trading_fee_bps(4) + base_spread_bps(4) +
 *   max_total_bps(4) + impact_k_bps(4) + liquidity_notional_e6(16) +
 *   max_fill_abs(16) + max_inventory_abs(16) = 66 bytes
 */
function buildInitVammData(params: {
  mode: number;  // 0=Passive, 1=vAMM
  tradingFeeBps: number;
  baseSpreadBps: number;
  maxTotalBps: number;
  impactKBps: number;
  liquidityNotionalE6: bigint;
  maxFillAbs: bigint;
  maxInventoryAbs: bigint;
}): Buffer {
  return Buffer.concat([
    encU8(2), // tag = MATCHER_INIT_VAMM_TAG
    encU8(params.mode),
    encU32LE(params.tradingFeeBps),
    encU32LE(params.baseSpreadBps),
    encU32LE(params.maxTotalBps),
    encU32LE(params.impactKBps),
    encU128LE(params.liquidityNotionalE6),
    encU128LE(params.maxFillAbs),
    encU128LE(params.maxInventoryAbs),
  ]);
}

/**
 * Build InitLP instruction data
 * tag(1) + matcherProgram(32) + matcherContext(32) + feePayment(8) = 73 bytes
 */
function buildInitLpData(matcherProg: PublicKey, matcherCtx: PublicKey, fee: bigint): Buffer {
  return Buffer.concat([
    encU8(2), // IX_TAG.InitLP = 2
    encPubkey(matcherProg),
    encPubkey(matcherCtx),
    encU64LE(fee),
  ]);
}

/**
 * Build DepositCollateral instruction data
 * tag(1) + userIdx(2) + amount(8) = 11 bytes
 */
function buildDepositData(userIdx: number, amount: bigint): Buffer {
  return Buffer.concat([
    encU8(3), // IX_TAG.DepositCollateral = 3
    encU16LE(userIdx),
    encU64LE(amount),
  ]);
}

/**
 * Build KeeperCrank instruction data
 * tag(1) + callerIdx(2) + allowPanic(1) = 4 bytes
 */
function buildKeeperCrankData(callerIdx: number): Buffer {
  return Buffer.concat([
    encU8(5), // IX_TAG.KeeperCrank = 5
    encU16LE(callerIdx),
    encU8(0), // allowPanic = false
  ]);
}

/**
 * Build TradeCpi instruction data
 * tag(1) + lpIdx(2) + userIdx(2) + size(16) = 21 bytes
 */
function buildTradeCpiData(lpIdx: number, userIdx: number, size: bigint): Buffer {
  return Buffer.concat([
    encU8(10), // IX_TAG.TradeCpi = 10
    encU16LE(lpIdx),
    encU16LE(userIdx),
    encI128LE(size),
  ]);
}

function deriveLpPda(programId: PublicKey, slab: PublicKey, lpIdx: number): [PublicKey, number] {
  const idxBuf = Buffer.alloc(2);
  idxBuf.writeUInt16LE(lpIdx, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slab.toBuffer(), idxBuf],
    programId,
  );
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = loadKeypair("~/.config/solana/id.json");
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  
  const bal = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${bal / 1e9} SOL`);

  // Step 1: Create matcher context account
  console.log("\n=== Step 1: Create matcher context account ===");
  const matcherCtxKeypair = Keypair.generate();
  console.log(`Matcher context: ${matcherCtxKeypair.publicKey.toBase58()}`);

  const ctxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CONTEXT_LEN);
  console.log(`Rent: ${ctxRent / 1e9} SOL`);

  const createAcctIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: matcherCtxKeypair.publicKey,
    lamports: ctxRent,
    space: MATCHER_CONTEXT_LEN,
    programId: MATCHER_PROGRAM_ID,
  });

  const createTx = new Transaction().add(createAcctIx);
  const createSig = await sendAndConfirmTransaction(connection, createTx, [wallet, matcherCtxKeypair]);
  console.log(`Created account: ${createSig}`);

  await sleep(2000);

  // Step 2: Initialize vAMM context with 10bps passive spread
  console.log("\n=== Step 2: Initialize matcher context (10bps passive) ===");
  
  const initVammData = buildInitVammData({
    mode: 0,  // Passive mode (fixed spread around oracle)
    tradingFeeBps: 5,  // 0.05% trading fee
    baseSpreadBps: 10, // 10bps spread (vs 50bps existing!)
    maxTotalBps: 200,  // 2% max
    impactKBps: 0,     // No impact (passive mode)
    liquidityNotionalE6: 0n, // Not needed for passive
    maxFillAbs: BigInt("1000000000000"), // Large max fill
    maxInventoryAbs: BigInt("1000000000000"), // Large max inventory
  });

  const initVammIx = new TransactionInstruction({
    programId: MATCHER_PROGRAM_ID,
    keys: [
      { pubkey: matcherCtxKeypair.publicKey, isSigner: false, isWritable: true },
    ],
    data: initVammData,
  });

  const initVammTx = new Transaction().add(initVammIx);
  const initVammSig = await sendAndConfirmTransaction(connection, initVammTx, [wallet]);
  console.log(`Init vAMM context: ${initVammSig}`);

  await sleep(2000);

  // Step 3: Init LP on the slab
  console.log("\n=== Step 3: Init LP on slab ===");
  
  const userAta = await getAssociatedTokenAddress(MINT, wallet.publicKey);
  console.log(`User ATA: ${userAta.toBase58()}`);

  const initLpData = buildInitLpData(
    MATCHER_PROGRAM_ID,
    matcherCtxKeypair.publicKey,
    1000000n, // fee payment (same as new account fee)
  );

  const initLpIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initLpData,
  });

  const initLpTx = new Transaction().add(initLpIx);
  const initLpSig = await sendAndConfirmTransaction(connection, initLpTx, [wallet]);
  console.log(`Init LP: ${initLpSig}`);

  await sleep(2000);

  // Fetch slab to find our LP index
  console.log("\n=== Finding our LP index ===");
  const slabData = await connection.getAccountInfo(SLAB);
  if (!slabData) throw new Error("Slab not found");
  
  // We need to scan through accounts to find our new LP
  // For now, since the market had 1 account (LP#0), our new LP should be index 1 or next available
  // Let's use the CLI to check
  console.log("Slab data length:", slabData.data.length);

  // Step 4: Deposit collateral to our LP
  // First we need to know our LP index. Let's check slab-accounts.
  // For now, let's assume it gets the next available index.
  // The existing market had numUsedAccounts=1, so our LP should be at index 1.
  // But we also have user index 13 from previous trading.
  // Let's try depositing to the LP we just created.

  // Actually, let me first check what index was assigned by looking at slab accounts.
  // The init-lp command would allocate the next available slot.
  // From state.json, numUsedAccounts was 1 (just LP #0).
  // But our user index 13 also exists. Let me just try reasonable indices.

  // Save the matcher context for future reference
  const deployInfo = {
    matcherContext: matcherCtxKeypair.publicKey.toBase58(),
    matcherContextSecret: Array.from(matcherCtxKeypair.secretKey),
    matcherProgram: MATCHER_PROGRAM_ID.toBase58(),
    slab: SLAB.toBase58(),
    config: {
      mode: "passive",
      tradingFeeBps: 5,
      baseSpreadBps: 10,
      maxTotalBps: 200,
    },
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(process.cwd(), "tight-lp-deploy.json"),
    JSON.stringify(deployInfo, null, 2),
  );
  console.log("\nSaved deployment info to tight-lp-deploy.json");

  console.log("\n=== Done! ===");
  console.log("Next steps:");
  console.log("1. Run: npx percolator-cli slab-accounts --slab", SLAB.toBase58(), "  to find your LP index");
  console.log("2. Deposit collateral to your LP");
  console.log("3. Run keeper crank");
  console.log("4. Run best-price to compare spreads");
}

main().catch(e => {
  console.error("Error:", e);
  process.exit(1);
});
