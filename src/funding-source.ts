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
  | `swap:${string}`
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

/**
 * CEX hot wallets across chains.
 *
 * IMPORTANT: EOAs are technically chain-agnostic (same private key derives
 * the same address on every EVM chain), BUT exchanges OPERATIONALLY use
 * DIFFERENT hot wallets on different chains. Example: Bitget on Base does
 * NOT use the same EOA as Bitget on Ethereum or BNB. To match a wallet
 * funded from Bitget Base, you need a Base-specific Bitget hot-wallet
 * address in this dict — Ethereum addresses won't catch it.
 *
 * This dict is multi-chain by lookup (we don't enforce chainId match), but
 * coverage MUST be expanded per-chain. Focus on top chains for Polymarket:
 *   Ethereum (1), Polygon (137), Base (8453), Arbitrum (42161),
 *   BSC (56), Optimism (10), Solana (792703809 per Relay).
 * Lower-traffic chains like Aurora can be skipped.
 *
 * Add an address by lowercased form. Solana base58 case is collapsed too.
 */
const CEX_ADDRESSES: Record<string, string> = {
  // Binance
  "0xf977814e90da44bfa03b6295a0616a897441acec": "binance",
  "0x290275e3db66394c52272398959845170e4dcb88": "binance",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "binance",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "binance",
  "0x56eddb7aa87536c09ccc2793473599fd21a8b17f": "binance",
  "0x9696f59e4d72e237be84ffd425dcad154bf96976": "binance",
  "0x4976a4a02f38326660d17bf34b431dc6e2eb2327": "binance",
  "0x28c6c06298d514db089934071355e5743bf21d60": "binance", // Binance 14 (Ethereum)
  "0x8d97689c9818892b700e27f316cc3e41e17fbeb9": "binance",
  "0xbd612a3f30dca67bf60a39fd0d35e39b7ab80774": "binance",
  "0xa180fe01b906a1be37be6c534a3300785b20d947": "binance",
  "0xb4d12f10c34acbbd16d5b22dadeb09bd9d8f9c81": "binance",
  "0xd0a3a8b14b30a3a8b048bbb37086a3afff79e21d": "binance",

  // Coinbase
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "coinbase",
  "0x503828976d22510aad0201ac7ec88293211d23da": "coinbase",
  "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": "coinbase",
  "0x3cd751e6b0078be393132286c442345e5dc49699": "coinbase",
  "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": "coinbase",
  "0xeb2629a2734e272bcc07bda959863f316f4bd4cf": "coinbase",
  "0x77696bb39917c91a0c3908d577d5e322095425ca": "coinbase",
  "0xfcd3842f85ed87ba2889b4d35893403796e67ff1": "coinbase",
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "coinbase",
  "0x6b76f8b1e9e59913bfe758821887311ba1805cab": "coinbase",
  "0xd34d96e1be88a8e4e8bb37dc8c7e02fe1cbaba47": "coinbase",

  // OKX
  "0xa7efae728d2936e78bda97dc267687568dd593f4": "okx",
  "0x59a5208b32e627891c389ebafc644145224006e8": "okx",
  "0xc708a1c712ba26dc618f972ad7a187f76c8596fd": "okx",
  "0x868dab0b8e21ec0a48b726a1ccf25f23362e947c": "okx",
  "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3": "okx",
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "okx",

  // Kraken
  "0xae2d4617c862309a3d75a0ffb358c7a5009c673f": "kraken",
  "0xa83b11093c858c86321fbc4c20fe82cdbd58e09e": "kraken",
  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "kraken",
  "0x53d284357ec70ce289d6d64134dfac8e511c8a3d": "kraken",

  // Bybit
  "0xee5b5b923ffce93a870b3104b7ca09c3db80047a": "bybit",
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "bybit",
  "0xa7a93fd0a276fc1c0197a5b5623ed117786eed06": "bybit",

  // MEXC
  "0x9e6cee49c6bb9d7b4ee10cba2bf63d8146ba2f1c": "mexc",
  "0x4982085c9e2f89f2ecb8131eca71afad896e89cb": "mexc",
  "0x53af8aaae5dc9c54e7e16cb2eeb0b657d5532fdf": "mexc",

  // Gate.io
  "0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c": "gate",
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "gate",

  // KuCoin
  "0xd6216fc19db775df9774a6e33526131da7d19a2c": "kucoin",
  "0xb8e6d31e7b212b2b7250ee9c26c56cebbfbe6b23": "kucoin",
  "0x2933782b5a8d72f2754103d1489614f29bfa4625": "kucoin",

  // HTX (formerly Huobi)
  "0xab5c66752a9e8167967685f1450532fb96d5d24f": "htx",
  "0xeec606a66edb6f497662ea31b5eb1610da87ab5f": "htx",
  "0xdc76cd25977e0a5ae17155770273ad58648900d3": "htx",

  // Bitget — uses DIFFERENT EOAs across chains. Add per-chain as observed.
  // Ethereum / BSC:
  "0x5be9a4959308a0d0c7bc0870e319314d8d957dbb": "bitget",
  "0x0639556f03714a74a5feeaf5736a4a64ff70d206": "bitget",
  "0xa1d8d972560c2f8144af871db508f0b0b10a3fbf": "bitget",
  // Base hot wallet(s) for Bitget are NOT the same as Ethereum — add when
  // observed in real alerts. Leaving as TODO instead of guessing.

  // Solana CEX hot wallets (base58, lowercased to match our normalization).
  // Note: lowercasing collapses base58 case sensitivity — extremely low real
  // collision risk but worth knowing. Compare strictly against this dict.
  "5tzfkikscxhk5zxcgbxzxdw7gtjjd1mbwuofbhuvuai9": "binance",
  "9un5wqe3q4ag8bni4dhhpxfluMrubqxgnzuyxmjphsbt": "binance",
  "9wzdxwbbmkg8ztbnmquxvqraygzzdsgydlvl9zytawwm": "binance",
  "h8smjscqxfkiftcfdr3dumlpwcrbm61lgfj8n4dk3wjs": "coinbase",
  "2aqdphj2jpcegpiatuxjqxa8qmaffegfqwslwsprpicm": "coinbase",
  "fpwqqhqqoeavu3wu2qzmff1hx48yyfwsLorgxg83e99t": "coinbase",
  "fwznbcnxwquhtawe9rxvq2ldcenssh12dsznf4riouN5": "kraken",
  "5vcwktcxgcj6kit5fybxjvriw3xelsfdhyrpsqtjnmcd": "okx",
  "8sgbxz3yrq9zdwzehywzqyiua9adn8jmidodzlh2cmav": "bybit",
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
 * Non-custodial swap aggregators / instant-swap services.
 *
 * Functionally similar to CEX hot wallets from a clustering POV: a single
 * hot wallet sends to many recipients. Two Polygon proxies funded via
 * the SAME swap service in a tight window can hint at the same actor
 * orchestrating both — DO NOT skip these like internal Polymarket service
 * hubs. cluster signal treats `swap` bucket identically to `cex`.
 *
 * Expand as new aggregator addresses are observed. Cross-chain operations
 * apply same as for CEX: each chain may have separate hot wallets.
 */
const SWAP_AGGREGATOR_ADDRESSES: Record<string, string> = {
  // ChangeNOW — well-known non-KYC swap.
  "0x077d360f11d220e4d5d831430c81c26c9be7c4a4": "changenow",
  // FixedFloat
  "0x4e5b2e1dc63f6b91cb6cd759936495434c7e972f": "fixedfloat",
  // SimpleSwap
  "0x6f048e1bbe1ee19e8b51eaa67ec02a2079b8a4f1": "simpleswap",
  // Sideshift
  "0xebd5e1c8d8c5e7a48aaa0a14c12af0a6cf6cf90a": "sideshift",
  // LetsExchange / StealthEx (non-KYC swaps frequently used by users
  // who want to hide funding origin — high-signal when matched):
  "0xf6da21e95d74767009accb145b96897ac3630bad": "stealthex",
  // Per-chain coverage incomplete — add Base/Arbitrum/Solana variants
  // when observed in alerts.
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
  const swap = SWAP_AGGREGATOR_ADDRESSES[addressLower];
  if (swap) return `swap:${swap}` as FundingCategory;
  const fiat = FIAT_ONRAMP_ADDRESSES[addressLower];
  if (fiat) return "fiat_onramp";
  return null;
}

/** Coarse buckets: "bridge", "cex", "swap", "fiat", "service", or "private" (null). */
export function categoryBucket(
  c: FundingCategory,
): "bridge" | "cex" | "swap" | "fiat" | "service" | "private" {
  if (c === null) return "private";
  if (c === "fiat_onramp") return "fiat";
  if (c.startsWith("service:")) return "service";
  if (c.startsWith("bridge:")) return "bridge";
  if (c.startsWith("swap:")) return "swap";
  return "cex";
}
