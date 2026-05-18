/**
 * Classify the sender of a USDC.e/USDC transfer into a Polymarket proxy wallet.
 *
 * Categories:
 *   - "bridge:<name>"  — wallet was funded via a known cross-chain bridge.
 *     Without Phase 6b Relay tracing, we cannot link two bridge-funded wallets;
 *     we only mark them.
 *   - "cex:<name>"     — known centralized exchange hot wallet. Two wallets
 *     funded from the same CEX within ~7 days can suggest coordination.
 *   - "fiat_onramp"    — MoonPay / Ramp / Transak. Typically retail.
 *   - "polymarket"     — internal Polymarket proxy/relayer addresses (cannot
 *     attribute true origin from these alone).
 *   - null             — unknown sender. Two wallets with identical unknown
 *     funder address are the strongest correlation signal.
 *
 * All addresses are checksum-lowercased and matched against the input lowercased.
 */

export type FundingCategory =
  | `bridge:${string}`
  | `cex:${string}`
  | `service:${string}`
  | "fiat_onramp"
  | null;

const BRIDGE_ADDRESSES: Record<string, string> = {
  // Relay Bridge solvers / depository (Polygon mainnet). Add more as observed.
  "0xf70da97812cb96acdf810712aa562db8dfa3dbef": "relay", // Relay solver
  "0xa5f565650890fba1824ee0f21ebbbf660a179934": "relay", // Relay
  "0xeeeeeeee0f33b87a3df9f8eaccbe4f6e2a39f7fc": "relay", // Relay (alt)

  // Across Protocol SpokePool on Polygon
  "0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096": "across",

  // Stargate / LayerZero routers (Polygon)
  "0x45a01e4e04f14f7a4a6702c74187c5f6222033cd": "stargate",
  "0x1205f31718499dbf1fca446663b532ef87481fe1": "stargate-usdc",

  // Wormhole token bridge
  "0x5a58505a96d1dbf8df91cb21b54419fc36e93fde": "wormhole",

  // Polygon canonical PoS bridge (ERC20 predicate)
  "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf": "polygon-pos",

  // Hop Protocol L2 bridge (USDC)
  "0x76b22b8c1079a44f1211d867d68b1eda76a635a7": "hop",

  // Synapse Bridge
  "0x8f5bbb2bb8c2ee94639e55d5f41de9b4839c1280": "synapse",

  // Bungee/Socket (gateway/router)
  "0x3a23f943181408eac424116af7b7790c94cb97a5": "bungee",

  // deBridge
  "0xef4fb24ad0916217251f553c0596f8edc630eb66": "debridge",

  // Squid Router (Axelar)
  "0xce16f69375520ab01377ce7b88f5ba8c48f8d666": "squid",
};

