import { Command } from "commander";
import { Connection, PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseUsedIndices, parseAccount, AccountKind } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

// Matcher constants
const PASSIVE_MATCHER_EDGE_BPS = 50n;
const BPS_DENOM = 10000n;

// vAMM context magic number
const VAMM_MAGIC = BigInt("0x5045524334d41544");
const VAMM_MAGIC_ALT = BigInt("0x4354414d43524550"); // "PERCMATC" LE

interface LpQuote {
  lpIndex: number;
  matcherProgram: string;
  matcherContext: string;
  bid: bigint;
  ask: bigint;
  edgeBps: number;
  tradingFeeBps: number;
  mode: string;
  capital: bigint;
  position: bigint;
}

interface VammConfig {
  mode: string;
  tradingFeeBps: number;
  baseSpreadBps: number;
  maxTotalBps: number;
  impactKBps: number;
}

function computePassiveQuote(oraclePrice: bigint, edgeBps: bigint): { bid: bigint; ask: bigint } {
  const bid = (oraclePrice * (BPS_DENOM - edgeBps)) / BPS_DENOM;
  const askNumer = oraclePrice * (BPS_DENOM + edgeBps);
  const ask = (askNumer + BPS_DENOM - 1n) / BPS_DENOM;
  return { bid, ask };
}

async function getChainlinkPrice(connection: any, oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  return { price: answer, decimals };
}

/**
 * Read vAMM context from matcher context account.
 * Context data starts at offset 64 (first 64 bytes are matcher return).
 * Returns null if no vAMM magic found (legacy 50bps passive).
 */
async function readVammContext(connection: Connection, ctxPubkey: PublicKey): Promise<VammConfig | null> {
  try {
    const info = await connection.getAccountInfo(ctxPubkey);
    if (!info || info.data.length < 320) return null;

    // vAMM context starts at offset 64
    const vammData = info.data.subarray(64);
    const magic = vammData.readBigUInt64LE(0);

    // Check for vAMM magic "PERCMATC" in LE
    const PERCMATC_LE = BigInt("0x504552434d415443");
    if (magic !== PERCMATC_LE) return null;

    const mode = vammData.readUInt8(12);
    const tradingFeeBps = vammData.readUInt32LE(16);
    const baseSpreadBps = vammData.readUInt32LE(20);
    const maxTotalBps = vammData.readUInt32LE(24);
    const impactKBps = vammData.readUInt32LE(28);

    return {
      mode: mode === 0 ? "passive" : "vamm",
      tradingFeeBps,
      baseSpreadBps,
      maxTotalBps,
      impactKBps,
    };
  } catch {
    return null;
  }
}