const CEX_ADDRESSES: Record<string, string> = {
  // Binance (hot wallets on Polygon)
  "0xf977814e90da44bfa03b6295a0616a897441acec": "binance",
  "0x290275e3db66394c52272398959845170e4dcb88": "binance",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "binance",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "binance",
  "0x56eddb7aa87536c09ccc2793473599fd21a8b17f": "binance",
  "0x9696f59e4d72e237be84ffd425dcad154bf96976": "binance",
  "0x4976a4a02f38326660d17bf34b431dc6e2eb2327": "binance",

  // Coinbase
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "coinbase",
  "0x503828976d22510aad0201ac7ec88293211d23da": "coinbase",
  "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": "coinbase",
  "0x3cd751e6b0078be393132286c442345e5dc49699": "coinbase",
  "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": "coinbase",
  "0xeb2629a2734e272bcc07bda959863f316f4bd4cf": "coinbase",
  "0x77696bb39917c91a0c3908d577d5e322095425ca": "coinbase",
  "0xfcd3842f85ed87ba2889b4d35893403796e67ff1": "coinbase",

  // OKX
  "0xa7efae728d2936e78bda97dc267687568dd593f4": "okx",
  "0x59a5208b32e627891c389ebafc644145224006e8": "okx",
  "0xc708a1c712ba26dc618f972ad7a187f76c8596fd": "okx",
  "0x868dab0b8e21ec0a48b726a1ccf25f23362e947c": "okx",

  // Kraken
  "0xae2d4617c862309a3d75a0ffb358c7a5009c673f": "kraken",
  "0xa83b11093c858c86321fbc4c20fe82cdbd58e09e": "kraken",

  // Bybit
  "0xee5b5b923ffce93a870b3104b7ca09c3db80047a": "bybit",
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "bybit",

  // MEXC
  "0x9e6cee49c6bb9d7b4ee10cba2bf63d8146ba2f1c": "mexc",
  "0x4982085c9e2f89f2ecb8131eca71afad896e89cb": "mexc",
  "0x53af8aaae5dc9c54e7e16cb2eeb0b657d5532fdf": "mexc",

  // Gate.io
  "0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c": "gate",

  // KuCoin
  "0xd6216fc19db775df9774a6e33526131da7d19a2c": "kucoin",
  "0xb8e6d31e7b212b2b7250ee9c26c56cebbfbe6b23": "kucoin",

  // HTX (formerly Huobi)
  "0xab5c66752a9e8167967685f1450532fb96d5d24f": "htx",
  "0xeec606a66edb6f497662ea31b5eb1610da87ab5f": "htx",
};

const FIAT_ONRAMP_ADDRESSES: Record<string, string> = {
  // MoonPay
  "0xeff39ab8773436cd35d62c7e2b6c0c2e0b16d6db": "moonpay",
  // Ramp
  "0xeb2629a2734e272bcc07bda959863f316f4bd4ff": "ramp",
  // Transak
  "0x7a64ab47a8efe49c5cbf3aa7c4cae42b75bbd1cc": "transak",
};

/**
 * Shared service hot wallets — OTC desks, onramps, market makers, Polymarket-
 * internal relayers. Anything that funds *many* unrelated end-user wallets.
 *
 * Critical for the cluster signal: two end-users sharing the SAME shared-
 * service funder is NOT a coordination signal (would otherwise spuriously
 * fire "same private funder = 0.8"). Add addresses here as you encounter
 * funders with high recipient fan-out (eth_getCode = 0x and `from` in many
 * transfers to disjoint users).
 */
const SHARED_SERVICE_ADDRESSES: Record<string, string> = {
  // Discovered 2026-05-18: appears as first_inflow_from for both Theo4
  // (top-profit) and Fredi9999 (#2 profit). 668 unique recipients in
  // last 1000 transfers, volumes $118 to $2M — clearly a service hub,
  // not a personal wallet. Likely Polymarket-related onramp/OTC.
  "0x4b6f17856215eab57c29ebfa18b0a0f74a3627bb": "polymarket-distributor",
};

/** Classify a from-address. Always lowercased input. */
export function classify(addressLower: string): FundingCategory {
  if (!addressLower) return null;
  const service = SHARED_SERVICE_ADDRESSES[addressLower];
  if (service) return `service:${service}` as FundingCategory;
  const bridge = BRIDGE_ADDRESSES[addressLower];
  if (bridge) return `bridge:${bridge}` as FundingCategory;
  const cex = CEX_ADDRESSES[addressLower];
  if (cex) return `cex:${cex}` as FundingCategory;
  const fiat = FIAT_ONRAMP_ADDRESSES[addressLower];
  if (fiat) return "fiat_onramp";
  return null;
}

/** Coarse buckets: "bridge", "cex", "fiat", "service", or "private" (null). */
export function categoryBucket(c: FundingCategory): "bridge" | "cex" | "fiat" | "service" | "private" {
  if (c === null) return "private";
  if (c === "fiat_onramp") return "fiat";
  if (c.startsWith("service:")) return "service";
  if (c.startsWith("bridge:")) return "bridge";
  return "cex";
}