export function registerBestPrice(program: Command): void {
  program
    .command("best-price")
    .description("Scan LPs and find best prices for trading (reads actual matcher context)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--oracle <pubkey>", "Price oracle account")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const oraclePk = validatePublicKey(opts.oracle, "--oracle");

      // Fetch data
      const [slabData, oracleData] = await Promise.all([
        fetchSlab(ctx.connection, slabPk),
        getChainlinkPrice(ctx.connection, oraclePk),
      ]);

      const oraclePrice = oracleData.price;
      const oraclePriceUsd = Number(oraclePrice) / Math.pow(10, oracleData.decimals);

      // Find all LPs
      const usedIndices = parseUsedIndices(slabData);
      const quotes: LpQuote[] = [];

      for (const idx of usedIndices) {
        const account = parseAccount(slabData, idx);
        if (!account) continue;

        // LP detection: kind === LP or matcher_program is non-zero
        const isLp = account.kind === AccountKind.LP ||
          (account.matcherProgram && !account.matcherProgram.equals(PublicKey.default));

        if (isLp) {
          // Try to read actual vAMM context from matcher context account
          let edgeBps = 50; // default legacy
          let tradingFeeBps = 0;
          let mode = "legacy-passive";
          
          if (account.matcherContext && !account.matcherContext.equals(PublicKey.default)) {
            const vammCfg = await readVammContext(ctx.connection, account.matcherContext);
            if (vammCfg) {
              edgeBps = vammCfg.baseSpreadBps;
              tradingFeeBps = vammCfg.tradingFeeBps;
              mode = vammCfg.mode;
            }
          }

          // Total effective spread = base spread + trading fee
          const totalEdgeBps = edgeBps + tradingFeeBps;
          const { bid, ask } = computePassiveQuote(oraclePrice, BigInt(totalEdgeBps));

          quotes.push({
            lpIndex: idx,
            matcherProgram: account.matcherProgram?.toBase58() || "none",
            matcherContext: account.matcherContext?.toBase58() || "none",
            bid,
            ask,
            edgeBps: totalEdgeBps,
            tradingFeeBps,
            mode,
            capital: account.capital,
            position: account.positionSize,
          });
        }
      }

      if (quotes.length === 0) {
        if (flags.json) {
          console.log(JSON.stringify({ error: "No LPs found" }));
        } else {
          console.log("No LPs found in this market");
        }
        process.exitCode = 1;
        return;
      }

      // Find best prices
      const bestBuy = quotes.reduce((best, q) => q.ask < best.ask ? q : best);
      const bestSell = quotes.reduce((best, q) => q.bid > best.bid ? q : best);

      if (flags.json) {
        console.log(JSON.stringify({
          oracle: {
            price: oraclePrice.toString(),
            priceUsd: oraclePriceUsd,
            decimals: oracleData.decimals,
          },
          lps: quotes.map(q => ({
            index: q.lpIndex,
            matcherProgram: q.matcherProgram,
            matcherContext: q.matcherContext,
            mode: q.mode,
            bid: q.bid.toString(),
            ask: q.ask.toString(),
            edgeBps: q.edgeBps,
            tradingFeeBps: q.tradingFeeBps,
            capital: q.capital.toString(),
            position: q.position.toString(),
          })),
          bestBuy: {
            lpIndex: bestBuy.lpIndex,
            price: bestBuy.ask.toString(),
            priceUsd: Number(bestBuy.ask) / Math.pow(10, oracleData.decimals),
          },
          bestSell: {
            lpIndex: bestSell.lpIndex,
            price: bestSell.bid.toString(),
            priceUsd: Number(bestSell.bid) / Math.pow(10, oracleData.decimals),
          },
          effectiveSpreadBps: Number((bestBuy.ask - bestSell.bid) * 10000n / oraclePrice),
        }, null, 2));
      } else {
        console.log("=== Best Price Scanner ===\n");
        console.log(`Oracle: $${oraclePriceUsd.toFixed(2)}`);
        console.log(`LPs found: ${quotes.length}\n`);

        console.log("--- LP Quotes ---");
        for (const q of quotes) {
          const bidUsd = Number(q.bid) / Math.pow(10, oracleData.decimals);
          const askUsd = Number(q.ask) / Math.pow(10, oracleData.decimals);
          const capitalSol = Number(q.capital) / 1e9;
          console.log(`LP ${q.lpIndex} [${q.mode}] (${q.edgeBps}bps = ${q.edgeBps - q.tradingFeeBps}spread+${q.tradingFeeBps}fee): bid=$${bidUsd.toFixed(4)} ask=$${askUsd.toFixed(4)} capital=${capitalSol.toFixed(2)}SOL pos=${q.position}`);
        }

        console.log("\n--- Best Prices ---");
        const bestBuyUsd = Number(bestBuy.ask) / Math.pow(10, oracleData.decimals);
        const bestSellUsd = Number(bestSell.bid) / Math.pow(10, oracleData.decimals);
        console.log(`BEST BUY:  LP ${bestBuy.lpIndex} @ $${bestBuyUsd.toFixed(4)}`);
        console.log(`BEST SELL: LP ${bestSell.lpIndex} @ $${bestSellUsd.toFixed(4)}`);

        const spreadBps = Number((bestBuy.ask - bestSell.bid) * 10000n / oraclePrice);
        console.log(`\nEffective spread: ${spreadBps.toFixed(1)} bps`);
      }
    });
}
