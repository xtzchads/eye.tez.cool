// ============================================================================
// The Eye of Chad — Modern Tezos Flow & Sankey Explorer (Unified Multi-Ribbon Node Edition)
// Single node per counterparty address with multiple color-coded token ribbons
// ============================================================================

// TzKT L1 Indexer & Rate-Limit Constants
const TZKT_INDEXER = 'https://kukai.api.tzkt.io';
const TZKT_API_BASE = `${TZKT_INDEXER.replace(/\/+(v1\/?)?$/, '')}/v1`;
const TZKT_FALLBACK_API_BASE = 'https://staging.kukai.api.tzkt.io/v1';
const TZKT_EXPLORER_BASE = 'https://tzkt.io';
const TZKT_AVATARS_BASE = 'https://services.tzkt.io/v1/avatars';
const TZKT_MAX_REQUESTS_PER_SECOND = 6;
const TZKT_MAX_RETRIES = 3;
const TZKT_RETRY_BASE_DELAY_MS = 650;

// Tracks the most recent TzKT API error for UI diagnostics
let lastTzktApiError = null;

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfterMs(response, attempt) {
  const header = response?.headers?.get?.('Retry-After');
  if (header) {
    const secs = Number(header);
    if (!isNaN(secs) && secs > 0) {
      return Math.min(10000, Math.ceil(secs * 1000));
    }
    const dateMs = Date.parse(header);
    if (!isNaN(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) return Math.min(10000, diff);
    }
  }
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(8000, TZKT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + jitter);
}

// TzKT Rate-Limited Parallel Request Scheduler (max 6 concurrent & max 6 requests/second)
const tzktFetch = (() => {
  const windowMs = 1020; // 1,000ms sliding window + 20ms safety buffer
  const dispatchTimestamps = [];
  const queue = [];
  let inFlight = 0;
  let timerId = null;
  let cooldownUntil = 0;

  function pruneOldTimestamps(now) {
    while (dispatchTimestamps.length > 0 && now - dispatchTimestamps[0] >= windowMs) {
      dispatchTimestamps.shift();
    }
  }

  function scheduleNextPump(waitMs) {
    if (timerId !== null) return;
    timerId = setTimeout(() => {
      timerId = null;
      pump();
    }, Math.max(10, waitMs));
  }

  function applyCooldown(delayMs) {
    const target = Date.now() + delayMs;
    if (target > cooldownUntil) {
      cooldownUntil = target;
    }
  }

  function pump() {
    while (queue.length > 0 && inFlight < TZKT_MAX_REQUESTS_PER_SECOND) {
      const now = Date.now();
      if (now < cooldownUntil) {
        scheduleNextPump(cooldownUntil - now);
        return;
      }

      pruneOldTimestamps(now);

      if (dispatchTimestamps.length >= TZKT_MAX_REQUESTS_PER_SECOND) {
        const waitMs = windowMs - (now - dispatchTimestamps[0]);
        scheduleNextPump(waitMs);
        return;
      }

      const task = queue.shift();
      inFlight++;
      dispatchTimestamps.push(now);

      Promise.resolve()
        .then(() => fetch(task.url, task.options))
        .then(task.resolve, task.reject)
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }

  function enqueueSingleAttempt(url, options, isRetry = false) {
    return new Promise((resolve, reject) => {
      const task = { url, options, resolve, reject };
      if (isRetry) {
        queue.unshift(task);
      } else {
        queue.push(task);
      }
      pump();
    });
  }

  return async function scheduleTzktFetch(url, options) {
    let lastErr = null;
    for (let attempt = 0; attempt <= TZKT_MAX_RETRIES; attempt++) {
      const useFallback =
        attempt === TZKT_MAX_RETRIES &&
        TZKT_FALLBACK_API_BASE &&
        TZKT_FALLBACK_API_BASE !== TZKT_API_BASE &&
        String(url).startsWith(TZKT_API_BASE);
      const targetUrl = useFallback ? String(url).replace(TZKT_API_BASE, TZKT_FALLBACK_API_BASE) : url;

      try {
        const response = await enqueueSingleAttempt(targetUrl, options, attempt > 0);
        if (response.ok) {
          return response;
        }

        const status = response.status;
        if (!isRetryableHttpStatus(status)) {
          // 4xx Client Error (e.g., 400 Bad Request, 404 Not Found): fail fast without retrying
          lastTzktApiError = {
            status,
            category: '4xx',
            isClientError: true,
            url: targetUrl,
            timestamp: Date.now()
          };
          return response;
        }

        // 429 Rate Limit, 408 Timeout, or 5xx Server Error
        lastTzktApiError = {
          status,
          category: status === 429 ? '429' : '5xx',
          isServerError: true,
          url: targetUrl,
          timestamp: Date.now()
        };

        if (attempt < TZKT_MAX_RETRIES) {
          const delayMs = parseRetryAfterMs(response, attempt);
          if (status === 429) {
            applyCooldown(delayMs);
          }
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        return response;
      } catch (err) {
        lastErr = err;
        lastTzktApiError = {
          status: 0,
          category: 'network',
          isNetworkError: true,
          message: err?.message || 'Network error',
          url: targetUrl,
          timestamp: Date.now()
        };
        if (attempt < TZKT_MAX_RETRIES) {
          const delayMs = parseRetryAfterMs(null, attempt);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr || new Error('TzKT request failed');
  };
})();

const input = document.getElementById('target-address');
const dropdown = document.createElement('div');
dropdown.className = 'address-dropdown';

// Session state & cache
const cache = new Map(); // Map<address, { txData, specialOps, limit, lastOffset, exhausted, faData, faLimit, faLastOffset, faExhausted, accountInfo }>
const txIdToHashCache = new Map(); // Map<number, string> for resolving TzKT token transfer transactionId -> opHash
let history = [];
let historyIndex = -1;

// Supported Token Definitions (Native XTZ + Tracked FA1.2 / FA2 Tokens)
const TOKEN_DEFINITIONS = {
  xtz: {
    key: 'xtz',
    symbol: 'ꜩ',
    ticker: 'XTZ',
    name: 'Tezos (XTZ)',
    contract: null,
    tokenId: null,
    decimals: 6,
    isNative: true,
    tezEquivalentRate: 1,
    inflowColor: '#10b981',
    inflowLight: '#34d399',
    outflowColor: '#f43f5e',
    outflowLight: '#fb7185',
    returnColor: '#ec4899',
    returnTextColor: '#f472b6',
    cardBorder: 'rgba(255, 255, 255, 0.1)',
    badgeBg: 'rgba(16, 185, 129, 0.18)',
    badgeStroke: 'rgba(16, 185, 129, 0.45)',
    badgeText: '#6ee7b7',
    gradInflow: 'url(#grad-inflow)',
    gradOutflow: 'url(#grad-outflow)',
    gradCircular: 'url(#grad-circular)'
  },
  tzbtc: {
    key: 'tzbtc',
    symbol: 'tzBTC',
    ticker: 'tzBTC',
    name: 'tzBTC',
    contract: 'KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn',
    tokenId: '0',
    decimals: 8,
    isNative: false,
    tezEquivalentRate: 85000,
    inflowColor: '#f7931a',
    inflowLight: '#fbbf24',
    outflowColor: '#f7931a',
    outflowLight: '#fb923c',
    returnColor: '#f59e0b',
    returnTextColor: '#fde047',
    cardBorder: 'rgba(247, 147, 26, 0.42)',
    badgeBg: 'rgba(247, 147, 26, 0.2)',
    badgeStroke: 'rgba(251, 191, 36, 0.55)',
    badgeText: '#fbbf24',
    gradInflow: 'url(#grad-inflow-tzbtc)',
    gradOutflow: 'url(#grad-outflow-tzbtc)',
    gradCircular: 'url(#grad-circular-tzbtc)'
  },
  usdt: {
    key: 'usdt',
    symbol: 'USDt',
    ticker: 'USDt',
    name: 'Tether USD (Tezos FA2)',
    contract: 'KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o',
    tokenId: '0',
    decimals: 6,
    isNative: false,
    tezEquivalentRate: 1.25,
    inflowColor: '#06b6d4',
    inflowLight: '#22d3ee',
    outflowColor: '#06b6d4',
    outflowLight: '#38bdf8',
    returnColor: '#0ea5e9',
    returnTextColor: '#67e8f9',
    cardBorder: 'rgba(34, 211, 238, 0.42)',
    badgeBg: 'rgba(6, 182, 212, 0.2)',
    badgeStroke: 'rgba(34, 211, 238, 0.55)',
    badgeText: '#22d3ee',
    gradInflow: 'url(#grad-inflow-usdt)',
    gradOutflow: 'url(#grad-outflow-usdt)',
    gradCircular: 'url(#grad-circular-usdt)'
  },
  usdt_l2: {
    key: 'usdt_l2',
    symbol: 'USDT',
    ticker: 'USDT',
    name: 'Tether USD (Etherlink USDT)',
    contract: '0x2c03058c8afc06713be23e58d2febc8337dbfe6a',
    l2Contract: '0x2c03058c8afc06713be23e58d2febc8337dbfe6a',
    tokenId: '0',
    decimals: 6,
    isNative: false,
    tezEquivalentRate: 1.25,
    inflowColor: '#06b6d4',
    inflowLight: '#22d3ee',
    outflowColor: '#06b6d4',
    outflowLight: '#38bdf8',
    returnColor: '#0ea5e9',
    returnTextColor: '#67e8f9',
    cardBorder: 'rgba(34, 211, 238, 0.42)',
    badgeBg: 'rgba(6, 182, 212, 0.2)',
    badgeStroke: 'rgba(34, 211, 238, 0.55)',
    badgeText: '#22d3ee',
    gradInflow: 'url(#grad-inflow-usdt)',
    gradOutflow: 'url(#grad-outflow-usdt)',
    gradCircular: 'url(#grad-circular-usdt)'
  },
  usdc: {
    key: 'usdc',
    symbol: 'USDC',
    ticker: 'USDC',
    name: 'LayerZero Bridged USDC',
    contract: '0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9',
    l2Contract: '0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9',
    tokenId: '0',
    decimals: 6,
    isNative: false,
    tezEquivalentRate: 1.25,
    inflowColor: '#3b82f6',
    inflowLight: '#60a5fa',
    outflowColor: '#2563eb',
    outflowLight: '#93c5fd',
    returnColor: '#1d4ed8',
    returnTextColor: '#93c5fd',
    cardBorder: 'rgba(96, 165, 250, 0.42)',
    badgeBg: 'rgba(59, 130, 246, 0.2)',
    badgeStroke: 'rgba(96, 165, 250, 0.55)',
    badgeText: '#60a5fa',
    gradInflow: 'url(#grad-inflow-usdc)',
    gradOutflow: 'url(#grad-outflow-usdc)',
    gradCircular: 'url(#grad-circular-usdc)'
  },
  wxtz: {
    key: 'wxtz',
    symbol: 'WXTZ',
    ticker: 'WXTZ',
    name: 'Wrapped XTZ (WXTZ)',
    contract: '0xc9b53ab2679f573e480d01e0f49e2b5cfb7a3eab',
    l2Contract: '0xc9b53ab2679f573e480d01e0f49e2b5cfb7a3eab',
    tokenId: '0',
    decimals: 18,
    isNative: false,
    tezEquivalentRate: 1,
    inflowColor: '#6366f1',
    inflowLight: '#a5b4fc',
    outflowColor: '#4f46e5',
    outflowLight: '#818cf8',
    returnColor: '#6366f1',
    returnTextColor: '#c7d2fe',
    cardBorder: 'rgba(129, 140, 248, 0.42)',
    badgeBg: 'rgba(99, 102, 241, 0.2)',
    badgeStroke: 'rgba(165, 180, 252, 0.55)',
    badgeText: '#a5b4fc',
    gradInflow: 'url(#grad-inflow-wxtz)',
    gradOutflow: 'url(#grad-outflow-wxtz)',
    gradCircular: 'url(#grad-circular-wxtz)'
  },
  weth: {
    key: 'weth',
    symbol: 'WETH',
    ticker: 'WETH',
    name: 'Bridged WETH',
    contract: '0xfc24f770f94edbca6d6f885e12d4317320bcb401',
    l2Contract: '0xfc24f770f94edbca6d6f885e12d4317320bcb401',
    tokenId: '0',
    decimals: 18,
    isNative: false,
    tezEquivalentRate: 3000,
    inflowColor: '#a855f7',
    inflowLight: '#c084fc',
    outflowColor: '#9333ea',
    outflowLight: '#d8b4fe',
    returnColor: '#7e22ce',
    returnTextColor: '#e9d5ff',
    cardBorder: 'rgba(192, 132, 252, 0.42)',
    badgeBg: 'rgba(168, 85, 247, 0.2)',
    badgeStroke: 'rgba(192, 132, 252, 0.55)',
    badgeText: '#c084fc',
    gradInflow: 'url(#grad-inflow-weth)',
    gradOutflow: 'url(#grad-outflow-weth)',
    gradCircular: 'url(#grad-circular-weth)'
  },
  lbtc: {
    key: 'lbtc',
    symbol: 'LBTC',
    ticker: 'LBTC',
    name: 'Lombard Staked Bitcoin (LBTC)',
    contract: '0xecac9c5f704e954931349da37f60e39f515c11c1',
    l2Contract: '0xecac9c5f704e954931349da37f60e39f515c11c1',
    tokenId: '0',
    decimals: 8,
    isNative: false,
    tezEquivalentRate: 85000,
    inflowColor: '#d97706',
    inflowLight: '#fcd34d',
    outflowColor: '#b45309',
    outflowLight: '#fbbf24',
    returnColor: '#f59e0b',
    returnTextColor: '#fde68a',
    cardBorder: 'rgba(245, 158, 11, 0.42)',
    badgeBg: 'rgba(217, 119, 6, 0.22)',
    badgeStroke: 'rgba(251, 191, 36, 0.55)',
    badgeText: '#fcd34d',
    gradInflow: 'url(#grad-inflow-lbtc)',
    gradOutflow: 'url(#grad-outflow-lbtc)',
    gradCircular: 'url(#grad-circular-lbtc)'
  },
  wbtc: {
    key: 'wbtc',
    symbol: 'WBTC',
    ticker: 'WBTC',
    name: 'Wrapped BTC (WBTC)',
    contract: '0xbfc94cd2b1e55999cfc7347a9313e88702b83d0f',
    l2Contract: '0xbfc94cd2b1e55999cfc7347a9313e88702b83d0f',
    tokenId: '0',
    decimals: 8,
    isNative: false,
    tezEquivalentRate: 85000,
    inflowColor: '#f97316',
    inflowLight: '#fdba74',
    outflowColor: '#ea580c',
    outflowLight: '#fb923c',
    returnColor: '#c2410c',
    returnTextColor: '#fed7aa',
    cardBorder: 'rgba(251, 146, 60, 0.42)',
    badgeBg: 'rgba(249, 115, 22, 0.22)',
    badgeStroke: 'rgba(251, 146, 60, 0.55)',
    badgeText: '#fdba74',
    gradInflow: 'url(#grad-inflow-wbtc)',
    gradOutflow: 'url(#grad-outflow-wbtc)',
    gradCircular: 'url(#grad-circular-wbtc)'
  },
  xu3o8: {
    key: 'xu3o8',
    symbol: 'xU3O8',
    ticker: 'xU3O8',
    name: 'Uranium (xU3O8)',
    contract: '0x79052ab3c166d4899a1e0dd033ac3b379af0b1fd',
    l2Contract: '0x79052ab3c166d4899a1e0dd033ac3b379af0b1fd',
    tokenId: '0',
    decimals: 18,
    isNative: false,
    tezEquivalentRate: 7,
    inflowColor: '#84cc16',
    inflowLight: '#bef264',
    outflowColor: '#65a30d',
    outflowLight: '#a3e635',
    returnColor: '#4d7c0f',
    returnTextColor: '#d9f99d',
    cardBorder: 'rgba(163, 230, 53, 0.42)',
    badgeBg: 'rgba(132, 204, 22, 0.2)',
    badgeStroke: 'rgba(163, 230, 53, 0.55)',
    badgeText: '#bef264',
    gradInflow: 'url(#grad-inflow-xu3o8)',
    gradOutflow: 'url(#grad-outflow-xu3o8)',
    gradCircular: 'url(#grad-circular-xu3o8)'
  }
};

const L1_FA_TOKEN_KEYS = ['tzbtc', 'usdt'];
const L2_ERC20_TOKEN_KEYS = ['usdt_l2', 'usdc', 'wxtz', 'weth', 'lbtc', 'wbtc', 'xu3o8'];
const FA_TOKEN_KEYS = [...L1_FA_TOKEN_KEYS, ...L2_ERC20_TOKEN_KEYS];
const ALL_TOKEN_ORDER = ['xtz', ...FA_TOKEN_KEYS];
const FA_CONTRACT_LIST = L1_FA_TOKEN_KEYS.map((k) => TOKEN_DEFINITIONS[k].contract).join(',');

const CONTRACT_TO_TOKEN_KEY = new Map();
FA_TOKEN_KEYS.forEach((k) => {
  const def = TOKEN_DEFINITIONS[k];
  if (def.contract) {
    CONTRACT_TO_TOKEN_KEY.set(def.contract, k);
    CONTRACT_TO_TOKEN_KEY.set(def.contract.toLowerCase(), k);
  }
  if (def.l2Contract) {
    CONTRACT_TO_TOKEN_KEY.set(def.l2Contract.toLowerCase(), k);
  }
});

function createEmptyTokenBalances() {
  return { tzbtc: 0, usdt: 0, usdt_l2: 0, usdc: 0, wxtz: 0, weth: 0, lbtc: 0, wbtc: 0, xu3o8: 0 };
}

// Etherlink L2 Bridge & Blockscout Explorer Constants
const ETHERLINK_BRIDGE_CONTRACT = 'KT1Wj8SUGmnEPFqyahHAcjcNQwe6YGhEXJb5';
const ETHERLINK_WITHDRAW_CONTRACT = 'KT1BGwyCrnJ6HuEYP7X8Q2UooTdxmEYHiK6j';
const ETHERLINK_L2_FEED_ADDRESS = '0x000000000000000000000000000000000000feed';
const ETHERLINK_L2_WITHDRAW_PRECOMPILE = '0xff00000000000000000000000000000000000001';
const ETHERLINK_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ETHERLINK_API_BASE = 'https://explorer.etherlink.com/api/v2';
const ETHERLINK_EXPLORER_BASE = 'https://explorer.etherlink.com';
const BLOCKSCOUT_MAX_REQUESTS_PER_MINUTE = 170; // Safe headroom under Blockscout's 180 req / 60s IP bucket
const BLOCKSCOUT_MAX_PARALLEL_REQUESTS = 10;    // Max concurrent in-flight requests to maximize burst throughput
const BLOCKSCOUT_MAX_RETRIES = 3;
const BLOCKSCOUT_RETRY_BASE_DELAY_MS = 650;

let lastBlockscoutApiError = null;

function parseBlockscoutRetryDelayMs(response, attempt) {
  const rlResetMs = Number(response?.headers?.get?.('x-ratelimit-reset'));
  if (!isNaN(rlResetMs) && rlResetMs > 0) {
    return Math.min(15000, Math.max(500, Math.ceil(rlResetMs)));
  }
  return parseRetryAfterMs(response, attempt);
}

// Blockscout Rate-Limited Parallel Request Scheduler (180 req / 60s sliding bucket + max 10 concurrent in-flight)
const blockscoutFetch = (() => {
  const windowMs = 60200; // 60,000ms sliding window + 200ms safety buffer
  const dispatchTimestamps = [];
  const queue = [];
  let inFlight = 0;
  let timerId = null;
  let cooldownUntil = 0;

  function pruneOldTimestamps(now) {
    while (dispatchTimestamps.length > 0 && now - dispatchTimestamps[0] >= windowMs) {
      dispatchTimestamps.shift();
    }
  }

  function scheduleNextPump(waitMs) {
    if (timerId !== null) return;
    timerId = setTimeout(() => {
      timerId = null;
      pump();
    }, Math.max(10, waitMs));
  }

  function applyCooldown(delayMs) {
    const target = Date.now() + delayMs;
    if (target > cooldownUntil) {
      cooldownUntil = target;
    }
  }

  function inspectRateLimitHeaders(response) {
    if (!response?.headers?.get) return;
    const remRaw = response.headers.get('x-ratelimit-remaining');
    const resetRaw = response.headers.get('x-ratelimit-reset');
    if (remRaw !== null && resetRaw !== null) {
      const remaining = Number(remRaw);
      const resetMs = Number(resetRaw);
      if (!isNaN(remaining) && !isNaN(resetMs) && remaining <= inFlight + 2 && resetMs > 0) {
        applyCooldown(Math.min(60000, Math.max(250, resetMs)));
      }
    }
  }

  function pump() {
    while (queue.length > 0 && inFlight < BLOCKSCOUT_MAX_PARALLEL_REQUESTS) {
      const now = Date.now();
      if (now < cooldownUntil) {
        scheduleNextPump(cooldownUntil - now);
        return;
      }

      pruneOldTimestamps(now);

      if (dispatchTimestamps.length >= BLOCKSCOUT_MAX_REQUESTS_PER_MINUTE) {
        const waitMs = windowMs - (now - dispatchTimestamps[0]);
        scheduleNextPump(waitMs);
        return;
      }

      const task = queue.shift();
      inFlight++;
      dispatchTimestamps.push(now);

      Promise.resolve()
        .then(() => fetch(task.url, task.options))
        .then(
          (res) => {
            inspectRateLimitHeaders(res);
            task.resolve(res);
          },
          task.reject
        )
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }

  function enqueueSingleAttempt(url, options, isRetry = false) {
    return new Promise((resolve, reject) => {
      const task = { url, options, resolve, reject };
      if (isRetry) {
        queue.unshift(task);
      } else {
        queue.push(task);
      }
      pump();
    });
  }

  return async function scheduleBlockscoutFetch(url, options) {
    let lastErr = null;
    for (let attempt = 0; attempt <= BLOCKSCOUT_MAX_RETRIES; attempt++) {
      try {
        const response = await enqueueSingleAttempt(url, options, attempt > 0);
        if (response.ok) {
          return response;
        }

        const status = response.status;
        if (!isRetryableHttpStatus(status)) {
          // 4xx Client Error (e.g., 400 Bad Request, 404 Not Found, 422 Unprocessable): fail fast without retrying
          lastBlockscoutApiError = {
            source: 'Blockscout',
            status,
            category: '4xx',
            isClientError: true,
            url,
            timestamp: Date.now()
          };
          return response;
        }

        // 429 Rate Limit, 408 Timeout, or 5xx Server Error
        lastBlockscoutApiError = {
          source: 'Blockscout',
          status,
          category: status === 429 ? '429' : '5xx',
          isServerError: true,
          url,
          timestamp: Date.now()
        };

        if (attempt < BLOCKSCOUT_MAX_RETRIES) {
          const delayMs = parseBlockscoutRetryDelayMs(response, attempt);
          if (status === 429) {
            applyCooldown(delayMs);
          }
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        return response;
      } catch (err) {
        lastErr = err;
        lastBlockscoutApiError = {
          source: 'Blockscout',
          status: 0,
          category: 'network',
          isNetworkError: true,
          message: err?.message || 'Network error',
          url,
          timestamp: Date.now()
        };
        if (attempt < BLOCKSCOUT_MAX_RETRIES) {
          const delayMs = parseRetryAfterMs(null, attempt);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  };
})();

// Etherlink Tracked ERC-20 Token Contracts (lowercase)
const ETHERLINK_LBTC_CONTRACT = '0xecac9c5f704e954931349da37f60e39f515c11c1';
const ETHERLINK_WBTC_CONTRACT = '0xbfc94cd2b1e55999cfc7347a9313e88702b83d0f';
const ETHERLINK_USDC_CONTRACT = '0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9';
const ETHERLINK_WETH_CONTRACT = '0xfc24f770f94edbca6d6f885e12d4317320bcb401';
const ETHERLINK_WXTZ_CONTRACT = '0xc9b53ab2679f573e480d01e0f49e2b5cfb7a3eab';
const ETHERLINK_XU3O8_CONTRACT = '0x79052ab3c166d4899a1e0dd033ac3b379af0b1fd';
const ETHERLINK_USDT_CONTRACT = '0x2c03058c8afc06713be23e58d2febc8337dbfe6a';
const ETHERLINK_TRACKED_TOKEN_CONTRACTS = [
  ETHERLINK_USDT_CONTRACT,
  ETHERLINK_USDC_CONTRACT,
  ETHERLINK_WXTZ_CONTRACT,
  ETHERLINK_WETH_CONTRACT,
  ETHERLINK_LBTC_CONTRACT,
  ETHERLINK_WBTC_CONTRACT,
  ETHERLINK_XU3O8_CONTRACT
];

// LayerZero & Cross-Chain Bridge Contracts on Etherlink L2
const ETHERLINK_LZ_BRIDGE_CONTRACT = '0x1f8e735f424b7a49a885571a2fa104e8c13c26c7';
const ETHERLINK_LZ_ULN_CONTRACT = '0xcb566e3b6934fa77258d68ea18e931fa75e1aaaa';
const ETHERLINK_LBTC_BRIDGE_OFFRAMP = '0xcec185eb182c47d1ba1efc84e6959e18cd620be4';
const ETHERLINK_LBTC_BRIDGE_ROUTER = '0x1912c3cfafe8a76a32a92861d815ac2837f237ca';
const ETHERLINK_LBTC_TOKEN_POOL = '0x0ad276a2b14eb450897acd100fe530e88d656f02';

// KyberSwap MetaAggregationRouterV2 & AggregationExecutor Helper Contracts on Etherlink L2
const ETHERLINK_KYBERSWAP_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const ETHERLINK_KYBERSWAP_EXECUTOR_1 = '0x8f10b468b06c6fd214b65f87778827f7d113f996';
const ETHERLINK_KYBERSWAP_EXECUTOR_2 = '0x6e4141d33021b52c91c28608403db4a0ffb50ec6';
const ETHERLINK_KYBERSWAP_EXECUTOR_3 = '0x63242a4ea82847b20e506b63b0e2e2eff0cc6cb0';
const ETHERLINK_KYBERSWAP_EXECUTORS = [
  ETHERLINK_KYBERSWAP_EXECUTOR_1,
  ETHERLINK_KYBERSWAP_EXECUTOR_2,
  ETHERLINK_KYBERSWAP_EXECUTOR_3
];
const ETHERLINK_KYBERSWAP_EXECUTOR_SET = new Set(ETHERLINK_KYBERSWAP_EXECUTORS);

const ETHERLINK_BRIDGED_TOKEN_KEYS = new Set(['usdc', 'usdt_l2', 'weth', 'lbtc', 'wbtc']);
const ETHERLINK_LZ_BRIDGE_METHODS = new Set([
  'bridge',
  '0x252f7b01',
  'validatetransactionproofv1',
  'lzreceive',
  'sendfrom',
  'send',
  '0xc7c7f5b3',
  '0xcfc32570',
  'execute302',
  '0x879762e2',
  'ccipsend',
  '0x3b81ab9b',
  'execute'
]);

// Cross-layer memory: maps lowercase 0x L2 address -> Map<L1 sender address, { address, alias, amount, count, txHashes }>
const l2ToL1DepositorsMap = new Map();

function isEtherlinkAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim());
}

function isEtherlinkTxHash(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(hash || '').trim());
}

function getExplorerTxUrl(hash, fallbackAddress = '') {
  const clean = String(hash || '').trim();
  if (clean.startsWith('txid:')) {
    return getExplorerAddressUrl(fallbackAddress);
  }
  if (isEtherlinkTxHash(clean)) {
    return `${ETHERLINK_EXPLORER_BASE}/tx/${encodeURIComponent(clean)}`;
  }
  return `${TZKT_EXPLORER_BASE}/${encodeURIComponent(clean)}`;
}

function getExplorerAddressUrl(addr) {
  const clean = String(addr || '').trim();
  if (isEtherlinkAddress(clean)) {
    return `${ETHERLINK_EXPLORER_BASE}/address/${encodeURIComponent(clean)}`;
  }
  return `${TZKT_EXPLORER_BASE}/${encodeURIComponent(clean)}`;
}

function extractEtherlinkEvmAddress(parameter) {
  if (!parameter) return null;
  const val = parameter.value !== undefined ? parameter.value : parameter;
  let rawHex = '';
  if (typeof val === 'string') {
    rawHex = val;
  } else if (val && typeof val === 'object') {
    rawHex =
      val.l2_address ||
      val.l2_caller ||
      val.withdrawal?.l2_caller ||
      val.evm_address ||
      val.receiver ||
      val.target ||
      '';
    if (String(rawHex).startsWith('sr1') && val.l2_address) {
      rawHex = val.l2_address;
    }
  }
  const clean = String(rawHex || '').trim().replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{40}$/.test(clean)) {
    return '0x' + clean.toLowerCase();
  }
  if (/^[0-9a-fA-F]{42,64}$/.test(clean)) {
    return '0x' + clean.slice(-40).toLowerCase();
  }
  return null;
}

const ROLLUP_INTERNAL_TAGS = new Set([
  '998126b6:b6b9a58a',
  '2eeb2f90:5e3b8dec',
  'c7e6b1ec:ae9fb4c0',
  '556ecc37:efe5d793'
]);

function isRollupInternalParty(addr) {
  const s = String(addr || '').trim();
  if (!s) return false;
  let h1 = 5381;
  let h2 = 2166136261;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 * 33 + c) >>> 0;
    h2 = (h2 * 65599 + c + i) >>> 0;
  }
  const tag = `${h1.toString(16).padStart(8, '0')}:${h2.toString(16).padStart(8, '0')}`;
  return ROLLUP_INTERNAL_TAGS.has(tag);
}

function extractTezosL1AddressFromHex(rawInput) {
  const hex = String(rawInput || '').replace(/^0x/i, '');
  if (hex.length < 72) return null;
  let ascii = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    ascii += code >= 32 && code <= 126 ? String.fromCharCode(code) : ' ';
  }
  const matches = ascii.match(/\b(tz[1-4][1-9A-HJ-NP-Za-km-z]{33}|KT1[1-9A-HJ-NP-Za-km-z]{33})\b/g);
  if (!matches || matches.length === 0) return null;
  return matches.find((addr) => !isRollupInternalParty(addr)) || null;
}

// Active diagram state (allows instant re-rendering on filter/scale/sort changes)
let currentAddress = '';
let currentRawData = [];
let currentFaData = [];
let currentAccountInfo = null;
let currentParsed = null;

// Readability / View settings
let viewConfig = {
  scaleMode: 'sqrt',    // 'sqrt' | 'log' | 'linear'
  maxNodes: 50,         // 25 | 50 | 100 | 9999
  sortMode: 'amount',   // 'amount' | 'count' | 'recent'
  circularFlows: true,  // true = Circular Loopbacks (↺), false = Split (⇄)
  faEnabled: false,     // default false = only XTZ flows
  enabledTokens: new Set(['xtz']),
  expandedBranchNodes: new Set(),
  searchQuery: '',
  fullHeight: true
};

// Attach autocomplete dropdown inside the search input wrapper
const searchWrapper = input.parentElement;
searchWrapper.appendChild(dropdown);

// ============================================================================
// Utility Formatters
// ============================================================================

function formatTez(amount, compact = false) {
  if (amount === undefined || amount === null || isNaN(amount)) return '0 ꜩ';
  const abs = Math.abs(amount);
  if (compact) {
    if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M ꜩ`;
    if (abs >= 10_000) return `${(amount / 1_000).toFixed(1)}K ꜩ`;
    if (abs >= 1_000) return `${(amount / 1_000).toFixed(2)}K ꜩ`;
    if (abs >= 100) return `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} ꜩ`;
    if (abs >= 0.01) return `${amount.toLocaleString('en-US', { minimumFractionDigits: abs >= 1 ? 2 : 0, maximumFractionDigits: 2 })} ꜩ`;
    if (abs > 0) return `${amount < 0 ? '-' : ''}<0.01 ꜩ`;
    return '0 ꜩ';
  }
  if (abs >= 100) {
    return `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} ꜩ`;
  }
  if (abs >= 1) {
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ꜩ`;
  }
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ꜩ`;
}

function formatTokenAmount(amount, tokenKey = 'xtz', compact = false) {
  if (!tokenKey || tokenKey === 'xtz') {
    return formatTez(amount, compact);
  }
  const def = TOKEN_DEFINITIONS[tokenKey] || TOKEN_DEFINITIONS.xtz;
  const sym = def.symbol;
  if (amount === undefined || amount === null || isNaN(amount)) return `0 ${sym}`;
  const abs = Math.abs(amount);

  if (tokenKey === 'tzbtc' || tokenKey === 'lbtc' || tokenKey === 'wbtc' || tokenKey === 'weth') {
    if (compact) {
      if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M ${sym}`;
      if (abs >= 1_000) return `${(amount / 1_000).toFixed(2)}K ${sym}`;
      if (abs >= 100) return `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${sym}`;
      if (abs >= 1) return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`;
      if (abs >= 0.01) return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${sym}`;
      if (abs >= 0.0001) return `${amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${sym}`;
      if (abs > 0) return `${amount < 0 ? '-' : ''}<0.0001 ${sym}`;
      return `0 ${sym}`;
    }
    if (abs >= 100) {
      return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${sym}`;
    }
    if (abs >= 1) {
      return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${sym}`;
    }
    if (abs >= 0.01) {
      return `${amount.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 })} ${sym}`;
    }
    if (abs >= 0.0001) {
      return `${amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${sym}`;
    }
    return `${amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${sym}`;
  }

  // Default FA / ERC-20 formatting (e.g. USDt, USDC, WXTZ, xU3O8)
  if (compact) {
    if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M ${sym}`;
    if (abs >= 10_000) return `${(amount / 1_000).toFixed(1)}K ${sym}`;
    if (abs >= 1_000) return `${(amount / 1_000).toFixed(2)}K ${sym}`;
    if (abs >= 100) return `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${sym}`;
    if (abs >= 0.01) return `${amount.toLocaleString('en-US', { minimumFractionDigits: abs >= 1 ? 2 : 0, maximumFractionDigits: 2 })} ${sym}`;
    if (abs > 0) return `${amount < 0 ? '-' : ''}<0.01 ${sym}`;
    return `0 ${sym}`;
  }
  if (abs >= 100) {
    return `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${sym}`;
  }
  if (abs >= 1) {
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`;
  }
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${sym}`;
}

function shortenAddress(addr) {
  if (!addr) return '';
  if (addr.startsWith('~')) return addr;
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 7)}…${addr.slice(-5)}`;
}

function compactAddress(addr) {
  if (!addr) return '';
  if (addr.startsWith('~')) return addr;
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}…${addr.slice(-4)}`;
}

function truncateText(str, maxLen = 24) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function formatDateShort(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  return dateObj.toISOString().split('T')[0];
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateSliderTrack(slider) {
  if (!slider) return;
  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 100;
  const val = parseFloat(slider.value) || 0;
  const percent = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(90deg, #6366f1 0%, #10b981 ${percent}%, rgba(255, 255, 255, 0.1) ${percent}%, rgba(255, 255, 255, 0.1) 100%)`;
}

// ============================================================================
// Notification Toast
// ============================================================================

let notificationTimer = null;
function showNotification(message = 'Address and transactions copied to clipboard/console') {
  const notification = document.getElementById('notification');
  const textSpan = document.getElementById('notification-text');
  if (!notification) return;

  if (textSpan) {
    textSpan.textContent = message;
  } else {
    notification.textContent = message;
  }

  notification.classList.add('show');
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => {
    notification.classList.remove('show');
  }, 3200);
}

// ============================================================================
// Autocomplete Suggestions (TzKT Suggest API)
// ============================================================================

let suggestTimeout = null;

input.addEventListener('input', function () {
  const query = this.value.trim();

  if (suggestTimeout) clearTimeout(suggestTimeout);

  if (!query || query.length > 30 || query.startsWith('0x')) {
    dropdown.style.display = 'none';
    if (query.length === 36 || isEtherlinkAddress(query)) {
      go();
    }
    return;
  }

  suggestTimeout = setTimeout(() => {
    fetchAddressSuggestions(query);
  }, 260);
});

document.addEventListener('click', function (event) {
  if (!input.contains(event.target) && !dropdown.contains(event.target)) {
    dropdown.style.display = 'none';
  }
});

input.addEventListener('keydown', function (event) {
  if (event.key === 'ArrowDown' && dropdown.style.display !== 'none') {
    event.preventDefault();
    focusNextItem();
  } else if (event.key === 'ArrowUp' && dropdown.style.display !== 'none') {
    event.preventDefault();
    focusPreviousItem();
  } else if (event.key === 'Enter') {
    if (dropdown.style.display !== 'none') {
      const focused = dropdown.querySelector('.address-item.focused');
      if (focused) {
        event.preventDefault();
        selectAddress(focused.dataset.address, focused.dataset.alias);
        return;
      }
    }
    dropdown.style.display = 'none';
    go();
  } else if (event.key === 'Escape') {
    dropdown.style.display = 'none';
  }
});

async function fetchAddressSuggestions(query) {
  try {
    dropdown.innerHTML = '<div class="no-results"><i class="fa-solid fa-spinner fa-spin"></i> Searching TzKT...</div>';
    dropdown.style.display = 'block';

    const encoded = encodeURIComponent(query);
    let response = await tzktFetch(`${TZKT_API_BASE}/suggest/accounts/${encoded}`);
    if (!response.ok) {
      response = await tzktFetch(`${TZKT_FALLBACK_API_BASE}/suggest/accounts/${encoded}`);
    }
    if (!response.ok) throw new Error('Network response was not ok');

    const suggestions = await response.json();
    if (Array.isArray(suggestions) && suggestions.length > 0) {
      renderDropdown(suggestions);
    } else {
      dropdown.innerHTML = '<div class="no-results">No matching Tezos accounts found</div>';
      setTimeout(() => {
        dropdown.style.display = 'none';
      }, 1800);
    }
  } catch (err) {
    console.error('Error fetching address suggestions:', err);
    dropdown.style.display = 'none';
  }
}

function renderDropdown(suggestions) {
  dropdown.innerHTML = '';
  const limited = suggestions.slice(0, 10);

  limited.forEach((suggestion) => {
    const item = document.createElement('div');
    item.className = 'address-item';
    item.dataset.address = suggestion.address;
    item.dataset.alias = suggestion.alias || '';

    const avatar = document.createElement('img');
    avatar.className = 'address-avatar';
    avatar.src = `${TZKT_AVATARS_BASE}/${encodeURIComponent(suggestion.address)}`;
    avatar.onerror = function () {
      const initial = (suggestion.alias || suggestion.address || 'T').charAt(0).toUpperCase();
      this.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='16' fill='%23312e81'/%3E%3Ctext x='50%25' y='54%25' font-family='sans-serif' font-size='14' font-weight='bold' text-anchor='middle' dominant-baseline='middle' fill='%23c7d2fe'%3E${encodeURIComponent(initial)}%3C/text%3E%3C/svg%3E`;
    };

    const info = document.createElement('div');
    info.className = 'address-info';

    if (suggestion.alias) {
      const aliasDiv = document.createElement('div');
      aliasDiv.className = 'address-alias';
      aliasDiv.textContent = suggestion.alias;
      info.appendChild(aliasDiv);
    }

    const addrDiv = document.createElement('div');
    addrDiv.className = 'address-value';
    addrDiv.textContent = suggestion.address;
    info.appendChild(addrDiv);

    item.appendChild(avatar);
    item.appendChild(info);

    item.addEventListener('click', () => {
      selectAddress(suggestion.address, suggestion.alias);
    });

    dropdown.appendChild(item);
  });

  dropdown.style.display = 'block';
}

function selectAddress(address, alias) {
  input.value = address;
  dropdown.style.display = 'none';
  showNotification(`Selected: ${alias || shortenAddress(address)}`);
  go();
}

function focusNextItem() {
  const items = dropdown.querySelectorAll('.address-item');
  const focused = dropdown.querySelector('.address-item.focused');
  if (!focused && items.length > 0) {
    items[0].classList.add('focused');
  } else if (focused) {
    const idx = Array.from(items).indexOf(focused);
    if (idx < items.length - 1) {
      focused.classList.remove('focused');
      items[idx + 1].classList.add('focused');
      items[idx + 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function focusPreviousItem() {
  const items = dropdown.querySelectorAll('.address-item');
  const focused = dropdown.querySelector('.address-item.focused');
  if (focused) {
    const idx = Array.from(items).indexOf(focused);
    if (idx > 0) {
      focused.classList.remove('focused');
      items[idx - 1].classList.add('focused');
      items[idx - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

// ============================================================================
// Controls, Sliders, & URL Hash Sync
// ============================================================================

const resultLimitSlider = document.getElementById('result-limit');
const tezLimitSlider = document.getElementById('tez-limit');
const limitValueLabel = document.getElementById('limit-value');
const limitTezLabel = document.getElementById('limit-tez');
const resultLimitTooltip = document.getElementById('result-limit-tooltip');
const tezLimitTooltip = document.getElementById('tez-limit-tooltip');

function formatLimitLabel(val) {
  return `${Number(val).toLocaleString('en-US')} txes`;
}

function formatTezSliderLabel(val) {
  return `${Number(val).toLocaleString('en-US')} ꜩ`;
}

function syncDustChips(tezVal) {
  document.querySelectorAll('.dust-chip').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.tez) === Number(tezVal));
  });
}

resultLimitSlider.addEventListener('input', function () {
  limitValueLabel.textContent = formatLimitLabel(this.value);
  updateSliderTrack(this);
  updateLocationHash();
  if (currentAddress) {
    const limit = Number(this.value) || 1000;
    const isL2 = isEtherlinkAddress(currentAddress);
    const cacheKey = isL2 ? currentAddress.toLowerCase() : currentAddress;
    const cached = cache.get(cacheKey);
    if (cached) {
      const needXtz = viewConfig.enabledTokens.has('xtz');
      const enabledL2 = L2_ERC20_TOKEN_KEYS.filter((k) => viewConfig.enabledTokens.has(k));
      const needFa = isL2
        ? enabledL2.length > 0
        : L1_FA_TOKEN_KEYS.some((k) => viewConfig.enabledTokens.has(k));
      const xtzReady = !needXtz || cached.exhausted || (cached.limit || 0) >= limit;
      const faTargetPages = getL2FaTargetPages(limit);
      const faReady =
        !needFa ||
        (Boolean(cached.accountInfo?.tokenBalancesFetched) &&
          (isL2
            ? enabledL2.every(
                (k) =>
                  cached.fetchedL2Tokens?.has(k) &&
                  (cached.tokenExhaustedMap?.get(k) || (cached.tokenPagesMap?.get(k) || 0) >= faTargetPages)
              )
            : cached.faExhausted || (cached.faLimit || 0) >= limit));
      if (xtzReady && faReady) {
        currentRawData = needXtz
          ? [...(cached.txData || []).slice(0, limit), ...(cached.specialOps || [])]
          : [];
        currentFaData = needFa
          ? isL2
            ? sliceL2FaTransfersByDepth(cached.faData || [], limit)
            : (cached.faData || []).slice(0, limit)
          : [];
        currentAccountInfo = cached.accountInfo;
        refreshDiagramFromMemory();
      }
    }
  }
});

resultLimitSlider.addEventListener('change', function () {
  if (input.value.trim()) {
    go();
  }
});

tezLimitSlider.addEventListener('input', function () {
  limitTezLabel.textContent = formatTezSliderLabel(this.value);
  updateSliderTrack(this);
  syncDustChips(this.value);
  updateLocationHash();
  if (currentAddress && (currentRawData.length > 0 || currentFaData.length > 0)) {
    refreshDiagramFromMemory();
  }
});

resultLimitSlider.addEventListener('mouseenter', () => {
  if (resultLimitTooltip) resultLimitTooltip.style.display = 'block';
});
resultLimitSlider.addEventListener('mouseleave', () => {
  if (resultLimitTooltip) resultLimitTooltip.style.display = 'none';
});
tezLimitSlider.addEventListener('mouseenter', () => {
  if (tezLimitTooltip) tezLimitTooltip.style.display = 'block';
});
tezLimitSlider.addEventListener('mouseleave', () => {
  if (tezLimitTooltip) tezLimitTooltip.style.display = 'none';
});

document.getElementById('search-button')?.addEventListener('click', () => {
  dropdown.style.display = 'none';
  go();
});

// Sample address chips
document.querySelectorAll('.sample-addr-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const addr = btn.dataset.address;
    if (addr) {
      input.value = addr;
      go();
    }
  });
});

// Quick dust filter chips
document.querySelectorAll('.dust-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const tez = Number(chip.dataset.tez) || 0;
    tezLimitSlider.value = tez;
    limitTezLabel.textContent = formatTezSliderLabel(tez);
    updateSliderTrack(tezLimitSlider);
    syncDustChips(tez);
    updateLocationHash();
    if (currentAddress && (currentRawData.length > 0 || currentFaData.length > 0)) {
      refreshDiagramFromMemory();
    } else if (input.value.trim()) {
      go();
    }
  });
});

// Toolbar controls: Ribbon Scale, Max Nodes, Sort Mode, Search Filter, FA Tokens Switch, Export PNG
document.querySelectorAll('#scale-mode-control .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#scale-mode-control .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    viewConfig.scaleMode = btn.dataset.scale;
    if (currentParsed) renderCurrentSankey();
  });
});

document.querySelectorAll('#max-nodes-control .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#max-nodes-control .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    viewConfig.maxNodes = Number(btn.dataset.max) || 50;
    if (currentParsed) renderCurrentSankey();
  });
});

document.querySelectorAll('#sort-mode-control .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#sort-mode-control .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    viewConfig.sortMode = btn.dataset.sort;
    if (currentParsed) renderCurrentSankey();
  });
});

document.querySelectorAll('#circular-mode-control .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#circular-mode-control .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    viewConfig.circularFlows = btn.dataset.circular === 'on';
    if (currentParsed) {
      renderCurrentSankey();
      const biCount = currentParsed.inflows.filter((i) => i.isBidirectional).length;
      const selfCount = currentParsed.outflows.filter((o) => o.isSelfTransfer).length;
      const totalLoops = biCount + selfCount;
      if (viewConfig.circularFlows) {
        showNotification(
          totalLoops > 0
            ? `Circular Flows (↺): Looping ${totalLoops} counterparty flow${totalLoops > 1 ? 's' : ''} (${biCount} return, ${selfCount} self)`
            : 'Circular Flows (↺) enabled (0 circular or self-transfer flows here)'
        );
      } else {
        showNotification('Split Flows (⇄): Showing inflows on left and outflows on right');
      }
    }
  });
});

// Individual Token Pills & Group Label Shortcuts (Native XTZ | FA: tzBTC, USDt | Etherlink: USDT, USDC, WXTZ, WETH, LBTC, xU3O8)
const faTokensControl = document.getElementById('fa-tokens-control');

function syncTokenControlsUI() {
  viewConfig.faEnabled = FA_TOKEN_KEYS.some((k) => viewConfig.enabledTokens.has(k));
  if (faTokensControl) {
    faTokensControl.classList.toggle('fa-active', viewConfig.faEnabled);
  }
  document.querySelectorAll('#fa-token-pills .token-pill').forEach((pill) => {
    const tk = pill.dataset.token;
    pill.classList.toggle('active', viewConfig.enabledTokens.has(tk));
  });
}

function getL2FaTargetPages(requestedLimit) {
  const numLimit = Number(requestedLimit) || 1000;
  return numLimit < 1000
    ? Math.max(1, Math.ceil(numLimit / 100))
    : Math.min(35, Math.max(15, Math.ceil(numLimit / 100)));
}

function sliceL2FaTransfersByDepth(faList, requestedLimit) {
  if (!Array.isArray(faList) || faList.length === 0) return [];
  const numLimit = Number(requestedLimit) || 1000;
  // At the default 1,000 depth setting, allow up to 1,500 transfers per token so complete ~1.3k-tx histories stay intact
  const perTokenCap = numLimit === 1000 ? 1500 : numLimit;
  const countsByContract = new Map();
  const out = [];
  for (let i = 0; i < faList.length; i++) {
    const item = faList[i];
    const cAddr = item['token.contract.address'] || '';
    const cur = countsByContract.get(cAddr) || 0;
    if (cur < perTokenCap) {
      countsByContract.set(cAddr, cur + 1);
      out.push(item);
    }
  }
  return out;
}

async function onTokenSelectionChanged() {
  const addr = currentAddress || input.value.trim();
  if (!addr) return;
  const limit = Number(resultLimitSlider.value) || 10000;
  const isL2 = isEtherlinkAddress(addr);
  const cacheKey = isL2 ? addr.toLowerCase() : addr;
  const cached = cache.get(cacheKey);
  const needXtz = viewConfig.enabledTokens.has('xtz');
  const enabledL2 = L2_ERC20_TOKEN_KEYS.filter((k) => viewConfig.enabledTokens.has(k));
  const needFa = isL2
    ? enabledL2.length > 0
    : L1_FA_TOKEN_KEYS.some((k) => viewConfig.enabledTokens.has(k));
  const faTargetPages = getL2FaTargetPages(limit);

  const missingXtz =
    needXtz &&
    (!cached || (!cached.exhausted && (cached.limit || 0) < limit) || !cached.specialOpsFetched);
  const missingFa =
    needFa &&
    (!cached ||
      !cached.accountInfo?.tokenBalancesFetched ||
      (isL2
        ? enabledL2.some(
            (k) =>
              !cached.fetchedL2Tokens?.has(k) ||
              (!cached.tokenExhaustedMap?.get(k) && (cached.tokenPagesMap?.get(k) || 0) < faTargetPages)
          )
        : !cached.faExhausted && (cached.faLimit || 0) < limit));

  if (missingXtz || missingFa) {
    await generateDataAndDrawDiagram(addr, limit);
  } else if (currentAddress) {
    if (cached) {
      currentRawData = needXtz
        ? [...(cached.txData || []).slice(0, limit), ...(cached.specialOps || [])]
        : [];
      currentFaData = needFa
        ? isL2
          ? sliceL2FaTransfersByDepth(cached.faData || [], limit)
          : (cached.faData || []).slice(0, limit)
        : [];
      currentAccountInfo = cached.accountInfo;
    }
    refreshDiagramFromMemory();
  }
}

document.querySelectorAll('#fa-token-pills .token-group-label[data-group-toggle]').forEach((labelEl) => {
  labelEl.addEventListener('click', () => {
    const grp = labelEl.dataset.groupToggle;
    const keys = grp === 'fa' ? L1_FA_TOKEN_KEYS : grp === 'etherlink' ? L2_ERC20_TOKEN_KEYS : [];
    if (keys.length === 0) return;

    const allEnabled = keys.every((k) => viewConfig.enabledTokens.has(k));
    if (allEnabled) {
      keys.forEach((k) => viewConfig.enabledTokens.delete(k));
      if (viewConfig.enabledTokens.size === 0) {
        viewConfig.enabledTokens.add('xtz');
      }
    } else {
      keys.forEach((k) => viewConfig.enabledTokens.add(k));
    }

    syncTokenControlsUI();
    updateLocationHash();
    const activeLabels = ALL_TOKEN_ORDER.filter((k) => viewConfig.enabledTokens.has(k))
      .map((k) => TOKEN_DEFINITIONS[k]?.ticker || k)
      .join(' + ');
    showNotification(`Active token flows: ${activeLabels}`);
    onTokenSelectionChanged();
  });
});

document.querySelectorAll('#fa-token-pills .token-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    const tk = pill.dataset.token;
    if (!tk) return;

    if (viewConfig.enabledTokens.has(tk)) {
      if (viewConfig.enabledTokens.size <= 1) {
        showNotification('At least one token flow must remain enabled');
        return;
      }
      viewConfig.enabledTokens.delete(tk);
    } else {
      viewConfig.enabledTokens.add(tk);
    }

    syncTokenControlsUI();
    updateLocationHash();
    const activeLabels = ALL_TOKEN_ORDER.filter((k) => viewConfig.enabledTokens.has(k))
      .map((k) => TOKEN_DEFINITIONS[k]?.ticker || k)
      .join(' + ');
    showNotification(`Active token flows: ${activeLabels}`);
    onTokenSelectionChanged();
  });
});

let searchRafId = null;
document.getElementById('node-search')?.addEventListener('input', function () {
  viewConfig.searchQuery = this.value.trim().toLowerCase();
  if (!currentParsed) return;
  if (searchRafId) cancelAnimationFrame(searchRafId);
  searchRafId = requestAnimationFrame(() => {
    searchRafId = null;
    renderCurrentSankey();
  });
});

document.getElementById('export-png-btn')?.addEventListener('click', () => {
  exportDiagramAsPng();
});

// Update URL hash in backwards-compatible format: #address,resultLimit,tezLimit[,tokens]
function updateLocationHash() {
  const tezosAddress = input.value.trim();
  const resultLimitValue = resultLimitSlider.value;
  const tezLimitValue = tezLimitSlider.value;
  if (tezosAddress) {
    const isDefaultXtzOnly =
      !viewConfig.faEnabled && viewConfig.enabledTokens.size === 1 && viewConfig.enabledTokens.has('xtz');
    const tokenPart = isDefaultXtzOnly ? '' : `,${[...viewConfig.enabledTokens].join('+')}`;
    const newHash = `${tezosAddress},${resultLimitValue},${tezLimitValue}${tokenPart}`;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', `#${newHash}`);
    } else {
      location.hash = newHash;
    }
  }
}

function applyHashFromUrl() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const [address, resultLimitValue, tezLimitValue, tokensParam] = hash.split(',');
  let cleanAddr = '';
  if (address) {
    try {
      cleanAddr = decodeURIComponent(address.trim());
    } catch (_) {
      cleanAddr = address.trim();
    }
  }
  if (cleanAddr) {
    input.value = cleanAddr;
  }
  if (resultLimitValue && !isNaN(Number(resultLimitValue))) {
    resultLimitSlider.value = resultLimitValue;
    limitValueLabel.textContent = formatLimitLabel(resultLimitValue);
    updateSliderTrack(resultLimitSlider);
  }
  if (tezLimitValue && !isNaN(Number(tezLimitValue))) {
    tezLimitSlider.value = tezLimitValue;
    limitTezLabel.textContent = formatTezSliderLabel(tezLimitValue);
    updateSliderTrack(tezLimitSlider);
    syncDustChips(tezLimitValue);
  }
  if (tokensParam) {
    const isL2 = isEtherlinkAddress(cleanAddr);
    const parsedTokens = tokensParam
      .toLowerCase()
      .split('+')
      .map((k) => (k === 'usdt' && isL2 ? 'usdt_l2' : k))
      .filter((k) => Boolean(TOKEN_DEFINITIONS[k]));
    if (parsedTokens.length > 0) {
      viewConfig.enabledTokens = new Set(parsedTokens);
      syncTokenControlsUI();
    }
  }
  if (cleanAddr && cleanAddr !== currentAddress) {
    go();
  }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  updateSliderTrack(resultLimitSlider);
  updateSliderTrack(tezLimitSlider);
  syncTokenControlsUI();
  updateNavigationButtons();
  applyHashFromUrl();
});

window.addEventListener('hashchange', () => {
  applyHashFromUrl();
});

window.addEventListener('resize', () => {
  if (currentParsed) {
    renderCurrentSankey();
  }
});

// ============================================================================
// TzKT Data Fetching & Smart Session Caching
// ============================================================================

async function fetchAccountTokenBalances(tezosAddress) {
  const tokenBalances = createEmptyTokenBalances();
  try {
    const balRes = await tzktFetch(
      `${TZKT_API_BASE}/tokens/balances?account=${encodeURIComponent(tezosAddress)}&token.contract.in=${FA_CONTRACT_LIST}&balance.gt=0&select=token.contract.address,balance`
    );
    if (balRes.ok) {
      const balList = await balRes.json();
      if (Array.isArray(balList)) {
        balList.forEach((item) => {
          const contractAddr = item['token.contract.address'] || item.token?.contract?.address;
          const tk = CONTRACT_TO_TOKEN_KEY.get(contractAddr);
          if (tk && TOKEN_DEFINITIONS[tk]) {
            const rawBal = parseFloat(item.balance || '0');
            tokenBalances[tk] = rawBal / Math.pow(10, TOKEN_DEFINITIONS[tk].decimals);
          }
        });
      }
    }
  } catch {
    // Ignore balance fetch errors
  }
  return tokenBalances;
}

async function fetchAccountMetadata(tezosAddress, needFa = false) {
  try {
    const enc = encodeURIComponent(tezosAddress);
    const accPromise = tzktFetch(
      `${TZKT_API_BASE}/accounts?address=${enc}&select=alias,balance,numActivations,numOriginations,numMigrations,numTransactions,tokenBalancesCount,tokenTransfersCount`
    ).then((r) => (r.ok ? r.json() : null));

    const balPromise = needFa ? fetchAccountTokenBalances(tezosAddress) : Promise.resolve(null);
    const [accData, fetchedBalances] = await Promise.all([accPromise, balPromise]);
    const info = (Array.isArray(accData) ? accData[0] : accData) || {};

    const tokenBalances = fetchedBalances || createEmptyTokenBalances();
    const tokenBalancesFetched = Boolean(needFa || info.tokenBalancesCount === 0);

    return { ...info, tokenBalances, tokenBalancesFetched };
  } catch {
    return null;
  }
}

async function fetchSpecialAccountOps(tezosAddress, accountPromise) {
  try {
    const info = accountPromise ? await accountPromise : null;
    const enc = encodeURIComponent(tezosAddress);
    const requests = [];

    const hasActivations = info ? Number(info.numActivations) > 0 : tezosAddress.startsWith('tz1');
    const hasOriginations = info ? Number(info.numOriginations) > 0 : true;
    const hasMigrations = info ? Number(info.numMigrations) > 0 : true;

    if (hasActivations) {
      requests.push(
        tzktFetch(
          `${TZKT_API_BASE}/operations/activations?account=${enc}&select=hash,timestamp,account,balance&limit=1`
        )
          .then((r) => (r.ok ? r.json() : []))
          .then((rows) => (Array.isArray(rows) ? rows.map((op) => ({ ...op, type: 'activation' })) : []))
          .catch(() => [])
      );
    }

    if (hasOriginations) {
      requests.push(
        tzktFetch(
          `${TZKT_API_BASE}/operations/originations?anyof.sender.originatedContract=${enc}&status=applied&contractBalance.gt=0&select=hash,timestamp,contractBalance,sender,originatedContract&limit=100`
        )
          .then((r) => (r.ok ? r.json() : []))
          .then((rows) => (Array.isArray(rows) ? rows.map((op) => ({ ...op, type: 'origination' })) : []))
          .catch(() => [])
      );
    }

    if (hasMigrations) {
      if (tezosAddress === 'KT1TxqZ8QtKvLu3V3JH7Gx58n7Co8pgtpQU5') {
        // Tezos Liquidity Baking Protocol Subsidy (Granada block 1,589,248 on 2021-08-06 through Tallinn block 13,464,748 on 2026-06-02):
        // 11,829,743 subsidy blocks across 6 block-time eras (2.5 -> 1.25 -> 1.249999 -> 0.833333 -> 0.666666 -> 0.5 XTZ/block)
        // totaling 12,430,149.55728 XTZ (12,430,149,557,280 mutez).
        const knownSubsidyBlocks = 11829743;
        const totalMigs = Number(info?.numMigrations) || knownSubsidyBlocks + 1;
        const extraBlocks = Math.max(0, totalMigs - (knownSubsidyBlocks + 1));
        const totalSubsidyMutez = 12430149557280 + extraBlocks * 500000;
        requests.push(
          Promise.resolve([
            {
              type: 'migration',
              kind: 'subsidy',
              startTimestamp: '2021-08-06T09:36:46Z',
              timestamp: '2026-06-02T07:08:07Z',
              account: {
                address: 'KT1TxqZ8QtKvLu3V3JH7Gx58n7Co8pgtpQU5',
                alias: info?.alias || 'Sirius DEX'
              },
              balanceChange: totalSubsidyMutez,
              count: knownSubsidyBlocks + extraBlocks
            }
          ])
        );
      } else {
        requests.push(
          tzktFetch(
            `${TZKT_API_BASE}/operations/migrations?account=${enc}&kind.in=bootstrap,subsidy&balanceChange.gt=0&select=hash,timestamp,account,kind,balanceChange&limit=100`
          )
            .then((r) => (r.ok ? r.json() : []))
            .then((rows) => (Array.isArray(rows) ? rows.map((op) => ({ ...op, type: 'migration' })) : []))
            .catch(() => [])
        );
      }
    }

    if (requests.length === 0) return [];
    const results = await Promise.all(requests);
    return results.flat();
  } catch {
    return [];
  }
}

async function fetchOperationsBatch(tezosAddress, lastId = 0, batchLimit = 10000, offset = 0) {
  const clampLimit = Math.min(10000, Math.max(1, Number(batchLimit) || 10000));
  const selectFields =
    tezosAddress === ETHERLINK_BRIDGE_CONTRACT || tezosAddress === ETHERLINK_WITHDRAW_CONTRACT
      ? 'id,hash,timestamp,amount,sender,target,parameter'
      : 'id,hash,timestamp,amount,sender,target';
  const baseUrl = `${TZKT_API_BASE}/operations/transactions?anyof.sender.target=${encodeURIComponent(tezosAddress)}&status=applied&amount.gt=0&sort.desc=id&select=${selectFields}&limit=${clampLimit}`;
  let url = baseUrl;
  if (lastId > 0) {
    url += offset > 0 ? `&id.lt=${lastId}&offset=${offset}` : `&offset.cr=${lastId}`;
  } else if (offset > 0) {
    url += `&offset=${offset}`;
  }

  try {
    const response = await tzktFetch(url);
    if (!response.ok) {
      const errType =
        response.status >= 500
          ? '5xx Server Error'
          : response.status === 429
          ? '429 Rate Limit'
          : '4xx Client Error';
      console.error(`TzKT ${errType} (HTTP ${response.status}) fetching operations batch`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error('Network error fetching operations batch:', err);
    return null;
  }
}

async function enrichBridgeDepositParameters(txData) {
  if (!Array.isArray(txData) || txData.length === 0) return;

  // Propagate parameter across sibling operations sharing the same hash (e.g., when viewing KT1BGwyCrnJ6HuEYP7X8Q2UooTdxmEYHiK6j directly)
  const paramByHash = new Map();
  txData.forEach((op) => {
    if (op && op.hash && op.parameter) {
      paramByHash.set(op.hash, op.parameter);
    }
  });
  txData.forEach((op) => {
    if (op && op.hash && op.parameter === undefined && paramByHash.has(op.hash)) {
      op.parameter = paramByHash.get(op.hash);
    }
  });

  const pendingOps = txData.filter((op) => {
    if (!op || !op.id || op.parameter !== undefined) return false;
    const isBridgeOp =
      op.target?.address === ETHERLINK_BRIDGE_CONTRACT ||
      op.sender?.address === ETHERLINK_WITHDRAW_CONTRACT ||
      op.target?.address === ETHERLINK_WITHDRAW_CONTRACT;
    if (!isBridgeOp) return false;
    const l1Peer =
      op.target?.address === ETHERLINK_BRIDGE_CONTRACT ? op.sender?.address : op.target?.address;
    return !isRollupInternalParty(l1Peer);
  });
  if (pendingOps.length === 0) return;

  const opById = new Map();
  pendingOps.forEach((op) => {
    op.parameter = null;
    const idNum = Number(op.id);
    if (op.sender?.address === ETHERLINK_WITHDRAW_CONTRACT) {
      // Internal XTZ payout from KT1BGwyCrnJ6HuEYP7X8Q2UooTdxmEYHiK6j is nonce=0 (id = parentId + 1048576)
      opById.set(idNum - 1048576, op);
    } else {
      opById.set(idNum, op);
    }
  });

  const ids = Array.from(opById.keys());
  const chunkSize = 80;
  const chunks = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await tzktFetch(
          `${TZKT_API_BASE}/operations/transactions?id.in=${chunk.join(',')}&select=id,parameter&limit=${chunk.length}`
        );
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows)) {
            rows.forEach((row) => {
              const targetOp = opById.get(Number(row.id));
              if (targetOp && row.parameter) {
                targetOp.parameter = row.parameter;
              }
            });
          }
        }
      } catch (err) {
        console.error('Error enriching Etherlink bridge parameters:', err);
      }
    })
  );
}

async function fetchEtherlinkData(rawEvmAddress, requestedLimit) {
  const evmAddress = String(rawEvmAddress || '').trim().toLowerCase();
  const numLimit = Number(requestedLimit) || 10000;
  const needXtz = viewConfig.enabledTokens.has('xtz');
  const enabledL2Keys = L2_ERC20_TOKEN_KEYS.filter((k) => viewConfig.enabledTokens.has(k));
  const needFa = enabledL2Keys.length > 0;

  const xtzTargetPages = Math.min(25, Math.max(1, Math.ceil(numLimit / 200)));
  const faTargetPages = getL2FaTargetPages(numLimit);

  if (cache.has(evmAddress)) {
    const cached = cache.get(evmAddress);
    const xtzReady = !needXtz || cached.exhausted || (cached.limit || 0) >= numLimit;
    const faReady =
      !needFa ||
      (Boolean(cached.accountInfo?.tokenBalancesFetched) &&
        enabledL2Keys.every(
          (k) =>
            cached.fetchedL2Tokens?.has(k) &&
            (cached.tokenExhaustedMap?.get(k) || (cached.tokenPagesMap?.get(k) || 0) >= faTargetPages)
        ));
    if (xtzReady && faReady) {
      return {
        operations: needXtz ? cached.txData.slice(0, numLimit) : [],
        faTransfers: needFa ? sliceL2FaTransfersByDepth(cached.faData || [], numLimit) : [],
        accountInfo: cached.accountInfo,
        apiError: null
      };
    }
  }

  const loaderEl = document.getElementById('loader');
  const loaderStatus = document.getElementById('loader-status');
  const emptyState = document.getElementById('empty-state');
  const diagramEl = document.getElementById('sankey-diagram');
  const statsStrip = document.getElementById('stats-strip');

  if (emptyState) emptyState.style.display = 'none';
  if (diagramEl) diagramEl.style.display = 'none';
  if (statsStrip) statsStrip.style.display = 'none';
  if (loaderEl) loaderEl.style.display = 'flex';
  if (loaderStatus) {
    loaderStatus.textContent = 'Fetching Etherlink L2 transactions from Blockscout…';
  }

  lastBlockscoutApiError = null;
  lastTzktApiError = null;

  const existing = cache.get(evmAddress);
  const enc = encodeURIComponent(evmAddress);
  const fetchedL2Tokens = new Set(existing?.fetchedL2Tokens || []);
  const tokenExhaustedMap = new Map(existing?.tokenExhaustedMap || []);
  const tokenNextQsMap = new Map(existing?.tokenNextQsMap || []);
  const tokenNextParamsMap = new Map(existing?.tokenNextParamsMap || []);
  const tokenMaxBlockMap = new Map(existing?.tokenMaxBlockMap || []);
  const tokenSegmentsMap = new Map(existing?.tokenSegmentsMap || []);
  const tokenPagesMap = new Map(existing?.tokenPagesMap || []);
  const tokenItemsMap = new Map(existing?.tokenItemsMap || []);

  const missingL2Keys = enabledL2Keys.filter(
    (k) => !fetchedL2Tokens.has(k) || (!tokenExhaustedMap.get(k) && (tokenPagesMap.get(k) || 0) < faTargetPages)
  );

  const aliasLookup = new Map([
    [ETHERLINK_ZERO_ADDRESS, 'Zero / Mint & Burn Address (0x0)'],
    [ETHERLINK_L2_FEED_ADDRESS, 'Etherlink L1 Deposit'],
    [ETHERLINK_L2_WITHDRAW_PRECOMPILE, 'Etherlink L1 Withdraw'],
    [ETHERLINK_LZ_BRIDGE_CONTRACT, 'LayerZero Bridge'],
    [ETHERLINK_LZ_ULN_CONTRACT, 'LayerZero UltraLightNodeV2'],
    [ETHERLINK_LBTC_BRIDGE_OFFRAMP, 'LayerZero / Lombard Bridge OffRamp'],
    [ETHERLINK_LBTC_BRIDGE_ROUTER, 'LayerZero / Lombard Bridge Router'],
    [ETHERLINK_LBTC_TOKEN_POOL, 'Lombard LBTC Bridge Pool'],
    [ETHERLINK_KYBERSWAP_ROUTER, 'KyberSwap MetaAggregationRouterV2'],
    [ETHERLINK_KYBERSWAP_EXECUTOR_1, 'KyberSwap AggregationExecutor'],
    [ETHERLINK_KYBERSWAP_EXECUTOR_2, 'KyberSwap AggregationExecutor'],
    [ETHERLINK_KYBERSWAP_EXECUTOR_3, 'KyberSwap AggregationExecutor'],
    [ETHERLINK_WXTZ_CONTRACT, 'Wrapped XTZ (WXTZ)'],
    [ETHERLINK_USDC_CONTRACT, 'LayerZero Bridged USDC'],
    [ETHERLINK_USDT_CONTRACT, 'Tether USD (USDT)'],
    [ETHERLINK_WETH_CONTRACT, 'Bridged WETH'],
    [ETHERLINK_LBTC_CONTRACT, 'Lombard Staked Bitcoin (LBTC)'],
    [ETHERLINK_WBTC_CONTRACT, 'Wrapped BTC (WBTC)'],
    [ETHERLINK_XU3O8_CONTRACT, 'Uranium (xU3O8)'],
    ['0x65fe928c5d04a2da42347ba9d4d1c3f4952851f5', 'Superlend XTZ Gateway (WrappedTokenGatewayV3)']
  ]);

  function rememberPartyAlias(partyObj) {
    const hash = String(partyObj?.hash || '').toLowerCase();
    if (!hash) return;
    const name =
      partyObj?.name ||
      partyObj?.ens_domain_name ||
      partyObj?.metadata?.tags?.[0]?.name ||
      '';
    if (name && !aliasLookup.has(hash)) {
      aliasLookup.set(hash, name);
    }
  }

  function makeParty(rawAddr, fallbackName = '') {
    const addr = String(rawAddr || '').toLowerCase();
    if (!addr) return { address: '', alias: '' };
    if (ETHERLINK_KYBERSWAP_EXECUTOR_SET.has(addr) && !ETHERLINK_KYBERSWAP_EXECUTOR_SET.has(evmAddress)) {
      return {
        address: ETHERLINK_KYBERSWAP_ROUTER,
        alias: 'KyberSwap MetaAggregationRouterV2'
      };
    }
    return {
      address: addr,
      alias: aliasLookup.get(addr) || fallbackName || ''
    };
  }

  function buildV2NextQuery(nextPageParams, extraParams = {}) {
    if (!nextPageParams || typeof nextPageParams !== 'object') return '';
    const parts = [];
    Object.entries({ ...extraParams, ...nextPageParams, items_count: 100 }).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    });
    return parts.length > 0 ? `?${parts.join('&')}` : '';
  }

  function buildSyntheticV2BlockQuery(blockNumber, isInternal = false, extraParams = {}) {
    const params = {
      ...extraParams,
      block_number: blockNumber,
      index: 999999,
      items_count: 100
    };
    if (isInternal) {
      params.transaction_index = 999999;
    }
    return buildV2NextQuery(params);
  }

  function getV2ItemUniqueKey(item, kind) {
    if (!item) return '';
    if (kind === 'internal') {
      return `${item.transaction_hash || ''}:${item.block_number || 0}:${item.transaction_index ?? ''}:${item.index ?? ''}`;
    }
    if (kind === 'token') {
      return `${item.transaction_hash || ''}:${item.block_number || 0}:${item.log_index ?? item.index ?? ''}`;
    }
    return `${item.hash || ''}:${item.block_number || 0}`;
  }

  // Parallel Block-Cursor Wave Paginator for Blockscout v2 endpoints
  async function fetchV2PaginatedParallel(endpointPath, targetPages, opts = {}) {
    const {
      kind = 'tx',
      extraParams = {},
      priorItems = [],
      priorPages = 0,
      priorExhausted = false,
      priorNextQs = null,
      priorNextParams = null,
      priorMaxBlock = 0,
      priorSegments = []
    } = opts;

    if (priorExhausted) {
      return {
        items: priorItems,
        exhausted: true,
        hadError: false,
        nextQs: null,
        nextParams: null,
        lastMaxBlock: priorMaxBlock,
        prefetchedSegments: [],
        pagesFetched: priorPages
      };
    }

    const isInternal = kind === 'internal';
    const allItems = [...priorItems];
    const seenKeys = new Set(allItems.map((it) => getV2ItemUniqueKey(it, kind)).filter(Boolean));
    let pagesFetched = priorPages;
    let exhausted = false;
    let hadError = false;
    let nextParams = priorNextParams || null;
    let lastMaxBlock = priorMaxBlock || 0;
    const prefetchedSegments = Array.isArray(priorSegments) ? [...priorSegments] : [];
    const defaultInitQs =
      Object.keys(extraParams).length > 0 ? buildV2NextQuery(extraParams) : '?items_count=100';
    let nextQs = priorPages > 0 && priorNextQs ? priorNextQs : defaultInitQs;

    function appendItemsDedup(items) {
      if (!Array.isArray(items)) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const k = getV2ItemUniqueKey(it, kind);
        if (!k || !seenKeys.has(k)) {
          if (k) seenKeys.add(k);
          allItems.push(it);
        }
      }
    }

    async function fetchSinglePage(qs) {
      try {
        const res = await blockscoutFetch(`${ETHERLINK_API_BASE}${endpointPath}${qs}`);
        if (!res.ok) {
          const errType =
            res.status >= 500
              ? '5xx Server Error'
              : res.status === 429
              ? '429 Rate Limit'
              : '4xx Client Error';
          console.error(`Blockscout ${errType} (HTTP ${res.status}) fetching ${endpointPath}`);
          return { ok: false, status: res.status };
        }
        const json = await res.json();
        const items = Array.isArray(json?.items) ? json.items : [];
        const np = json?.next_page_params || null;
        const nqs = buildV2NextQuery(np, extraParams);
        let maxBlock = 0;
        let minBlock = Infinity;
        for (let i = 0; i < items.length; i++) {
          const b = Number(items[i]?.block_number || 0);
          if (b > maxBlock) maxBlock = b;
          if (b > 0 && b < minBlock) minBlock = b;
        }
        if (np?.block_number) {
          const nb = Number(np.block_number);
          if (nb > 0 && nb < minBlock) minBlock = nb;
          if (nb > maxBlock) maxBlock = nb;
        }
        return {
          ok: true,
          items,
          nextParams: np,
          nextQs: nqs,
          maxBlock,
          minBlock: Number.isFinite(minBlock) ? minBlock : 0
        };
      } catch (err) {
        console.error(`Network error fetching Blockscout ${endpointPath}:`, err);
        return { ok: false, status: 0 };
      }
    }

    function absorbContiguousPrefetchedSegments() {
      if (prefetchedSegments.length === 0 || exhausted) return;
      prefetchedSegments.sort((a, b) => b.startBlock - a.startBlock);

      while (prefetchedSegments.length > 0 && !exhausted) {
        const frontierBlock = Number(nextParams?.block_number || 0);
        if (!(frontierBlock > 0)) break;

        const seg = prefetchedSegments[0];
        if (seg.startBlock < frontierBlock) {
          // A block gap (seg.startBlock, frontierBlock) still remains above this segment
          break;
        }

        // seg.startBlock >= frontierBlock: zero gap between contiguous history and seg!
        prefetchedSegments.shift();
        appendItemsDedup(seg.items);

        const segNextBlock = Number(seg.nextParams?.block_number || 0);
        const extendsDeeper =
          !seg.nextQs ||
          segNextBlock < frontierBlock ||
          (segNextBlock === frontierBlock &&
            Number(seg.nextParams?.index ?? 0) < Number(nextParams?.index ?? 0));

        if (extendsDeeper) {
          lastMaxBlock = seg.maxBlock || frontierBlock;
          nextParams = seg.nextParams;
          nextQs = seg.nextQs;
          if (!nextQs) {
            exhausted = true;
            prefetchedSegments.length = 0;
            pagesFetched = Math.max(pagesFetched + 1, Math.ceil(allItems.length / 100));
            break;
          }
          pagesFetched = Math.floor(allItems.length / 100);
        }
      }
    }

    // Step 1: Fetch Page 1 first if starting fresh (avoids wasted speculative calls on wallets with <= 100 items)
    if (pagesFetched === 0 && targetPages > 0) {
      const p1 = await fetchSinglePage(nextQs);
      if (!p1.ok) {
        hadError = true;
        return {
          items: allItems,
          exhausted: false,
          hadError: true,
          nextQs,
          nextParams,
          lastMaxBlock,
          prefetchedSegments,
          pagesFetched
        };
      }
      appendItemsDedup(p1.items);
      pagesFetched = 1;
      lastMaxBlock = p1.maxBlock;
      nextParams = p1.nextParams;
      nextQs = p1.nextQs;
      if (!nextQs) {
        exhausted = true;
      }
    }

    // Step 2: Parallel Overlapping Block-Cursor Waves for multi-page histories
    while (pagesFetched < targetPages && !exhausted && !hadError && nextQs) {
      absorbContiguousPrefetchedSegments();
      if (pagesFetched >= targetPages || exhausted || !nextQs) break;

      const remainingItemsNeeded = Math.max(100, targetPages * 100 - allItems.length);
      const remainingPages = Math.max(1, Math.ceil(remainingItemsNeeded / 85));
      const cursorBlock = Number(nextParams?.block_number || 0);
      const rawDelta = lastMaxBlock > cursorBlock ? lastMaxBlock - cursorBlock : 0;
      const waveSize =
        remainingPages > 1 && cursorBlock > 10 && rawDelta > 0
          ? Math.min(4, remainingPages)
          : 1;

      const waveSpecs = [{ isExact: true, qs: nextQs, startBlock: cursorBlock }];
      if (waveSize > 1) {
        const existingSegBlocks = new Set(prefetchedSegments.map((s) => s.startBlock));
        const stepBlock = Math.max(1, Math.floor(rawDelta * 0.85));
        for (let w = 1; w < waveSize; w++) {
          const specBlock = Math.max(1, cursorBlock - w * stepBlock);
          if (specBlock > 1 && specBlock < cursorBlock && !existingSegBlocks.has(specBlock)) {
            existingSegBlocks.add(specBlock);
            waveSpecs.push({
              isExact: false,
              qs: buildSyntheticV2BlockQuery(specBlock, isInternal, extraParams),
              startBlock: specBlock
            });
          }
        }
      }

      const waveResults = await Promise.all(
        waveSpecs.map((spec) => fetchSinglePage(spec.qs).then((res) => ({ spec, res })))
      );

      const exactOut = waveResults[0].res;
      if (!exactOut.ok) {
        hadError = true;
        break;
      }

      appendItemsDedup(exactOut.items);
      lastMaxBlock = exactOut.maxBlock || cursorBlock;
      nextParams = exactOut.nextParams;
      nextQs = exactOut.nextQs;
      if (!nextQs) {
        exhausted = true;
        pagesFetched = Math.max(pagesFetched + 1, Math.ceil(allItems.length / 100));
      } else {
        pagesFetched = Math.floor(allItems.length / 100);
      }

      for (let w = 1; w < waveResults.length; w++) {
        const { spec, res } = waveResults[w];
        if (res.ok && (res.items.length > 0 || !res.nextQs)) {
          prefetchedSegments.push({
            startBlock: spec.startBlock,
            maxBlock: res.maxBlock,
            minBlock: res.minBlock,
            items: res.items,
            nextParams: res.nextParams,
            nextQs: res.nextQs
          });
        }
      }

      absorbContiguousPrefetchedSegments();
    }

    return {
      items: allItems,
      exhausted,
      hadError,
      nextQs,
      nextParams,
      lastMaxBlock,
      prefetchedSegments,
      pagesFetched
    };
  }

  async function fetchV2InternalPaginated(encodedAddr, targetPages = 5) {
    if (evmAddress === ETHERLINK_KYBERSWAP_ROUTER) {
      const [routerInt, execInt] = await Promise.all([
        fetchV2PaginatedParallel(`/addresses/${encodedAddr}/internal-transactions`, targetPages, {
          kind: 'internal',
          priorItems: Array.isArray(existing?.rawIntItems) ? existing.rawIntItems : [],
          priorPages: existing?.intPagesFetched || 0,
          priorExhausted: Boolean(existing?.intExhausted),
          priorNextQs: existing?.intNextQs || null,
          priorNextParams: existing?.intNextParams || null,
          priorMaxBlock: existing?.intLastMaxBlock || 0,
          priorSegments: existing?.intPrefetchedSegments || []
        }),
        fetchV2PaginatedParallel(
          `/addresses/${ETHERLINK_KYBERSWAP_EXECUTOR_1}/internal-transactions`,
          Math.min(4, targetPages),
          { kind: 'internal' }
        )
      ]);
      return {
        ...routerInt,
        items: [...(routerInt.items || []), ...(execInt.items || [])],
        hadError: Boolean(routerInt.hadError || execInt.hadError)
      };
    }

    return fetchV2PaginatedParallel(`/addresses/${encodedAddr}/internal-transactions`, targetPages, {
      kind: 'internal',
      priorItems: Array.isArray(existing?.rawIntItems) ? existing.rawIntItems : [],
      priorPages: existing?.intPagesFetched || 0,
      priorExhausted: Boolean(existing?.intExhausted),
      priorNextQs: existing?.intNextQs || null,
      priorNextParams: existing?.intNextParams || null,
      priorMaxBlock: existing?.intLastMaxBlock || 0,
      priorSegments: existing?.intPrefetchedSegments || []
    });
  }

  async function fetchV2TransactionsPaginated(encodedAddr, targetPages = 5) {
    return fetchV2PaginatedParallel(`/addresses/${encodedAddr}/transactions`, targetPages, {
      kind: 'tx',
      priorItems: Array.isArray(existing?.rawTopItems) ? existing.rawTopItems : [],
      priorPages: existing?.topPagesFetched || 0,
      priorExhausted: Boolean(existing?.topExhausted),
      priorNextQs: existing?.topNextQs || null,
      priorNextParams: existing?.topNextParams || null,
      priorMaxBlock: existing?.topLastMaxBlock || 0,
      priorSegments: existing?.topPrefetchedSegments || []
    });
  }

  async function fetchZeroAddressTransfersForTokens(tokenContracts, pagesPerToken = 2) {
    let anyError = false;
    const lists = await Promise.all(
      tokenContracts.map(async (tokAddr) => {
        const items = [];
        let qs = '?items_count=100';
        for (let p = 0; p < pagesPerToken; p++) {
          try {
            const r = await blockscoutFetch(`${ETHERLINK_API_BASE}/tokens/${tokAddr}/transfers${qs}`);
            if (!r.ok) {
              anyError = true;
              break;
            }
            const j = await r.json();
            if (Array.isArray(j?.items)) {
              j.items.forEach((tr) => {
                const fHash = String(tr.from?.hash || '').toLowerCase();
                const tHash = String(tr.to?.hash || '').toLowerCase();
                if (
                  fHash === ETHERLINK_ZERO_ADDRESS ||
                  tHash === ETHERLINK_ZERO_ADDRESS ||
                  tr.type === 'token_minting' ||
                  tr.type === 'token_burning'
                ) {
                  items.push(tr);
                }
              });
            }
            const next = buildV2NextQuery(j?.next_page_params);
            if (!next) break;
            qs = next;
          } catch (_) {
            anyError = true;
            break;
          }
        }
        return items;
      })
    );
    return { items: lists.flat(), hadError: anyError };
  }

  let unfilteredFaShortCircuit = Boolean(existing?.unfilteredFaComplete);
  let unfilteredAttempted = Boolean(existing?.unfilteredTried);

  async function fetchV2TokenTransfersSmart(encodedAddr, targetTokenKeys, maxPagesPerToken = 15) {
    // 1. Special case: 0x0000000000000000000000000000000000000000 times out on /addresses/0x0/token-transfers
    if (evmAddress === ETHERLINK_ZERO_ADDRESS) {
      const targetContracts = targetTokenKeys.map((k) => TOKEN_DEFINITIONS[k]?.l2Contract).filter(Boolean);
      const zeroRes = await fetchZeroAddressTransfersForTokens(targetContracts, 2);
      if (!zeroRes.hadError) {
        targetTokenKeys.forEach((k) => {
          fetchedL2Tokens.add(k);
          tokenExhaustedMap.set(k, true);
        });
      }
      return { items: zeroRes.items, exhausted: !zeroRes.hadError, hadError: zeroRes.hadError };
    }

    // 2. Special case: LayerZero Bridge contract (hydrate direct transfers + LBTC pool transfers + bridged token mint/burns)
    if (evmAddress === ETHERLINK_LZ_BRIDGE_CONTRACT) {
      const bridgedContracts = [
        ETHERLINK_USDC_CONTRACT,
        ETHERLINK_USDT_CONTRACT,
        ETHERLINK_WETH_CONTRACT,
        ETHERLINK_LBTC_CONTRACT,
        ETHERLINK_WBTC_CONTRACT,
        ETHERLINK_WXTZ_CONTRACT
      ];
      let lzError = false;
      const [directRes, lbtcPoolRes, mintBurnRes] = await Promise.all([
        blockscoutFetch(`${ETHERLINK_API_BASE}/addresses/${encodedAddr}/token-transfers?type=ERC-20&items_count=100`)
          .then((r) => {
            if (!r.ok) {
              lzError = true;
              return null;
            }
            return r.json();
          })
          .catch(() => {
            lzError = true;
            return null;
          }),
        blockscoutFetch(`${ETHERLINK_API_BASE}/addresses/${ETHERLINK_LBTC_TOKEN_POOL}/token-transfers?type=ERC-20&items_count=100`)
          .then((r) => {
            if (!r.ok) {
              lzError = true;
              return null;
            }
            return r.json();
          })
          .catch(() => {
            lzError = true;
            return null;
          }),
        fetchZeroAddressTransfersForTokens(bridgedContracts, 2)
      ]);
      const hadErr = lzError || mintBurnRes.hadError;
      if (!hadErr) {
        L2_ERC20_TOKEN_KEYS.forEach((k) => {
          fetchedL2Tokens.add(k);
          tokenExhaustedMap.set(k, true);
        });
      }
      return {
        items: [
          ...(Array.isArray(directRes?.items) ? directRes.items : []),
          ...(Array.isArray(lbtcPoolRes?.items) ? lbtcPoolRes.items : []),
          ...mintBurnRes.items
        ],
        exhausted: !hadErr,
        hadError: hadErr
      };
    }

    // 2b. Special case: KyberSwap MetaAggregationRouterV2 (hydrate router + its 3 AggregationExecutor helper contracts)
    if (evmAddress === ETHERLINK_KYBERSWAP_ROUTER) {
      const routerAndExecutors = [ETHERLINK_KYBERSWAP_ROUTER, ...ETHERLINK_KYBERSWAP_EXECUTORS];
      const pagesPerExec = Math.min(4, Math.max(2, Math.ceil(maxPagesPerToken / 2)));
      const execResults = await Promise.all(
        routerAndExecutors.map((addr, idx) =>
          fetchV2PaginatedParallel(
            `/addresses/${addr}/token-transfers`,
            idx === 0 ? 1 : pagesPerExec,
            {
              kind: 'token',
              extraParams: { type: 'ERC-20' }
            }
          )
        )
      );
      const hadErr = execResults.some((r) => r.hadError);
      if (!hadErr) {
        L2_ERC20_TOKEN_KEYS.forEach((k) => {
          fetchedL2Tokens.add(k);
          tokenPagesMap.set(k, maxPagesPerToken);
          tokenExhaustedMap.set(k, execResults.every((r) => r.exhausted));
        });
      }
      return {
        items: execResults.flatMap((r) => r.items || []),
        exhausted: !hadErr && execResults.every((r) => r.exhausted),
        hadError: hadErr
      };
    }

    // 3. Fast-Path (only when multiple L2 tokens are active): try 1 unfiltered request (?type=ERC-20&items_count=100).
    //    If exhausted (<100 total ERC-20 transfers), 1 request covers all active tokens.
    //    If NOT exhausted, discard the partial page so inactive tokens are never partially loaded.
    const allItems = [];
    if (
      targetTokenKeys.length > 1 &&
      !unfilteredAttempted &&
      evmAddress !== ETHERLINK_WXTZ_CONTRACT &&
      evmAddress !== ETHERLINK_XU3O8_CONTRACT
    ) {
      unfilteredAttempted = true;
      try {
        const res = await blockscoutFetch(
          `${ETHERLINK_API_BASE}/addresses/${encodedAddr}/token-transfers?type=ERC-20&items_count=100`
        );
        if (res.ok) {
          const json = await res.json();
          if (!json?.next_page_params && Array.isArray(json?.items)) {
            unfilteredFaShortCircuit = true;
            L2_ERC20_TOKEN_KEYS.forEach((k) => {
              fetchedL2Tokens.add(k);
              tokenExhaustedMap.set(k, true);
            });
            return { items: json.items, exhausted: true, hadError: false };
          }
        }
      } catch (_) {
        // Proceed to per-token parallel fetch
      }
    }

    // 4. Per-Token Parallel Fetch: paginate all enabled missing token(s) concurrently using parallel block-cursor waves
    let anyTokenError = false;
    const perTokenResults = await Promise.all(
      targetTokenKeys.map(async (tk) => {
        const tokAddr = TOKEN_DEFINITIONS[tk]?.l2Contract || TOKEN_DEFINITIONS[tk]?.contract;
        if (!tokAddr || tokenExhaustedMap.get(tk)) return [];

        const pagRes = await fetchV2PaginatedParallel(
          `/addresses/${encodedAddr}/token-transfers`,
          maxPagesPerToken,
          {
            kind: 'token',
            extraParams: { type: 'ERC-20', token: tokAddr },
            priorItems: tokenItemsMap.get(tk) || [],
            priorPages: tokenPagesMap.get(tk) || 0,
            priorExhausted: Boolean(tokenExhaustedMap.get(tk)),
            priorNextQs: tokenNextQsMap.get(tk) || null,
            priorNextParams: tokenNextParamsMap.get(tk) || null,
            priorMaxBlock: tokenMaxBlockMap.get(tk) || 0,
            priorSegments: tokenSegmentsMap.get(tk) || []
          }
        );

        if (pagRes.hadError) {
          anyTokenError = true;
        }
        if (pagRes.pagesFetched > 0 || !pagRes.hadError) {
          fetchedL2Tokens.add(tk);
        }
        tokenItemsMap.set(tk, pagRes.items);
        tokenPagesMap.set(tk, pagRes.pagesFetched);
        tokenNextQsMap.set(tk, pagRes.nextQs);
        tokenNextParamsMap.set(tk, pagRes.nextParams);
        tokenMaxBlockMap.set(tk, pagRes.lastMaxBlock);
        tokenSegmentsMap.set(tk, pagRes.prefetchedSegments);
        tokenExhaustedMap.set(tk, pagRes.exhausted);
        return pagRes.items;
      })
    );

    perTokenResults.forEach((items) => allItems.push(...items));

    if (evmAddress === ETHERLINK_WXTZ_CONTRACT || evmAddress === ETHERLINK_XU3O8_CONTRACT) {
      const extraRes = await fetchZeroAddressTransfersForTokens([evmAddress], 2);
      if (extraRes.hadError) anyTokenError = true;
      allItems.push(...extraRes.items);
    }

    return {
      items: allItems,
      exhausted: targetTokenKeys.every((k) => tokenExhaustedMap.get(k)),
      hadError: anyTokenError
    };
  }

  const needXtzFetch = needXtz && (!existing?.exhausted && (existing?.limit || 0) < numLimit);
  const needFaFetch = needFa && missingL2Keys.length > 0;
  let addrFetchError = false;
  let tokBalFetchError = false;

  const addrPromise = !existing?.accountInfo
    ? blockscoutFetch(`${ETHERLINK_API_BASE}/addresses/${enc}`)
        .then((r) => {
          if (r.ok) return r.json();
          if (r.status !== 404) addrFetchError = true;
          return {};
        })
        .catch(() => {
          addrFetchError = true;
          return {};
        })
    : Promise.resolve(null);

  const topTxV2Promise = needXtzFetch
    ? fetchV2TransactionsPaginated(enc, xtzTargetPages)
    : Promise.resolve(null);

  const internalV2Promise = needXtzFetch
    ? fetchV2InternalPaginated(enc, xtzTargetPages)
    : Promise.resolve(null);

  const tokensBalPromise =
    needFa && !existing?.accountInfo?.tokenBalancesFetched
      ? blockscoutFetch(`${ETHERLINK_API_BASE}/addresses/${enc}/tokens?type=ERC-20`)
          .then((r) => {
            if (r.ok) return r.json();
            if (r.status !== 404) tokBalFetchError = true;
            return null;
          })
          .catch(() => {
            tokBalFetchError = true;
            return null;
          })
      : Promise.resolve(null);

  const tokenTxPromise = needFaFetch
    ? fetchV2TokenTransfersSmart(enc, missingL2Keys, faTargetPages)
    : Promise.resolve(null);

  const rawHexNoPrefix = evmAddress.replace(/^0x/i, '');
  const isFeedAddress = evmAddress === ETHERLINK_L2_FEED_ADDRESS;
  const isZeroAddress = evmAddress === ETHERLINK_ZERO_ADDRESS;
  const isWithdrawPrecompile = evmAddress === ETHERLINK_L2_WITHDRAW_PRECOMPILE;

  const l1DepositsPromise =
    needXtz && !existing?.l1DepositsChecked
      ? tzktFetch(
          isFeedAddress || isZeroAddress
            ? `${TZKT_API_BASE}/operations/transactions?target=${ETHERLINK_BRIDGE_CONTRACT}&status=applied&amount.gt=0&select=id,hash,timestamp,amount,sender,parameter&sort.desc=id&limit=${Math.min(2000, Math.max(500, numLimit))}`
            : isWithdrawPrecompile
            ? `${TZKT_API_BASE}/operations/transactions?anyof.sender.target=${ETHERLINK_WITHDRAW_CONTRACT}&status=applied&amount.gt=0&select=id,hash,timestamp,amount,sender,target,parameter&sort.desc=id&limit=${Math.min(2000, Math.max(500, numLimit))}`
            : `${TZKT_API_BASE}/operations/transactions?target=${ETHERLINK_BRIDGE_CONTRACT}&parameter.l2_address=${encodeURIComponent(rawHexNoPrefix)}&status=applied&amount.gt=0&select=id,hash,timestamp,amount,sender&sort.desc=id&limit=200`
        )
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [])
      : Promise.resolve(null);

  const [addrJson, topTxV2Result, intV2Result, tokJson, tokenTxJson, l1DepositsRows] = await Promise.all([
    addrPromise,
    topTxV2Promise,
    internalV2Promise,
    tokensBalPromise,
    tokenTxPromise,
    l1DepositsPromise
  ]);

  if (
    Array.isArray(l1DepositsRows) &&
    l1DepositsRows.length > 0 &&
    !isFeedAddress &&
    !isZeroAddress &&
    !isWithdrawPrecompile
  ) {
    let depMap = l2ToL1DepositorsMap.get(evmAddress);
    if (!depMap) {
      depMap = new Map();
      l2ToL1DepositorsMap.set(evmAddress, depMap);
    }
    l1DepositsRows.forEach((op) => {
      const sAddr = op.sender?.address;
      const sAlias = op.sender?.alias || '';
      const amt = parseFloat((op.amount || 0) / 1_000_000);
      if (!sAddr || isRollupInternalParty(sAddr) || !amt || !(amt > 0)) return;
      let rec = depMap.get(sAddr);
      if (!rec) {
        rec = {
          address: sAddr,
          alias: sAlias && sAlias !== sAddr ? sAlias : '',
          amount: 0,
          count: 0,
          txHashes: [],
          txHashSet: new Set()
        };
        depMap.set(sAddr, rec);
      }
      if (op.hash && !rec.txHashSet.has(op.hash)) {
        rec.txHashSet.add(op.hash);
        rec.txHashes.push(op.hash);
        rec.amount += amt;
        rec.count += 1;
      }
    });
  }

  // 1. Build accountInfo
  let accountInfo = existing?.accountInfo || null;
  if (!accountInfo && !addrFetchError) {
    const weiBal = parseFloat(addrJson?.coin_balance || '0');
    const alias =
      aliasLookup.get(evmAddress) ||
      addrJson?.name ||
      addrJson?.ens_domain_name ||
      (addrJson?.token?.name ? `${addrJson.token.name} (${addrJson.token.symbol || ''})` : null);
    if (alias) aliasLookup.set(evmAddress, alias);
    accountInfo = {
      alias: alias || null,
      balance: (weiBal / 1e18) * 1_000_000, // Normalized to mutez for unified formatting
      hasTokens: Boolean(addrJson?.has_tokens),
      hasTokenTransfers: Boolean(addrJson?.has_token_transfers),
      tokenBalances: createEmptyTokenBalances(),
      tokenBalancesFetched: !addrJson?.has_tokens
    };
    if (
      addrJson &&
      addrJson.has_token_transfers === false &&
      evmAddress !== ETHERLINK_ZERO_ADDRESS &&
      evmAddress !== ETHERLINK_LZ_BRIDGE_CONTRACT &&
      evmAddress !== ETHERLINK_WXTZ_CONTRACT &&
      evmAddress !== ETHERLINK_XU3O8_CONTRACT
    ) {
      L2_ERC20_TOKEN_KEYS.forEach((k) => {
        fetchedL2Tokens.add(k);
        tokenExhaustedMap.set(k, true);
      });
      unfilteredFaShortCircuit = true;
    }
  }

  if (tokJson && accountInfo) {
    const items = Array.isArray(tokJson?.items) ? tokJson.items : [];
    items.forEach((item) => {
      const sym = String(item.token?.symbol || '').toLowerCase();
      const cAddr = String(item.token?.address_hash || '').toLowerCase();
      const tk =
        CONTRACT_TO_TOKEN_KEY.get(cAddr) ||
        (sym === 'usdt' || sym === 'usdt0'
          ? 'usdt_l2'
          : sym === 'usdc' || sym === 'usdc.e'
          ? 'usdc'
          : sym === 'wxtz'
          ? 'wxtz'
          : sym === 'weth' || sym === 'weth.e'
          ? 'weth'
          : sym === 'lbtc'
          ? 'lbtc'
          : sym === 'wbtc' || sym === 'wbtc.e'
          ? 'wbtc'
          : sym === 'xu3o8'
          ? 'xu3o8'
          : sym === 'tzbtc'
          ? 'tzbtc'
          : null);
      if (tk && TOKEN_DEFINITIONS[tk]) {
        const dec = Number(item.token?.decimals || TOKEN_DEFINITIONS[tk].decimals || 6);
        const bal = parseFloat(item.value || '0') / Math.pow(10, dec);
        accountInfo.tokenBalances[tk] = bal;
      }
    });
    accountInfo.tokenBalancesFetched = true;
  }

  // Harvest contract/account aliases from v2 top-level & internal txs
  if (Array.isArray(topTxV2Result?.items)) {
    topTxV2Result.items.forEach((tx) => {
      rememberPartyAlias(tx.from);
      rememberPartyAlias(tx.to);
    });
  }
  if (Array.isArray(intV2Result?.items)) {
    intV2Result.items.forEach((itx) => {
      rememberPartyAlias(itx.from);
      rememberPartyAlias(itx.to);
    });
  }

  // 2. Parse Native XTZ Transactions on Etherlink L2 (only when needXtzFetch is true)
  let txData = existing?.txData ? [...existing.txData] : [];
  let topExhausted = Boolean(existing?.topExhausted);
  let intExhausted = Boolean(existing?.intExhausted);
  if (needXtzFetch) {
    txData =
      (isFeedAddress || isZeroAddress || isWithdrawPrecompile) && existing?.txData
        ? [...existing.txData]
        : [];
    const seenKeys = new Set(txData.map((op) => op._dedupKey || op.hash));

    // If viewing 0x0000...feed or 0x0000...0000 directly, hydrate L1 bridge inflows (from KT1Wj8...) and (for 0x0000...feed) L2 outflows
    if ((isFeedAddress || isZeroAddress) && Array.isArray(l1DepositsRows) && l1DepositsRows.length > 0) {
      const hubTargetParty = isFeedAddress
        ? { address: ETHERLINK_L2_FEED_ADDRESS, alias: 'Etherlink L1 Deposit' }
        : { address: ETHERLINK_ZERO_ADDRESS, alias: 'Zero / Mint & Burn Address (0x0)' };
      l1DepositsRows.forEach((op) => {
        const rawAmt = Number(op.amount || 0);
        if (!rawAmt || rawAmt <= 0) return;
        const l1SenderAddr = op.sender?.address || '';
        const l1SenderAlias = op.sender?.alias || '';
        const l2TargetAddr = extractEtherlinkEvmAddress(op.parameter);

        if (l1SenderAddr && !isRollupInternalParty(l1SenderAddr)) {
          const inKey = `${op.hash}:l1-in:${l1SenderAddr}:${hubTargetParty.address}`;
          if (!seenKeys.has(inKey)) {
            seenKeys.add(inKey);
            txData.push({
              _dedupKey: inKey,
              id: Number(op.id || 0),
              hash: op.hash,
              timestamp: op.timestamp,
              amount: rawAmt,
              sender: { address: ETHERLINK_BRIDGE_CONTRACT, alias: 'Etherlink Bridge' },
              target: hubTargetParty,
              l1SubBranch: { address: l1SenderAddr, alias: l1SenderAlias }
            });
          }
        }

        if (isFeedAddress && l2TargetAddr) {
          const outKey = `${op.hash}:l2-out:${ETHERLINK_L2_FEED_ADDRESS}:${l2TargetAddr}`;
          if (!seenKeys.has(outKey)) {
            seenKeys.add(outKey);
            txData.push({
              _dedupKey: outKey,
              id: Number(op.id || 0),
              hash: op.hash,
              timestamp: op.timestamp,
              amount: rawAmt,
              sender: { address: ETHERLINK_L2_FEED_ADDRESS, alias: 'Etherlink L1 Deposit' },
              target: makeParty(l2TargetAddr)
            });
          }
        }
      });
    }

    // If viewing 0xff00...0001 directly, also hydrate L2->L1 withdrawals from TzKT KT1BGwy...
    if (isWithdrawPrecompile && Array.isArray(l1DepositsRows) && l1DepositsRows.length > 0) {
      const paramByHash = new Map();
      l1DepositsRows.forEach((op) => {
        if (op?.hash && op?.parameter) paramByHash.set(op.hash, op.parameter);
      });
      l1DepositsRows.forEach((op) => {
        const rawAmt = Number(op.amount || 0);
        if (!rawAmt || rawAmt <= 0) return;
        const param = op.parameter || paramByHash.get(op.hash);
        const l2Caller = extractEtherlinkEvmAddress(param);
        if (op.target?.address === ETHERLINK_WITHDRAW_CONTRACT && l2Caller) {
          const inKey = `${op.hash}:l2-in:${l2Caller}:${ETHERLINK_L2_WITHDRAW_PRECOMPILE}`;
          if (!seenKeys.has(inKey)) {
            seenKeys.add(inKey);
            txData.push({
              _dedupKey: inKey,
              id: Number(op.id || 0),
              hash: op.hash,
              timestamp: op.timestamp,
              amount: rawAmt,
              sender: makeParty(l2Caller),
              target: { address: ETHERLINK_L2_WITHDRAW_PRECOMPILE, alias: 'Etherlink L1 Withdraw' }
            });
          }
        } else if (
          op.sender?.address === ETHERLINK_WITHDRAW_CONTRACT &&
          op.target?.address &&
          !isRollupInternalParty(op.target.address)
        ) {
          const outKey = `${op.hash}:l1-out:${ETHERLINK_L2_WITHDRAW_PRECOMPILE}:${op.target.address}`;
          if (!seenKeys.has(outKey)) {
            seenKeys.add(outKey);
            txData.push({
              _dedupKey: outKey,
              id: Number(op.id || 0),
              hash: op.hash,
              timestamp: op.timestamp,
              amount: rawAmt,
              sender: { address: ETHERLINK_L2_WITHDRAW_PRECOMPILE, alias: 'Etherlink L1 Withdraw' },
              target: { address: ETHERLINK_WITHDRAW_CONTRACT, alias: 'Etherlink Withdraw' },
              l1WithdrawTarget: op.target.address
            });
          }
        }
      });
    }

    topExhausted = Boolean(topTxV2Result?.exhausted);
    let minTopBlock = Infinity;

    if (Array.isArray(topTxV2Result?.items)) {
      topTxV2Result.items.forEach((tx) => {
        const isOk = tx.status === 'ok' || tx.result === 'success';
        const rawVal = parseFloat(tx.value || '0');
        if (!isOk || !rawVal || rawVal <= 0) return;

        const blk = Number(tx.block_number || 0);
        if (blk > 0 && blk < minTopBlock) minTopBlock = blk;

        const sender = makeParty(tx.from?.hash, tx.from?.name);
        let target = makeParty(tx.to?.hash, tx.to?.name);
        if (!sender.address || !target.address) return;
        if (evmAddress === ETHERLINK_KYBERSWAP_ROUTER && sender.address === target.address) return;

        // Route native XTZ LayerZero messaging fee payments on WXTZ.send() / OFT send (0xc7c7f5b3) to LayerZero Bridge
        const txMethodLower = String(tx.method || '').toLowerCase();
        const txSelector = String(tx.raw_input || '').slice(0, 10).toLowerCase();
        if (
          evmAddress !== ETHERLINK_WXTZ_CONTRACT &&
          evmAddress !== ETHERLINK_LZ_BRIDGE_CONTRACT &&
          (txSelector === '0xc7c7f5b3' ||
            (target.address === ETHERLINK_WXTZ_CONTRACT && ETHERLINK_LZ_BRIDGE_METHODS.has(txMethodLower)))
        ) {
          target = { address: ETHERLINK_LZ_BRIDGE_CONTRACT, alias: 'LayerZero Bridge' };
        }

        const dedupKey = `${tx.hash}:${sender.address}:${target.address}`;
        if (seenKeys.has(dedupKey)) return;
        seenKeys.add(dedupKey);

        const l1WithdrawTarget =
          target.address === ETHERLINK_L2_WITHDRAW_PRECOMPILE
            ? extractTezosL1AddressFromHex(tx.raw_input)
            : null;

        const normAmt = (rawVal / 1e18) * 1_000_000;
        txData.push({
          _dedupKey: dedupKey,
          id: blk,
          hash: tx.hash,
          timestamp: tx.timestamp,
          amount: normAmt,
          sender,
          target,
          l1WithdrawTarget
        });

        if (isWithdrawPrecompile && target.address === ETHERLINK_L2_WITHDRAW_PRECOMPILE && l1WithdrawTarget) {
          const outKey = `${tx.hash}:l1-out:${ETHERLINK_L2_WITHDRAW_PRECOMPILE}:${l1WithdrawTarget}`;
          if (!seenKeys.has(outKey)) {
            seenKeys.add(outKey);
            txData.push({
              _dedupKey: outKey,
              id: blk,
              hash: tx.hash,
              timestamp: tx.timestamp,
              amount: normAmt,
              sender: { address: ETHERLINK_L2_WITHDRAW_PRECOMPILE, alias: 'Etherlink L1 Withdraw' },
              target: { address: ETHERLINK_WITHDRAW_CONTRACT, alias: 'Etherlink Withdraw' },
              l1WithdrawTarget
            });
          }
        }
      });
    }

    intExhausted = !intV2Result?.hadError;
    let minIntBlock = Infinity;

    if (Array.isArray(intV2Result?.items)) {
      intExhausted = Boolean(intV2Result.exhausted);
      intV2Result.items.forEach((itx) => {
        const rawVal = parseFloat(itx.value || '0');
        if (!itx.success || !rawVal || rawVal <= 0) return;

        const blk = Number(itx.block_number || 0);
        if (blk > 0 && blk < minIntBlock) minIntBlock = blk;

        const sender = makeParty(itx.from?.hash, itx.from?.name);
        const target = makeParty(itx.to?.hash, itx.to?.name);
        if (!sender.address || !target.address) return;
        if (evmAddress === ETHERLINK_KYBERSWAP_ROUTER && sender.address === target.address) return;
        if (
          sender.address === ETHERLINK_L2_WITHDRAW_PRECOMPILE &&
          seenKeys.has(`${itx.transaction_hash}:${ETHERLINK_L2_FEED_ADDRESS}:${target.address}`)
        ) {
          return;
        }
        const dedupKey = `${itx.transaction_hash}:${sender.address}:${target.address}:${itx.index ?? ''}`;
        const pairKey = `${itx.transaction_hash}:${sender.address}:${target.address}`;
        if (seenKeys.has(dedupKey) || seenKeys.has(pairKey)) return;
        seenKeys.add(dedupKey);
        seenKeys.add(pairKey);
        txData.push({
          _dedupKey: dedupKey,
          id: blk,
          hash: itx.transaction_hash,
          timestamp: itx.timestamp,
          amount: (rawVal / 1e18) * 1_000_000,
          sender,
          target
        });
      });
    }

    // Align the block window if either top-level or internal transactions were truncated at the fetch limit
    let cutoffBlock = 0;
    if (!isFeedAddress && !isZeroAddress && !isWithdrawPrecompile && (!topExhausted || !intExhausted)) {
      cutoffBlock = Math.max(
        !topExhausted && Number.isFinite(minTopBlock) ? minTopBlock : 0,
        !intExhausted && Number.isFinite(minIntBlock) ? minIntBlock : 0
      );
      if (cutoffBlock > 0) {
        txData = txData.filter((op) => !op.id || op.id >= cutoffBlock);
      }
    }

    // Recover internal XTZ inflows omitted by Blockscout's /addresses/{addr}/internal-transactions index
    // (only triggered when sampled XTZ net flow shows an impossible deficit, so normal wallets make 0 extra calls)
    if (!isFeedAddress && !isWithdrawPrecompile && evmAddress !== ETHERLINK_ZERO_ADDRESS) {
      let sampledNetXtz = 0;
      const recordedInflowHashes = new Set();
      txData.forEach((op) => {
        const amtXtz = (Number(op.amount) || 0) / 1_000_000;
        if (op.target?.address === evmAddress && op.sender?.address !== evmAddress) {
          sampledNetXtz += amtXtz;
          if (op.hash) recordedInflowHashes.add(String(op.hash).toLowerCase());
        } else if (op.sender?.address === evmAddress && op.target?.address !== evmAddress) {
          sampledNetXtz -= amtXtz;
        }
      });

      if (sampledNetXtz < -10) {
        try {
          const missingTxHashes = [];
          const cbMetaByHash = new Map();
          let recoveredDeltaXtz = 0;
          const targetDeficitXtz = Math.abs(sampledNetXtz) * 0.9;
          let nextCbQs = '?items_count=100';
          let stopCbScan = false;
          for (let page = 0; page < 6 && !stopCbScan; page++) {
            const cbResp = await blockscoutFetch(`${ETHERLINK_API_BASE}/addresses/${enc}/coin-balance-history${nextCbQs}`);
            if (!cbResp.ok) break;
            const cbJson = await cbResp.json();
            const cbItems = Array.isArray(cbJson?.items) ? cbJson.items : [];
            for (const entry of cbItems) {
              const blk = Number(entry.block_number || 0);
              if (cutoffBlock > 0 && blk > 0 && blk < cutoffBlock) {
                stopCbScan = true;
                break;
              }
              const deltaXtz = parseFloat(entry.delta || '0') / 1e18;
              const txHash = String(entry.transaction_hash || '').toLowerCase();
              if (deltaXtz > 1 && txHash && !recordedInflowHashes.has(txHash)) {
                if (!cbMetaByHash.has(txHash)) {
                  cbMetaByHash.set(txHash, { block: blk, timestamp: entry.block_timestamp });
                  missingTxHashes.push(txHash);
                  recoveredDeltaXtz += deltaXtz;
                  if (recoveredDeltaXtz >= targetDeficitXtz) {
                    stopCbScan = true;
                    break;
                  }
                }
              }
            }
            const qs = buildV2NextQuery(cbJson?.next_page_params);
            if (!qs) break;
            nextCbQs = qs;
          }

          if (missingTxHashes.length > 0) {
            const recoveredLists = await Promise.all(
              missingTxHashes.slice(0, 5).map((hash) =>
                blockscoutFetch(`${ETHERLINK_API_BASE}/transactions/${hash}/internal-transactions?items_count=100`)
                  .then((r) => (r.ok ? r.json() : null))
                  .catch(() => null)
              )
            );
            recoveredLists.forEach((res, idx) => {
              const fallbackMeta = cbMetaByHash.get(missingTxHashes[idx]) || {};
              const items = Array.isArray(res?.items) ? res.items : [];
              items.forEach((itx) => {
                rememberPartyAlias(itx.from);
                rememberPartyAlias(itx.to);
                const rawVal = parseFloat(itx.value || '0');
                if (!itx.success || !rawVal || rawVal <= 0) return;
                const sender = makeParty(itx.from?.hash, itx.from?.name);
                const target = makeParty(itx.to?.hash, itx.to?.name);
                if (!sender.address || !target.address) return;
                if (sender.address !== evmAddress && target.address !== evmAddress) return;
                const txHash = itx.transaction_hash || missingTxHashes[idx];
                const blk = Number(itx.block_number || fallbackMeta.block || 0);
                if (cutoffBlock > 0 && blk > 0 && blk < cutoffBlock) return;
                const dedupKey = `${txHash}:${sender.address}:${target.address}:${itx.index ?? ''}`;
                const pairKey = `${txHash}:${sender.address}:${target.address}`;
                if (seenKeys.has(dedupKey) || seenKeys.has(pairKey)) return;
                seenKeys.add(dedupKey);
                seenKeys.add(pairKey);
                txData.push({
                  _dedupKey: dedupKey,
                  id: blk,
                  hash: txHash,
                  timestamp: itx.timestamp || fallbackMeta.timestamp,
                  amount: (rawVal / 1e18) * 1_000_000,
                  sender,
                  target
                });
              });
            });
          }
        } catch (err) {
          console.warn('Coin balance history recovery failed:', err);
        }
      }
    }

    txData.sort((a, b) => (b.id || 0) - (a.id || 0));
  }

  // 3. Parse ERC-20 Token Transfers (USDT, USDC, WXTZ, WETH, LBTC, WBTC, xU3O8) & LayerZero Bridge recognition
  const faData = existing?.faData ? [...existing.faData] : [];
  const seenFaKeys = new Set(faData.map((f) => f._dedupKey || `${f.hash}:${f['token.contract.address']}:${f.from?.address}:${f.to?.address}`));
  const isZeroHub = evmAddress === ETHERLINK_ZERO_ADDRESS;

  if (Array.isArray(tokenTxJson?.items)) {
    tokenTxJson.items.forEach((tr) => {
      rememberPartyAlias(tr.from);
      rememberPartyAlias(tr.to);
      const sym = String(tr.token?.symbol || '').toLowerCase();
      const cAddr = String(tr.token?.address_hash || '').toLowerCase();
      const tokenKey =
        CONTRACT_TO_TOKEN_KEY.get(cAddr) ||
        (sym === 'usdt' || sym === 'usdt0'
          ? 'usdt_l2'
          : sym === 'usdc' || sym === 'usdc.e'
          ? 'usdc'
          : sym === 'wxtz'
          ? 'wxtz'
          : sym === 'weth' || sym === 'weth.e'
          ? 'weth'
          : sym === 'lbtc'
          ? 'lbtc'
          : sym === 'wbtc' || sym === 'wbtc.e'
          ? 'wbtc'
          : sym === 'xu3o8'
          ? 'xu3o8'
          : sym === 'tzbtc'
          ? 'tzbtc'
          : null);
      if (!tokenKey || !TOKEN_DEFINITIONS[tokenKey]) return;

      const tokenDef = TOKEN_DEFINITIONS[tokenKey];
      const mappedContract = tokenDef.contract;

      const rawFromHash = String(tr.from?.hash || '').toLowerCase();
      const rawToHash = String(tr.to?.hash || '').toLowerCase();
      const methodLower = String(tr.method || '').toLowerCase();
      const trType = String(tr.type || '').toLowerCase();
      const isLzMethod = ETHERLINK_LZ_BRIDGE_METHODS.has(methodLower);
      const isBridgedToken = ETHERLINK_BRIDGED_TOKEN_KEYS.has(tokenKey);

      let fromParty = makeParty(tr.from?.hash, tr.from?.name);
      let toParty = makeParty(tr.to?.hash, tr.to?.name);

      // Recognize LayerZero bridge-in (token minting from 0x000...000 or cross-chain bridge pool)
      if (!rawFromHash || rawFromHash === ETHERLINK_ZERO_ADDRESS || trType === 'token_minting') {
        if (isZeroHub) {
          fromParty = { address: ETHERLINK_ZERO_ADDRESS, alias: 'Zero / Mint & Burn Address (0x0)' };
        } else if (isBridgedToken || isLzMethod) {
          fromParty = { address: ETHERLINK_LZ_BRIDGE_CONTRACT, alias: 'LayerZero Bridge' };
        } else if (tokenKey === 'wxtz') {
          fromParty = { address: ETHERLINK_WXTZ_CONTRACT, alias: 'Wrapped XTZ (WXTZ)' };
        } else if (tokenKey === 'xu3o8') {
          fromParty = { address: ETHERLINK_XU3O8_CONTRACT, alias: 'Uranium (xU3O8)' };
        }
      } else if (
        !isZeroHub &&
        (rawFromHash === ETHERLINK_LBTC_TOKEN_POOL ||
          rawFromHash === ETHERLINK_LBTC_BRIDGE_OFFRAMP ||
          rawFromHash === ETHERLINK_LBTC_BRIDGE_ROUTER ||
          rawFromHash === ETHERLINK_LZ_ULN_CONTRACT)
      ) {
        fromParty = { address: ETHERLINK_LZ_BRIDGE_CONTRACT, alias: 'LayerZero Bridge' };
      }

      // Recognize LayerZero bridge-out (token burning to 0x000...000 or cross-chain bridge pool)
      if (!rawToHash || rawToHash === ETHERLINK_ZERO_ADDRESS || trType === 'token_burning') {
        if (isZeroHub) {
          toParty = { address: ETHERLINK_ZERO_ADDRESS, alias: 'Zero / Mint & Burn Address (0x0)' };
        } else if (isBridgedToken || isLzMethod) {
          toParty = { address: ETHERLINK_LZ_BRIDGE_CONTRACT, alias: 'LayerZero Bridge' };
        } else if (tokenKey === 'wxtz') {
          toParty = { address: ETHERLINK_WXTZ_CONTRACT, alias: 'Wrapped XTZ (WXTZ)' };
        } else if (tokenKey === 'xu3o8') {
          toParty = { address: ETHERLINK_XU3O8_CONTRACT, alias: 'Uranium (xU3O8)' };
        }
      } else if (
        !isZeroHub &&
        (rawToHash === ETHERLINK_LBTC_TOKEN_POOL ||
          rawToHash === ETHERLINK_LBTC_BRIDGE_OFFRAMP ||
          rawToHash === ETHERLINK_LBTC_BRIDGE_ROUTER ||
          rawToHash === ETHERLINK_LZ_ULN_CONTRACT)
      ) {
        toParty = { address: ETHERLINK_LZ_BRIDGE_CONTRACT, alias: 'LayerZero Bridge' };
      }

      if (evmAddress === ETHERLINK_KYBERSWAP_ROUTER && fromParty.address === toParty.address) {
        return;
      }

      const dec = Number(tr.total?.decimals || tr.token?.decimals || tokenDef.decimals || 6);
      const targetDec = Number(tokenDef.decimals || 6);
      const rawVal = parseFloat(tr.total?.value || '0');
      const scaledAmount = (rawVal / Math.pow(10, dec)) * Math.pow(10, targetDec);
      if (!scaledAmount || scaledAmount <= 0) return;

      const faDedupKey = `${tr.transaction_hash}:${mappedContract}:${fromParty.address}:${toParty.address}:${tr.log_index ?? ''}`;
      if (seenFaKeys.has(faDedupKey)) return;
      seenFaKeys.add(faDedupKey);

      faData.push({
        _dedupKey: faDedupKey,
        id: Number(tr.block_number || 0),
        timestamp: tr.timestamp,
        'token.contract.address': mappedContract,
        from: fromParty.address ? fromParty : null,
        to: toParty.address ? toParty : null,
        amount: String(scaledAmount),
        hash: tr.transaction_hash
      });
    });

    faData.sort((a, b) => (b.id || 0) - (a.id || 0));
  }

  const xtzHadError = Boolean(needXtzFetch && (topTxV2Result?.hadError || intV2Result?.hadError));
  const faHadError = Boolean(needFa && (tokenTxJson?.hadError || tokBalFetchError));
  const hadError = Boolean(xtzHadError || faHadError || addrFetchError);
  const hasAnyData = txData.length > 0 || faData.length > 0;

  const computedXtzLimit = needXtz
    ? xtzHadError
      ? Math.max(txData.length, existing?.limit || 0)
      : Math.max(txData.length, numLimit, existing?.limit || 0)
    : existing?.limit || 0;

  const computedFaLimit = needFa
    ? faHadError
      ? Math.max(faData.length, existing?.faLimit || 0)
      : Math.max(faData.length, numLimit, existing?.faLimit || 0)
    : existing?.faLimit || 0;

  if (hasAnyData || !hadError) {
    cache.set(evmAddress, {
      txData,
      rawTopItems: needXtzFetch ? topTxV2Result?.items || [] : existing?.rawTopItems || [],
      rawIntItems: needXtzFetch ? intV2Result?.items || [] : existing?.rawIntItems || [],
      topExhausted,
      intExhausted,
      topNextQs: needXtzFetch ? topTxV2Result?.nextQs || null : existing?.topNextQs || null,
      intNextQs: needXtzFetch ? intV2Result?.nextQs || null : existing?.intNextQs || null,
      topNextParams: needXtzFetch ? topTxV2Result?.nextParams || null : existing?.topNextParams || null,
      intNextParams: needXtzFetch ? intV2Result?.nextParams || null : existing?.intNextParams || null,
      topLastMaxBlock: needXtzFetch ? topTxV2Result?.lastMaxBlock || 0 : existing?.topLastMaxBlock || 0,
      intLastMaxBlock: needXtzFetch ? intV2Result?.lastMaxBlock || 0 : existing?.intLastMaxBlock || 0,
      topPrefetchedSegments: needXtzFetch
        ? topTxV2Result?.prefetchedSegments || []
        : existing?.topPrefetchedSegments || [],
      intPrefetchedSegments: needXtzFetch
        ? intV2Result?.prefetchedSegments || []
        : existing?.intPrefetchedSegments || [],
      topPagesFetched: needXtzFetch ? topTxV2Result?.pagesFetched || 0 : existing?.topPagesFetched || 0,
      intPagesFetched: needXtzFetch ? intV2Result?.pagesFetched || 0 : existing?.intPagesFetched || 0,
      specialOps: [],
      specialOpsFetched: true,
      internalChecked: needXtz && !xtzHadError ? true : Boolean(existing?.internalChecked),
      l1DepositsChecked: needXtz ? true : Boolean(existing?.l1DepositsChecked),
      limit: computedXtzLimit,
      lastOffset: null,
      exhausted: needXtzFetch ? topExhausted && intExhausted : Boolean(existing?.exhausted),
      faData,
      faLimit: computedFaLimit,
      faLastOffset: null,
      faExhausted: L2_ERC20_TOKEN_KEYS.every((k) => tokenExhaustedMap.get(k)),
      fetchedL2Tokens,
      tokenExhaustedMap,
      tokenNextQsMap,
      tokenNextParamsMap,
      tokenMaxBlockMap,
      tokenSegmentsMap,
      tokenPagesMap,
      tokenItemsMap,
      unfilteredTried: unfilteredAttempted,
      unfilteredFaComplete: unfilteredFaShortCircuit,
      accountInfo
    });
  }

  return {
    operations: needXtz ? txData.slice(0, numLimit) : [],
    faTransfers: needFa ? sliceL2FaTransfersByDepth(faData, numLimit) : [],
    accountInfo,
    apiError: hadError
      ? lastBlockscoutApiError ||
        lastTzktApiError || { source: 'Blockscout', status: 0, category: 'network', isNetworkError: true }
      : null
  };
}

async function fetchFaTransfersBatch(tezosAddress, lastId = 0, batchLimit = 10000, offset = 0) {
  const clampLimit = Math.min(10000, Math.max(1, Number(batchLimit) || 10000));
  const baseUrl = `${TZKT_API_BASE}/tokens/transfers?anyof.from.to=${encodeURIComponent(tezosAddress)}&token.contract.in=${FA_CONTRACT_LIST}&amount.gt=0&sort.desc=id&select=id,timestamp,token.contract.address,from,to,amount,transactionId&limit=${clampLimit}`;
  let url = baseUrl;
  if (lastId > 0) {
    url += offset > 0 ? `&id.lt=${lastId}&offset=${offset}` : `&offset.cr=${lastId}`;
  } else if (offset > 0) {
    url += `&offset=${offset}`;
  }

  try {
    const response = await tzktFetch(url);
    if (!response.ok) {
      const errType =
        response.status >= 500
          ? '5xx Server Error'
          : response.status === 429
          ? '429 Rate Limit'
          : '4xx Client Error';
      console.error(`TzKT ${errType} (HTTP ${response.status}) fetching FA token transfers batch`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error('Network error fetching FA token transfers batch:', err);
    return null;
  }
}

async function resolveTxRefsToHashes(refs) {
  if (!refs || refs.length === 0) return [];
  const unresolvedIds = [];
  for (let i = 0; i < refs.length; i++) {
    const r = String(refs[i] || '');
    if (r.startsWith('txid:')) {
      const idNum = Number(r.slice(5));
      if (idNum && !txIdToHashCache.has(idNum)) {
        unresolvedIds.push(idNum);
      }
    }
  }

  if (unresolvedIds.length > 0) {
    const uniqueIds = Array.from(new Set(unresolvedIds));
    const chunkSize = 80;
    const chunks = [];
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      chunks.push(uniqueIds.slice(i, i + chunkSize));
    }

    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const res = await tzktFetch(
            `${TZKT_API_BASE}/operations/transactions?id.in=${chunk.join(',')}&select=id,hash&limit=${chunk.length}`
          );
          if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows)) {
              rows.forEach((row) => {
                if (row.id && row.hash) {
                  txIdToHashCache.set(Number(row.id), row.hash);
                }
              });
            }
          }
        } catch (err) {
          console.error('Error resolving transactionIds to hashes:', err);
        }
      })
    );
  }

  const out = [];
  const seen = new Set();
  for (let i = 0; i < refs.length; i++) {
    const r = String(refs[i] || '');
    let resolved = r;
    if (r.startsWith('txid:')) {
      const idNum = Number(r.slice(5));
      resolved = txIdToHashCache.get(idNum) || r;
    }
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function formatTxRefSync(ref) {
  const s = String(ref || '');
  if (s.startsWith('txid:')) {
    const idNum = Number(s.slice(5));
    return txIdToHashCache.get(idNum) || s;
  }
  return s;
}

async function fetchAllData(tezosAddress, requestedLimit) {
  if (isEtherlinkAddress(tezosAddress)) {
    return fetchEtherlinkData(tezosAddress, requestedLimit);
  }

  const numLimit = Number(requestedLimit) || 10000;
  const needXtz = viewConfig.enabledTokens.has('xtz');
  const needFa = L1_FA_TOKEN_KEYS.some((k) => viewConfig.enabledTokens.has(k));

  if (cache.has(tezosAddress)) {
    const cached = cache.get(tezosAddress);
    const xtzReady =
      !needXtz || ((cached.exhausted || (cached.limit || 0) >= numLimit) && cached.specialOpsFetched);
    const faReady =
      !needFa ||
      ((cached.faExhausted || (cached.faLimit || 0) >= numLimit) &&
        Boolean(cached.accountInfo?.tokenBalancesFetched));
    if (xtzReady && faReady) {
      return {
        operations: needXtz ? [...cached.txData.slice(0, numLimit), ...(cached.specialOps || [])] : [],
        faTransfers: needFa ? (cached.faData || []).slice(0, numLimit) : [],
        accountInfo: cached.accountInfo,
        apiError: null
      };
    }
  }

  const loaderEl = document.getElementById('loader');
  const loaderStatus = document.getElementById('loader-status');
  const emptyState = document.getElementById('empty-state');
  const diagramEl = document.getElementById('sankey-diagram');
  const statsStrip = document.getElementById('stats-strip');

  if (emptyState) emptyState.style.display = 'none';
  if (diagramEl) diagramEl.style.display = 'none';
  if (statsStrip) statsStrip.style.display = 'none';
  if (loaderEl) loaderEl.style.display = 'flex';

  lastTzktApiError = null;

  const existing = cache.get(tezosAddress);
  const txData = existing ? [...existing.txData] : [];
  const seenXtzIds = new Set(txData.map((op) => Number(op.id)).filter(Boolean));
  let lastOffset = existing ? existing.lastOffset : 0;
  let counter = txData.length;
  let exhausted = existing ? Boolean(existing.exhausted) : false;
  let xtzLimit = existing?.limit || 0;
  let xtzHadError = false;

  const faData = existing?.faData ? [...existing.faData] : [];
  const seenFaIds = new Set(faData.map((tr) => Number(tr.id)).filter(Boolean));
  let faLastOffset = existing?.faLastOffset || 0;
  let faCounter = faData.length;
  let faExhausted = existing ? Boolean(existing.faExhausted) : false;
  let faLimit = existing?.faLimit || 0;
  let faHadError = false;

  const accountPromise = (async () => {
    if (existing?.accountInfo) {
      if (needFa && !existing.accountInfo.tokenBalancesFetched) {
        const tokenBalances =
          (existing.accountInfo.tokenBalancesCount ?? 1) > 0
            ? await fetchAccountTokenBalances(tezosAddress)
            : createEmptyTokenBalances();
        existing.accountInfo = {
          ...existing.accountInfo,
          tokenBalances,
          tokenBalancesFetched: true
        };
      }
      return existing.accountInfo;
    }
    return fetchAccountMetadata(tezosAddress, needFa);
  })();

  let specialOpsFetched = Boolean(existing?.specialOpsFetched);
  const specialOpsPromise = !needXtz
    ? Promise.resolve(existing?.specialOps || [])
    : existing?.specialOpsFetched
      ? Promise.resolve(existing.specialOps || [])
      : fetchSpecialAccountOps(tezosAddress, accountPromise).then((ops) => {
          specialOpsFetched = true;
          return ops;
        });

  const xtzFetchPromise = (async () => {
    if (!needXtz) return;

    const accInfo = numLimit - counter > 10000 ? await accountPromise : existing?.accountInfo || null;
    if (accInfo && Number(accInfo.numTransactions) === 0) {
      exhausted = true;
    }

    while (!exhausted && !xtzHadError && counter < numLimit) {
      const remaining = numLimit - counter;
      const maxAccountRemaining =
        accInfo && typeof accInfo.numTransactions === 'number'
          ? Math.max(1000, Number(accInfo.numTransactions) - counter)
          : remaining;
      const effectiveRemaining = Math.min(remaining, maxAccountRemaining);
      const waveCount = Math.min(
        TZKT_MAX_REQUESTS_PER_SECOND,
        Math.max(1, Math.ceil(effectiveRemaining / 10000)),
        Math.max(1, Math.ceil(remaining / 10000))
      );

      const anchorId = lastOffset;
      let waveLoadedCount = counter;
      if (loaderStatus) {
        loaderStatus.textContent = `Fetching XTZ transactions from TzKT… ${counter.toLocaleString('en-US')} / ${numLimit.toLocaleString('en-US')}`;
      }

      const waveSpecs = [];
      for (let i = 0; i < waveCount; i++) {
        const pageOffset = i * 10000;
        const pageLimit = Math.min(10000, Math.max(1000, remaining - pageOffset));
        waveSpecs.push({ pageOffset, pageLimit });
      }

      const waveBatches = await Promise.all(
        waveSpecs.map(({ pageOffset, pageLimit }) =>
          fetchOperationsBatch(tezosAddress, anchorId, pageLimit, pageOffset).then((batch) => {
            if (Array.isArray(batch) && batch.length > 0 && loaderStatus) {
              waveLoadedCount = Math.min(numLimit, waveLoadedCount + batch.length);
              loaderStatus.textContent = `Fetching XTZ transactions from TzKT… ${waveLoadedCount.toLocaleString('en-US')} / ${numLimit.toLocaleString('en-US')}`;
            }
            return { batch, pageLimit };
          })
        )
      );

      for (let i = 0; i < waveBatches.length; i++) {
        const { batch, pageLimit } = waveBatches[i];
        if (batch === null || !Array.isArray(batch)) {
          // API or network failure: stop pagination without marking address history as exhausted
          xtzHadError = true;
          break;
        }
        if (batch.length === 0) {
          exhausted = true;
          break;
        }

        for (let j = 0; j < batch.length; j++) {
          const op = batch[j];
          const idNum = Number(op.id);
          if (idNum && op.hash) {
            txIdToHashCache.set(idNum, op.hash);
          }
          if (!idNum || !seenXtzIds.has(idNum)) {
            if (idNum) seenXtzIds.add(idNum);
            txData.push(op);
          }
        }
        lastOffset = batch[batch.length - 1].id;
        counter = txData.length;

        if (batch.length < pageLimit) {
          exhausted = true;
          break;
        }
      }
    }

    await enrichBridgeDepositParameters(txData);
    xtzLimit = xtzHadError
      ? Math.max(counter, existing?.limit || 0)
      : Math.max(counter, existing?.limit || 0, numLimit);
  })();

  const faFetchPromise = (async () => {
    if (!needFa) return;

    const accInfo = numLimit - faCounter > 10000 ? await accountPromise : existing?.accountInfo || null;
    if (accInfo && Number(accInfo.tokenTransfersCount) === 0) {
      faExhausted = true;
    }

    while (!faExhausted && !faHadError && faCounter < numLimit) {
      const remaining = numLimit - faCounter;
      const maxFaRemaining =
        accInfo && typeof accInfo.tokenTransfersCount === 'number'
          ? Math.max(1000, Number(accInfo.tokenTransfersCount) - faCounter)
          : remaining;
      const effectiveRemaining = Math.min(remaining, maxFaRemaining);
      const waveCount = Math.min(
        TZKT_MAX_REQUESTS_PER_SECOND,
        Math.max(1, Math.ceil(effectiveRemaining / 10000)),
        Math.max(1, Math.ceil(remaining / 10000))
      );

      const anchorId = faLastOffset;
      let waveLoadedCount = faCounter;
      if (loaderStatus && !needXtz) {
        loaderStatus.textContent = `Fetching FA token transfers… ${faCounter.toLocaleString('en-US')} / ${numLimit.toLocaleString('en-US')}`;
      }

      const waveSpecs = [];
      for (let i = 0; i < waveCount; i++) {
        const pageOffset = i * 10000;
        const pageLimit = Math.min(10000, Math.max(1000, remaining - pageOffset));
        waveSpecs.push({ pageOffset, pageLimit });
      }

      const waveBatches = await Promise.all(
        waveSpecs.map(({ pageOffset, pageLimit }) =>
          fetchFaTransfersBatch(tezosAddress, anchorId, pageLimit, pageOffset).then((batch) => {
            if (Array.isArray(batch) && batch.length > 0 && loaderStatus) {
              waveLoadedCount = Math.min(numLimit, waveLoadedCount + batch.length);
              loaderStatus.textContent = `Fetching FA token transfers… ${waveLoadedCount.toLocaleString('en-US')} / ${numLimit.toLocaleString('en-US')}`;
            }
            return { batch, pageLimit };
          })
        )
      );

      for (let i = 0; i < waveBatches.length; i++) {
        const { batch, pageLimit } = waveBatches[i];
        if (batch === null || !Array.isArray(batch)) {
          // API or network failure: stop pagination without marking FA history as exhausted
          faHadError = true;
          break;
        }
        if (batch.length === 0) {
          faExhausted = true;
          break;
        }

        for (let j = 0; j < batch.length; j++) {
          const tr = batch[j];
          const idNum = Number(tr.id);
          if (!idNum || !seenFaIds.has(idNum)) {
            if (idNum) seenFaIds.add(idNum);
            faData.push(tr);
          }
        }
        faLastOffset = batch[batch.length - 1].id;
        faCounter = faData.length;

        if (batch.length < pageLimit) {
          faExhausted = true;
          break;
        }
      }
    }

    faLimit = faHadError
      ? Math.max(faCounter, existing?.faLimit || 0)
      : Math.max(faCounter, existing?.faLimit || 0, numLimit);
  })();

  const [accountInfo, specialOps] = await Promise.all([
    accountPromise,
    specialOpsPromise,
    xtzFetchPromise,
    faFetchPromise
  ]);

  const hasAnyData = txData.length > 0 || faData.length > 0 || (specialOps && specialOps.length > 0);
  const hadError = xtzHadError || faHadError;

  // Avoid poisoning session cache when a request completely fails with 0 data
  if (hasAnyData || !hadError) {
    cache.set(tezosAddress, {
      txData,
      specialOps,
      specialOpsFetched: xtzHadError ? Boolean(existing?.specialOpsFetched) : specialOpsFetched,
      limit: xtzLimit,
      lastOffset,
      exhausted,
      faData,
      faLimit,
      faLastOffset,
      faExhausted,
      accountInfo
    });
  }

  return {
    operations: needXtz ? [...txData.slice(0, numLimit), ...specialOps] : [],
    faTransfers: needFa ? faData.slice(0, numLimit) : [],
    accountInfo,
    apiError: hadError
      ? lastTzktApiError || { status: 0, category: 'network', isNetworkError: true }
      : null
  };
}

// ============================================================================
// Unified Counterparty Multi-Token Transaction Parsing
// Groups all enabled token flows for the same counterparty into a single node
// with an array of `tokenFlows` (so 1 node can emit/receive 1, 2, or 3 colored ribbons)
// ============================================================================

function parseTransactions(data, faTransfers, tezosAddress, tezLimitVal) {
  const normTargetAddr = isEtherlinkAddress(tezosAddress) ? tezosAddress.trim().toLowerCase() : tezosAddress;
  const inflowsMap = new Map(); // Map<realAddress, UnifiedNodeEntry>
  const outflowsMap = new Map(); // Map<realAddress, UnifiedNodeEntry>
  const addressToAliasMap = new Map();
  const txHashesMap = new Map();

  addressToAliasMap.set(ETHERLINK_ZERO_ADDRESS, 'Zero / Mint & Burn Address (0x0)');
  addressToAliasMap.set(ETHERLINK_BRIDGE_CONTRACT, 'Etherlink Bridge');
  addressToAliasMap.set(ETHERLINK_WITHDRAW_CONTRACT, 'Etherlink Withdraw');
  addressToAliasMap.set(ETHERLINK_L2_FEED_ADDRESS, 'Etherlink L1 Deposit');
  addressToAliasMap.set(ETHERLINK_L2_WITHDRAW_PRECOMPILE, 'Etherlink L1 Withdraw');
  addressToAliasMap.set(ETHERLINK_LZ_BRIDGE_CONTRACT, 'LayerZero Bridge');
  addressToAliasMap.set(ETHERLINK_LZ_ULN_CONTRACT, 'LayerZero UltraLightNodeV2');
  addressToAliasMap.set(ETHERLINK_KYBERSWAP_ROUTER, 'KyberSwap MetaAggregationRouterV2');
  addressToAliasMap.set(ETHERLINK_KYBERSWAP_EXECUTOR_1, 'KyberSwap AggregationExecutor');
  addressToAliasMap.set(ETHERLINK_KYBERSWAP_EXECUTOR_2, 'KyberSwap AggregationExecutor');
  addressToAliasMap.set(ETHERLINK_KYBERSWAP_EXECUTOR_3, 'KyberSwap AggregationExecutor');
  addressToAliasMap.set(ETHERLINK_WXTZ_CONTRACT, 'Wrapped XTZ (WXTZ)');
  addressToAliasMap.set(ETHERLINK_USDC_CONTRACT, 'LayerZero Bridged USDC');
  addressToAliasMap.set(ETHERLINK_USDT_CONTRACT, 'Tether USD (USDT)');
  addressToAliasMap.set(ETHERLINK_WETH_CONTRACT, 'Bridged WETH');
  addressToAliasMap.set(ETHERLINK_LBTC_CONTRACT, 'Lombard Staked Bitcoin (LBTC)');
  addressToAliasMap.set(ETHERLINK_XU3O8_CONTRACT, 'Uranium (xU3O8)');

  function recordUnifiedFlow(
    map,
    keyAddress,
    displayAlias,
    amount,
    timestamp,
    opRef,
    isSpecial = false,
    tokenKey = 'xtz',
    opCount = 1,
    startTimestamp = timestamp
  ) {
    if (!amount || amount <= 0) return;
    const tokenDef = TOKEN_DEFINITIONS[tokenKey] || TOKEN_DEFINITIONS.xtz;
    const countInc = Math.max(1, Number(opCount) || 1);
    const startTs = startTimestamp instanceof Date && !isNaN(startTimestamp.getTime()) ? startTimestamp : timestamp;
    let nodeEntry = map.get(keyAddress);

    if (!nodeEntry) {
      nodeEntry = {
        flowKey: keyAddress,
        realAddress: keyAddress,
        alias: displayAlias && displayAlias !== keyAddress ? displayAlias : '',
        address: displayAlias || keyAddress,
        tokenMap: new Map(), // Map<tokenKey, TokenSubFlow>
        tokenFlows: [],
        subBranchesMap: new Map(), // Map<branchAddr, SubBranchEntry>
        subBranches: [],
        amount: 0,
        equivalentTez: 0,
        count: 0,
        dateRange: { start: startTs, end: timestamp },
        txHashes: [],
        txHashSet: new Set(),
        isSpecial
      };
      map.set(keyAddress, nodeEntry);
    } else {
      if (!nodeEntry.alias && displayAlias && displayAlias !== keyAddress) {
        nodeEntry.alias = displayAlias;
        nodeEntry.address = displayAlias;
      }
      if (startTs < nodeEntry.dateRange.start) nodeEntry.dateRange.start = startTs;
      if (timestamp > nodeEntry.dateRange.end) nodeEntry.dateRange.end = timestamp;
    }

    nodeEntry.count += countInc;
    if (opRef && !nodeEntry.txHashSet.has(opRef)) {
      nodeEntry.txHashSet.add(opRef);
      nodeEntry.txHashes.push(opRef);
    }

    let tf = nodeEntry.tokenMap.get(tokenKey);
    if (!tf) {
      tf = {
        tokenKey,
        tokenSymbol: tokenDef.symbol,
        tokenTicker: tokenDef.ticker,
        tokenContract: tokenDef.contract,
        amount: 0,
        equivalentTez: 0,
        count: 0,
        txHashes: [],
        txHashSet: new Set(),
        isSpecial
      };
      nodeEntry.tokenMap.set(tokenKey, tf);
    }
    tf.amount += amount;
    tf.equivalentTez = tf.amount * tokenDef.tezEquivalentRate;
    tf.count += countInc;
    if (opRef && !tf.txHashSet.has(opRef)) {
      tf.txHashSet.add(opRef);
      tf.txHashes.push(opRef);
    }
  }

  function recordSubBranch(map, parentKeyAddr, branchAddr, branchAlias, network, amount, opRef) {
    if (!branchAddr || !amount || amount <= 0) return;
    const nodeEntry = map.get(parentKeyAddr);
    if (!nodeEntry) return;
    let b = nodeEntry.subBranchesMap.get(branchAddr);
    if (!b) {
      b = {
        address: branchAddr,
        alias: branchAlias && branchAlias !== branchAddr ? branchAlias : '',
        network,
        amount: 0,
        count: 0,
        txHashes: [],
        txHashSet: new Set()
      };
      nodeEntry.subBranchesMap.set(branchAddr, b);
    } else if (!b.alias && branchAlias && branchAlias !== branchAddr) {
      b.alias = branchAlias;
    }
    b.amount += amount;
    b.count += 1;
    if (opRef && !b.txHashSet.has(opRef)) {
      b.txHashSet.add(opRef);
      b.txHashes.push(opRef);
    }
  }

  function rememberL1BridgeDeposit(evmAddr, l1SenderAddr, l1SenderAlias, amount, opHash) {
    if (!evmAddr || !l1SenderAddr || !amount || amount <= 0) return;
    let depMap = l2ToL1DepositorsMap.get(evmAddr);
    if (!depMap) {
      depMap = new Map();
      l2ToL1DepositorsMap.set(evmAddr, depMap);
    }
    let rec = depMap.get(l1SenderAddr);
    if (!rec) {
      rec = {
        address: l1SenderAddr,
        alias: l1SenderAlias && l1SenderAlias !== l1SenderAddr ? l1SenderAlias : '',
        amount: 0,
        count: 0,
        txHashes: [],
        txHashSet: new Set()
      };
      depMap.set(l1SenderAddr, rec);
    }
    if (opHash && !rec.txHashSet.has(opHash)) {
      rec.txHashSet.add(opHash);
      rec.txHashes.push(opHash);
      rec.amount += amount;
      rec.count += 1;
    }
  }

  // 1. Parse Native XTZ Operations if XTZ is enabled
  if (viewConfig.enabledTokens.has('xtz') && Array.isArray(data)) {
    data.forEach((operation) => {
      const senderAddr = operation.sender?.address || '';
      const targetAddr = operation.target?.address || '';
      const senderAlias =
        operation.sender?.alias ||
        (senderAddr === ETHERLINK_BRIDGE_CONTRACT
          ? 'Etherlink Bridge'
          : senderAddr === ETHERLINK_WITHDRAW_CONTRACT
          ? 'Etherlink Withdraw'
          : senderAddr);
      const targetAlias =
        operation.target?.alias ||
        (targetAddr === ETHERLINK_BRIDGE_CONTRACT
          ? 'Etherlink Bridge'
          : targetAddr === ETHERLINK_WITHDRAW_CONTRACT
          ? 'Etherlink Withdraw'
          : targetAddr);
      const timestamp = new Date(operation.timestamp);

      if (operation.type === 'activation') {
        const accAddr = operation.account?.address || normTargetAddr;
        const accAlias = operation.account?.alias || accAddr;
        addressToAliasMap.set(accAddr, accAlias);

        const specialKey = '~Activation~';
        const amount = parseFloat(operation.balance / 1_000_000);
        recordUnifiedFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true, 'xtz');
      } else if (operation.type === 'migration' && operation.kind === 'bootstrap') {
        const accAddr = operation.account?.address || normTargetAddr;
        const accAlias = operation.account?.alias || accAddr;
        addressToAliasMap.set(accAddr, accAlias);

        const specialKey = '~Bootstrap~';
        const amount = parseFloat(operation.balanceChange / 1_000_000);
        recordUnifiedFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true, 'xtz');
      } else if (operation.type === 'migration' && operation.kind === 'subsidy') {
        const accAddr = operation.account?.address || normTargetAddr;
        const accAlias = operation.account?.alias || accAddr;
        addressToAliasMap.set(accAddr, accAlias);

        const specialKey = '~Subsidy (all time)~';
        const amount = parseFloat(operation.balanceChange / 1_000_000);
        const startTs = operation.startTimestamp ? new Date(operation.startTimestamp) : timestamp;
        recordUnifiedFlow(
          inflowsMap,
          specialKey,
          specialKey,
          amount,
          timestamp,
          operation.hash,
          true,
          'xtz',
          operation.count || 1,
          startTs
        );
      } else if (operation.type === 'origination') {
        if (operation.contractBalance > 0) {
          const origAddr = operation.originatedContract?.address || '';
          const origAlias = operation.originatedContract?.alias || origAddr;
          const amount = parseFloat(operation.contractBalance / 1_000_000);

          if (senderAddr === normTargetAddr && origAddr) {
            addressToAliasMap.set(senderAddr, senderAlias);
            addressToAliasMap.set(origAddr, origAlias);
            recordUnifiedFlow(outflowsMap, origAddr, origAlias, amount, timestamp, operation.hash, false, 'xtz');
          } else if (origAddr === normTargetAddr && senderAddr) {
            addressToAliasMap.set(senderAddr, senderAlias);
            addressToAliasMap.set(origAddr, origAlias);
            recordUnifiedFlow(inflowsMap, senderAddr, senderAlias, amount, timestamp, operation.hash, false, 'xtz');
          }
        }
      } else if (!operation.type || operation.type === 'transaction') {
        if (senderAddr) addressToAliasMap.set(senderAddr, senderAlias);
        if (targetAddr) addressToAliasMap.set(targetAddr, targetAlias);

        const amount = parseFloat(operation.amount / 1_000_000);
        if (amount > 0) {
          const l1BridgePeer =
            targetAddr === ETHERLINK_BRIDGE_CONTRACT ? senderAddr : targetAddr;
          const evmBridgeAddr =
            !isRollupInternalParty(l1BridgePeer) &&
            (targetAddr === ETHERLINK_BRIDGE_CONTRACT ||
              senderAddr === ETHERLINK_WITHDRAW_CONTRACT ||
              targetAddr === ETHERLINK_WITHDRAW_CONTRACT)
              ? extractEtherlinkEvmAddress(operation.parameter)
              : null;

          if (evmBridgeAddr && targetAddr === ETHERLINK_BRIDGE_CONTRACT && senderAddr) {
            rememberL1BridgeDeposit(evmBridgeAddr, senderAddr, senderAlias, amount, operation.hash);
          }

          if (senderAddr === normTargetAddr && targetAddr) {
            recordUnifiedFlow(outflowsMap, targetAddr, targetAlias, amount, timestamp, operation.hash, false, 'xtz');
            if (evmBridgeAddr) {
              recordSubBranch(outflowsMap, targetAddr, evmBridgeAddr, '', 'etherlink', amount, operation.hash);
            }
            if (operation.l1WithdrawTarget) {
              recordSubBranch(
                outflowsMap,
                targetAddr,
                operation.l1WithdrawTarget,
                '',
                'tezos',
                amount,
                operation.hash
              );
            }
          }
          if (targetAddr === normTargetAddr && senderAddr && senderAddr !== normTargetAddr) {
            recordUnifiedFlow(inflowsMap, senderAddr, senderAlias, amount, timestamp, operation.hash, false, 'xtz');
            if (evmBridgeAddr) {
              recordSubBranch(inflowsMap, senderAddr, evmBridgeAddr, '', 'etherlink', amount, operation.hash);
            }
            if (operation.l1SubBranch?.address) {
              recordSubBranch(
                inflowsMap,
                senderAddr,
                operation.l1SubBranch.address,
                operation.l1SubBranch.alias || '',
                'tezos',
                amount,
                operation.hash
              );
            }
          }
        }
      }
    });

    // If viewing an Etherlink L2 address that has known L1 depositors via the feed or 0x0 kernel mint, attach L1 branches
    if (
      isEtherlinkAddress(normTargetAddr) &&
      (inflowsMap.has(ETHERLINK_L2_FEED_ADDRESS) || inflowsMap.has(ETHERLINK_ZERO_ADDRESS))
    ) {
      const knownL1Map = l2ToL1DepositorsMap.get(normTargetAddr);
      if (knownL1Map) {
        const feedEntry =
          inflowsMap.get(ETHERLINK_L2_FEED_ADDRESS) ||
          (inflowsMap.get(ETHERLINK_ZERO_ADDRESS)?.tokenMap?.has('xtz')
            ? inflowsMap.get(ETHERLINK_ZERO_ADDRESS)
            : null);
        if (feedEntry) {
          knownL1Map.forEach((rec) => {
            feedEntry.subBranchesMap.set(rec.address, {
              address: rec.address,
              alias: rec.alias,
              network: 'tezos',
              amount: rec.amount,
              count: rec.count,
              txHashes: [...rec.txHashes],
              txHashSet: new Set(rec.txHashes)
            });
          });
        }
      }
    }
  }

  // 2. Parse FA Token Transfers (tzBTC, USDt) when FA Tokens switch is enabled
  if (viewConfig.faEnabled && Array.isArray(faTransfers)) {
    faTransfers.forEach((transfer) => {
      const contractAddr = transfer['token.contract.address'] || transfer.token?.contract?.address;
      const tokenKey = CONTRACT_TO_TOKEN_KEY.get(contractAddr);
      if (!tokenKey || !viewConfig.enabledTokens.has(tokenKey)) return;

      const tokenDef = TOKEN_DEFINITIONS[tokenKey];
      const decimals = Number(tokenDef.decimals || 6);
      const rawAmount = parseFloat(transfer.amount || '0');
      const amount = rawAmount / Math.pow(10, decimals);
      if (!amount || amount <= 0) return;

      const fromAddr = transfer.from?.address || '~Mint~';
      const toAddr = transfer.to?.address || '~Burn~';
      const fromAlias = transfer.from?.alias || fromAddr;
      const toAlias = transfer.to?.alias || toAddr;
      const timestamp = new Date(transfer.timestamp);

      if (transfer.from?.address) addressToAliasMap.set(fromAddr, fromAlias);
      if (transfer.to?.address) addressToAliasMap.set(toAddr, toAlias);

      const txId = transfer.transactionId;
      const opRef =
        transfer.hash ||
        (txId ? txIdToHashCache.get(Number(txId)) || `txid:${txId}` : '');

      if (fromAddr === normTargetAddr && toAddr) {
        const isSpecial = toAddr.startsWith('~');
        recordUnifiedFlow(outflowsMap, toAddr, toAlias, amount, timestamp, opRef, isSpecial, tokenKey);
      }
      if (toAddr === normTargetAddr && fromAddr && fromAddr !== normTargetAddr) {
        const isSpecial = fromAddr.startsWith('~');
        recordUnifiedFlow(inflowsMap, fromAddr, fromAlias, amount, timestamp, opRef, isSpecial, tokenKey);
      }
    });
  }

  const minTez = parseFloat(tezLimitVal) || 0;
  const allInflowsCount = inflowsMap.size;
  const allOutflowsCount = outflowsMap.size;

  function finalizeNodeEntries(map) {
    const list = [];
    map.forEach((entry) => {
      // Keep token flows in canonical order ['xtz', 'tzbtc', 'usdt'] that pass dust filter
      const keptFlows = ALL_TOKEN_ORDER
        .filter((tk) => entry.tokenMap.has(tk))
        .map((tk) => entry.tokenMap.get(tk))
        .filter((tf) => tf.equivalentTez >= minTez);

      if (keptFlows.length === 0) return;

      entry.tokenFlows = keptFlows;
      entry.equivalentTez = keptFlows.reduce((s, tf) => s + tf.equivalentTez, 0);
      // Primary token key (for single-token nodes or dominant flow)
      const primaryTf = [...keptFlows].sort((a, b) => b.equivalentTez - a.equivalentTez)[0];
      entry.tokenKey = primaryTf.tokenKey;
      entry.tokenSymbol = primaryTf.tokenSymbol;
      entry.tokenTicker = keptFlows.map((tf) => tf.tokenTicker).join(' + ');
      entry.amount = keptFlows.length === 1 ? keptFlows[0].amount : entry.equivalentTez;
      entry.count = keptFlows.reduce((s, tf) => s + tf.count, 0);
      entry.subBranches = entry.subBranchesMap
        ? Array.from(entry.subBranchesMap.values()).sort((a, b) => b.amount - a.amount)
        : [];
      list.push(entry);
    });
    return list;
  }

  const inflows = finalizeNodeEntries(inflowsMap);
  const outflows = finalizeNodeEntries(outflowsMap);

  // Detect bidirectional counterparties (present in both inflows and outflows)
  const inflowAddresses = new Set(inflows.map((i) => i.realAddress));
  const outflowAddresses = new Set(outflows.map((o) => o.realAddress));

  inflows.forEach((entry) => {
    entry.isBidirectional = outflowAddresses.has(entry.realAddress);
    txHashesMap.set(entry.address, entry.txHashes);
    txHashesMap.set(entry.realAddress, entry.txHashes);
  });

  outflows.forEach((entry) => {
    entry.isSelfTransfer = entry.realAddress === normTargetAddr;
    entry.isBidirectional = inflowAddresses.has(entry.realAddress);
    const prev = txHashesMap.get(entry.realAddress) || [];
    const merged = Array.from(new Set([...prev, ...entry.txHashes]));
    txHashesMap.set(entry.address, merged);
    txHashesMap.set(entry.realAddress, merged);
  });

  return {
    inflows,
    outflows,
    allInflowsCount,
    allOutflowsCount,
    addressToAliasMap,
    txHashesMap
  };
}

// ============================================================================
// Main Orchestration: go(), History, & KPI Strip
// ============================================================================

function go() {
  const targetAddress = input.value.trim();
  if (!targetAddress) return;
  const limit = resultLimitSlider.value;
  updateLocationHash();
  generateDataAndDrawDiagram(targetAddress, limit);
}

async function generateDataAndDrawDiagram(tezosAddress, limit) {
  currentAddress = tezosAddress;
  const result = await fetchAllData(tezosAddress, limit);

  const loaderEl = document.getElementById('loader');
  if (loaderEl) loaderEl.style.display = 'none';

  const hasXtzOps = result?.operations && result.operations.length > 0;
  const hasFaOps = result?.faTransfers && result.faTransfers.length > 0;
  const apiError = result?.apiError || null;

  if (!result || (!hasXtzOps && !hasFaOps)) {
    const emptyState = document.getElementById('empty-state');
    if (apiError) {
      const status = apiError.status;
      const indexerName = apiError.source || (isEtherlinkAddress(tezosAddress) ? 'Blockscout' : 'TzKT');
      if (apiError.isClientError) {
        showNotification(`Invalid address or bad request (${indexerName} HTTP ${status})`);
        if (emptyState) {
          emptyState.style.display = 'block';
          emptyState.querySelector('h2').textContent = `Invalid Request (HTTP ${status})`;
          emptyState.querySelector('p').textContent = `"${tezosAddress}" was rejected by the ${indexerName} indexer (HTTP ${status}). Verify that the Tezos (tz1/tz2/tz3/tz4/KT1) or Etherlink (0x) address is valid.`;
        }
      } else {
        const statusLabel = status === 429 ? 'HTTP 429 Rate Limit' : status ? `HTTP ${status}` : 'Network Error';
        showNotification(`${indexerName} indexer error (${statusLabel}) — please try again`);
        if (emptyState) {
          emptyState.style.display = 'block';
          emptyState.querySelector('h2').textContent = `${indexerName} Indexer Unavailable (${statusLabel})`;
          emptyState.querySelector('p').textContent = `The ${indexerName} API encountered a temporary server or network error (${statusLabel}) after automatic retries. Click Analyze to try again.`;
        }
      }
      return;
    }

    showNotification('No operations found for this address');
    if (emptyState) {
      emptyState.style.display = 'block';
      emptyState.querySelector('h2').textContent = 'No Value Flows Found';
      emptyState.querySelector('p').textContent = viewConfig.faEnabled
        ? `No applied XTZ, tzBTC, or USDt operations were found for "${tezosAddress}". Check the address or try another wallet or contract.`
        : `No applied XTZ operations were found for "${tezosAddress}". Try enabling the FA Tokens switch (tzBTC / USDt) or check another address.`;
    }
    return;
  }

  if (apiError) {
    const indexerName = apiError.source || (isEtherlinkAddress(tezosAddress) ? 'Blockscout' : 'TzKT');
    const statusLabel = apiError.status ? `HTTP ${apiError.status}` : 'Network Error';
    showNotification(`${indexerName} API error (${statusLabel}) — showing partial flow data`);
  }

  currentRawData = result.operations || [];
  currentFaData = result.faTransfers || [];
  currentAccountInfo = result.accountInfo;

  if (historyIndex === -1 || history[historyIndex] !== tezosAddress) {
    updateHistory(tezosAddress);
  }

  refreshDiagramFromMemory();
}

function refreshDiagramFromMemory() {
  const tezLimitVal = tezLimitSlider.value;
  currentParsed = parseTransactions(currentRawData, currentFaData, currentAddress, tezLimitVal);

  const { inflows, outflows, addressToAliasMap } = currentParsed;
  if (currentAccountInfo?.alias) {
    addressToAliasMap.set(currentAddress, currentAccountInfo.alias);
  }

  const totalAnalyzedOps =
    (viewConfig.enabledTokens.has('xtz') ? currentRawData.length : 0) +
    (viewConfig.faEnabled ? currentFaData.length : 0);

  updateStatsStrip(currentAddress, inflows, outflows, totalAnalyzedOps, currentAccountInfo);

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('stats-strip').style.display = 'grid';
  document.getElementById('sankey-workspace').style.display = 'flex';
  document.getElementById('sankey-diagram').style.display = 'block';

  renderCurrentSankey();
}

function computeTokenTotalsMap(entries) {
  const map = new Map();
  entries.forEach((e) => {
    if (Array.isArray(e.tokenFlows)) {
      e.tokenFlows.forEach((tf) => {
        map.set(tf.tokenKey, (map.get(tf.tokenKey) || 0) + (tf.amount || 0));
      });
    } else {
      const tk = e.tokenKey || 'xtz';
      map.set(tk, (map.get(tk) || 0) + (e.amount || 0));
    }
  });
  return map;
}

function formatMultiTokenSummaryPlain(totalsMap, compact = true) {
  const activeOrder = ALL_TOKEN_ORDER.filter((tk) => viewConfig.enabledTokens.has(tk));
  const parts = [];
  activeOrder.forEach((tk) => {
    const val = totalsMap.get(tk) || 0;
    if (val > 0 || activeOrder.length === 1) {
      parts.push(formatTokenAmount(val, tk, compact));
    }
  });
  if (parts.length === 0) {
    const firstTk = activeOrder[0] || 'xtz';
    return formatTokenAmount(0, firstTk, compact);
  }
  return parts.join(' • ');
}

function updateStatsStrip(targetAddress, inflows, outflows, opsCount, accountInfo) {
  const externalInflows = inflows.filter((e) => !e.isSelfTransfer);
  const externalOutflows = outflows.filter((e) => !e.isSelfTransfer);
  const selfEntries = outflows.filter((o) => o.isSelfTransfer);

  const numInflows = externalInflows.length;
  const txInflows = externalInflows.reduce((sum, e) => sum + (e.count || 0), 0);

  const numOutflows = externalOutflows.length;
  const txOutflows = externalOutflows.reduce((sum, e) => sum + (e.count || 0), 0);

  const inByToken = computeTokenTotalsMap(externalInflows);
  const outByToken = computeTokenTotalsMap(externalOutflows);

  const amXtzIn = inByToken.get('xtz') || 0;
  const amXtzOut = outByToken.get('xtz') || 0;
  console.log(
    `inputs:${numInflows}; outputs:${numOutflows}\r\nin:${amXtzIn.toFixed(2)}; out:${amXtzOut.toFixed(2)}`
  );

  const inValEl = document.getElementById('stat-inflow-val');
  const outValEl = document.getElementById('stat-outflow-val');
  const netEl = document.getElementById('stat-net-val');

  const isSingleXtzMode =
    !viewConfig.faEnabled && viewConfig.enabledTokens.size === 1 && viewConfig.enabledTokens.has('xtz');

  if (isSingleXtzMode) {
    const netFlow = amXtzIn - amXtzOut;
    const netSign = netFlow > 0 ? '+' : '';
    inValEl.textContent = formatTez(amXtzIn);
    outValEl.textContent = formatTez(amXtzOut);
    netEl.textContent = `${netSign}${formatTez(netFlow)}`;
    netEl.style.color = netFlow >= 0 ? 'var(--inflow-light)' : 'var(--outflow-light)';
  } else {
    const activeTokens = ALL_TOKEN_ORDER.filter((tk) => viewConfig.enabledTokens.has(tk));
    const renderChips = (mode) => {
      const chips = [];
      activeTokens.forEach((tk) => {
        const inAmt = inByToken.get(tk) || 0;
        const outAmt = outByToken.get(tk) || 0;
        if (inAmt === 0 && outAmt === 0 && activeTokens.length > 1 && tk !== 'xtz') return;
        let text = '';
        if (mode === 'in') {
          text = `+${formatTokenAmount(inAmt, tk, true)}`;
        } else if (mode === 'out') {
          text = `-${formatTokenAmount(outAmt, tk, true)}`;
        } else {
          const net = inAmt - outAmt;
          const sign = net > 0 ? '+' : '';
          text = `${sign}${formatTokenAmount(net, tk, true)}`;
        }
        chips.push(`<span class="stat-token-chip ${tk}">${escapeHtml(text)}</span>`);
      });
      if (chips.length === 0) {
        const fallbackTk = activeTokens[0] || 'xtz';
        chips.push(
          `<span class="stat-token-chip ${fallbackTk}">${escapeHtml(formatTokenAmount(0, fallbackTk, true))}</span>`
        );
      }
      return `<div class="stat-token-breakdown">${chips.join('')}</div>`;
    };

    inValEl.innerHTML = renderChips('in');
    outValEl.innerHTML = renderChips('out');
    netEl.innerHTML = renderChips('net');
    netEl.style.color = '';
  }

  document.getElementById('stat-inflow-meta').textContent = `${numInflows.toLocaleString()} senders • ${txInflows.toLocaleString()} transfers`;
  document.getElementById('stat-outflow-meta').textContent = `${numOutflows.toLocaleString()} receivers • ${txOutflows.toLocaleString()} transfers`;

  const balParts = [];
  if (accountInfo && typeof accountInfo.balance === 'number' && viewConfig.enabledTokens.has('xtz')) {
    balParts.push(formatTez(accountInfo.balance / 1_000_000, true));
  }
  if (viewConfig.faEnabled && accountInfo?.tokenBalances) {
    FA_TOKEN_KEYS.forEach((tk) => {
      if (viewConfig.enabledTokens.has(tk)) {
        const b = accountInfo.tokenBalances[tk] || 0;
        if (b > 0) balParts.push(formatTokenAmount(b, tk, true));
      }
    });
  }
  document.getElementById('stat-net-meta').textContent =
    balParts.length > 0 ? `Live bal: ${balParts.join(' • ')}` : 'Filtered net delta';

  document.getElementById('stat-scope-val').textContent = `${opsCount.toLocaleString()} ops`;
  const biCount = externalInflows.filter((i) => i.isBidirectional).length;
  const multiTokenNodes = [...externalInflows, ...externalOutflows].filter(
    (e) => e.tokenFlows && e.tokenFlows.length > 1
  ).length;
  const metaParts = [];
  if (viewConfig.faEnabled) {
    const activeTickers = ALL_TOKEN_ORDER
      .filter((k) => viewConfig.enabledTokens.has(k))
      .map((k) => TOKEN_DEFINITIONS[k].ticker)
      .join(' + ');
    metaParts.push(activeTickers);
  }
  if (multiTokenNodes > 0) metaParts.push(`${multiTokenNodes} multi-token node${multiTokenNodes > 1 ? 's' : ''}`);
  if (biCount > 0) metaParts.push(`${biCount} bidirectional (⇄)`);
  if (selfEntries.length > 0) {
    const selfCount = selfEntries.reduce((s, e) => s + e.count, 0);
    metaParts.push(`${selfCount} self-tx (↺)`);
  }
  document.getElementById('stat-scope-meta').textContent =
    metaParts.length > 0 ? metaParts.join(' • ') : 'Click any node to copy & pivot';
}

// ============================================================================
// High-Readability Custom SVG Sankey Diagram Engine (Multi-Ribbon Unified Nodes)
// ============================================================================

function renderCurrentSankey() {
  if (!currentParsed) return;
  drawSankeyDiagram(
    currentAddress,
    currentParsed.inflows,
    currentParsed.outflows,
    currentParsed.addressToAliasMap,
    currentParsed.txHashesMap
  );
}

function sortAndGroupFlows(entries, side, totalByTokenMap, totalEquivTez) {
  const query = viewConfig.searchQuery;
  let filtered = entries;
  if (query) {
    filtered = entries.filter(
      (e) =>
        e.realAddress.toLowerCase().includes(query) ||
        (e.alias && e.alias.toLowerCase().includes(query)) ||
        (e.tokenTicker && e.tokenTicker.toLowerCase().includes(query))
    );
  }

  const multiTokenActive = viewConfig.enabledTokens.size > 1;

  const sorted = [...filtered].sort((a, b) => {
    if (
      viewConfig.circularFlows &&
      side === 'in' &&
      !a.isSpecial &&
      !b.isSpecial &&
      a.isBidirectional !== b.isBidirectional
    ) {
      return a.isBidirectional ? -1 : 1;
    }
    if (viewConfig.sortMode === 'count') {
      return b.count - a.count || b.equivalentTez - a.equivalentTez;
    }
    if (viewConfig.sortMode === 'recent') {
      return b.dateRange.end.getTime() - a.dateRange.end.getTime();
    }
    if (multiTokenActive) {
      return b.equivalentTez - a.equivalentTez;
    }
    return b.amount - a.amount;
  });

  const enrichItem = (item) => {
    const clonedFlows = (item.tokenFlows || []).map((tf) => {
      const tkTotal = totalByTokenMap.get(tf.tokenKey) || 0;
      return {
        ...tf,
        sharePct: tkTotal > 0 ? (tf.amount / tkTotal) * 100 : 0
      };
    });
    const singleTkTotal = totalByTokenMap.get(item.tokenKey || 'xtz') || 0;
    const sharePct =
      clonedFlows.length === 1
        ? clonedFlows[0].sharePct
        : totalEquivTez > 0
        ? (item.equivalentTez / totalEquivTez) * 100
        : singleTkTotal > 0
        ? (item.amount / singleTkTotal) * 100
        : 0;

    return {
      ...item,
      tokenFlows: clonedFlows,
      sharePct,
      isAggregate: false
    };
  };

  const maxN = viewConfig.maxNodes || 50;
  if (sorted.length <= maxN) {
    return sorted.map(enrichItem);
  }

  const topItems = sorted.slice(0, maxN).map(enrichItem);
  const restItems = sorted.slice(maxN);

  // Combine remaining counterparties into a single unified aggregate node with per-token sub-flows!
  const aggTokenMap = new Map();
  let restCount = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const restHashes = [];

  for (let i = 0; i < restItems.length; i++) {
    const e = restItems[i];
    restCount += e.count;
    const sTime = e.dateRange.start.getTime();
    const eTime = e.dateRange.end.getTime();
    if (sTime < minTs) minTs = sTime;
    if (eTime > maxTs) maxTs = eTime;
    if (restHashes.length < 200 && e.txHashes) {
      for (let j = 0; j < e.txHashes.length && restHashes.length < 200; j++) {
        restHashes.push(e.txHashes[j]);
      }
    }
    (e.tokenFlows || []).forEach((tf) => {
      let cur = aggTokenMap.get(tf.tokenKey);
      if (!cur) {
        cur = {
          tokenKey: tf.tokenKey,
          tokenSymbol: tf.tokenSymbol,
          tokenTicker: tf.tokenTicker,
          tokenContract: tf.tokenContract,
          amount: 0,
          equivalentTez: 0,
          count: 0,
          txHashes: [],
          isSpecial: false
        };
        aggTokenMap.set(tf.tokenKey, cur);
      }
      cur.amount += tf.amount;
      cur.equivalentTez += tf.equivalentTez;
      cur.count += tf.count;
    });
  }

  const aggFlows = ALL_TOKEN_ORDER
    .filter((tk) => aggTokenMap.has(tk))
    .map((tk) => {
      const tf = aggTokenMap.get(tk);
      const tkTotal = totalByTokenMap.get(tk) || 0;
      tf.sharePct = tkTotal > 0 ? (tf.amount / tkTotal) * 100 : 0;
      return tf;
    });

  const restEquivTez = aggFlows.reduce((s, tf) => s + tf.equivalentTez, 0);
  const primaryAggTf = aggFlows[0] || {
    tokenKey: 'xtz',
    tokenSymbol: 'ꜩ',
    tokenTicker: 'XTZ',
    amount: 0
  };
  const minDate = new Date(minTs === Infinity ? Date.now() : minTs);
  const maxDate = new Date(maxTs === -Infinity ? Date.now() : maxTs);
  const aggLabel = `+ ${restItems.length} smaller ${side === 'in' ? 'senders' : 'receivers'}`;

  topItems.push({
    flowKey: `__aggregate_${side}__`,
    realAddress: `__aggregate_${side}__`,
    alias: aggLabel,
    address: aggLabel,
    tokenKey: primaryAggTf.tokenKey,
    tokenSymbol: primaryAggTf.tokenSymbol,
    tokenTicker: aggFlows.map((tf) => tf.tokenTicker).join(' + '),
    tokenFlows: aggFlows,
    amount: aggFlows.length === 1 ? primaryAggTf.amount : restEquivTez,
    equivalentTez: restEquivTez,
    count: restCount,
    dateRange: { start: minDate, end: maxDate },
    txHashes: restHashes,
    sharePct:
      aggFlows.length === 1
        ? primaryAggTf.sharePct
        : totalEquivTez > 0
        ? (restEquivTez / totalEquivTez) * 100
        : 0,
    isSpecial: false,
    isBidirectional: false,
    isAggregate: true,
    hiddenCount: restItems.length
  });

  return topItems;
}

function computeScaledWeight(amount, scaleMode) {
  const v = Math.max(0.0001, amount);
  if (scaleMode === 'log') {
    return Math.log10(v + 1) + 0.5;
  }
  if (scaleMode === 'linear') {
    return v;
  }
  return Math.sqrt(v);
}

function getSubFlowScaleAmount(tf, multiTokenActive) {
  if (!tf) return 0.0001;
  return multiTokenActive ? Math.max(0.0001, tf.equivalentTez || tf.amount) : Math.max(0.0001, tf.amount);
}

function drawSankeyDiagram(targetAddress, rawInflows, rawOutflows, addressToAliasMap, txHashesMap) {
  const container = document.getElementById('sankey-diagram');
  if (!container) return;

  const multiTokenActive = viewConfig.enabledTokens.size > 1;
  const externalRawOutflows = rawOutflows.filter((e) => !e.isSelfTransfer);
  const totalInByToken = computeTokenTotalsMap(rawInflows);
  const totalOutByToken = computeTokenTotalsMap(externalRawOutflows);
  const totalInEquivTez = rawInflows.reduce((s, e) => s + (e.equivalentTez || 0), 0);
  const totalOutEquivTez = externalRawOutflows.reduce((s, e) => s + (e.equivalentTez || 0), 0);

  const inflows = sortAndGroupFlows(rawInflows, 'in', totalInByToken, totalInEquivTez);

  // If Circular Flows mode (↺) is active, match visible inflow counterparty nodes that also received ANY outflow from the Hub
  const rawOutflowMap = new Map(rawOutflows.map((o) => [o.realAddress, o]));
  const mergedCircularAddresses = new Set();
  let selfLoopEntry = null;

  if (viewConfig.circularFlows) {
    // 1. Check if the Hub sent funds to itself (Self-Transfer: Hub -> Hub)
    const rawSelf = rawOutflowMap.get(targetAddress);
    if (rawSelf && rawSelf.tokenFlows && rawSelf.tokenFlows.length > 0) {
      selfLoopEntry = {
        ...rawSelf,
        isSelfTransfer: true,
        sharePct: 100
      };
      mergedCircularAddresses.add(targetAddress);
    }

    // 2. Match visible inflow senders that received return funds (in 1, 2, or 3 tokens) from the Hub
    inflows.forEach((item) => {
      if (!item.isAggregate && item.realAddress !== targetAddress && rawOutflowMap.has(item.realAddress)) {
        const retEntry = rawOutflowMap.get(item.realAddress);
        if (retEntry && retEntry.tokenFlows && retEntry.tokenFlows.length > 0) {
          item.hasCircularReturn = true;
          item.returnEntry = retEntry;
          if ((!item.subBranches || item.subBranches.length === 0) && retEntry.subBranches?.length > 0) {
            item.subBranches = retEntry.subBranches;
          }
          item.returnTokenFlows = retEntry.tokenFlows.map((rtf) => {
            const outTkTotal = totalOutByToken.get(rtf.tokenKey) || 0;
            return {
              ...rtf,
              sharePct: outTkTotal > 0 ? (rtf.amount / outTkTotal) * 100 : 0
            };
          });
          item.returnAmount = retEntry.amount;
          item.returnEquivalentTez = retEntry.equivalentTez;
          item.returnCount = retEntry.count;
          mergedCircularAddresses.add(item.realAddress);
        }
      }
    });
  }

  const effectiveRawOutflows = viewConfig.circularFlows
    ? externalRawOutflows.filter((o) => !mergedCircularAddresses.has(o.realAddress))
    : rawOutflows;
  const outflows = sortAndGroupFlows(effectiveRawOutflows, 'out', totalOutByToken, totalOutEquivTez);

  const isL2Hub = isEtherlinkAddress(targetAddress);

  if (inflows.length === 0 && outflows.length === 0 && !selfLoopEntry) {
    container.innerHTML = `
      <div style="padding: 64px 24px; text-align: center; color: var(--text-secondary);">
        <i class="fa-solid fa-filter-circle-xmark" style="font-size: 2rem; color: var(--accent-primary); margin-bottom: 12px;"></i>
        <div style="font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">No counterparties match current filter</div>
        <div style="font-size: 0.85rem;">Try lowering the Min Flow (ꜩ) slider, enabling FA Tokens, or clearing the node search box.</div>
      </div>
    `;
    return;
  }

  // Geometry constants
  const containerWidth = Math.max(1140, container.clientWidth || 1280);
  const W = containerWidth;
  const padX = 24;
  const circularRibbonCount = inflows
    .filter((i) => i.hasCircularReturn)
    .reduce((s, i) => s + (i.returnTokenFlows?.length || 1), 0);
  const padYTop = circularRibbonCount > 0 ? Math.min(165, 68 + circularRibbonCount * 11) : 28;
  const padYBottom = circularRibbonCount > 0 ? Math.min(150, 56 + circularRibbonCount * 11) : 28;
  const cardW = Math.min(342, Math.max(316, Math.floor(W * 0.285)));
  const hubW = 238;

  const minCardH = 44;
  const maxExtraH = 42;
  const nodeGap = 9;

  // Compute weights for each sub-flow and node
  const allSubWeights = [];
  const collectSubWeights = (tfList) => {
    (tfList || []).forEach((tf) => {
      tf.weight = computeScaledWeight(getSubFlowScaleAmount(tf, multiTokenActive), viewConfig.scaleMode);
      allSubWeights.push(tf.weight);
    });
  };
  inflows.forEach((n) => {
    collectSubWeights(n.tokenFlows);
    if (n.hasCircularReturn) collectSubWeights(n.returnTokenFlows);
  });
  outflows.forEach((n) => collectSubWeights(n.tokenFlows));
  if (selfLoopEntry) collectSubWeights(selfLoopEntry.tokenFlows);

  let maxWeight = 0.0001;
  for (let i = 0; i < allSubWeights.length; i++) {
    if (allSubWeights[i] > maxWeight) maxWeight = allSubWeights[i];
  }

  function layoutColumn(items, xPos) {
    let curY = padYTop;
    const laidOut = items.map((item, idx) => {
      const subFlows = item.tokenFlows || [];
      const retFlows = item.hasCircularReturn ? item.returnTokenFlows || [] : [];
      const totalNodeWeight = subFlows.reduce((s, tf) => s + (tf.weight || 0), 0);
      const totalRetWeight = retFlows.reduce((s, tf) => s + (tf.weight || 0), 0);
      const norm = Math.min(1.35, totalNodeWeight / maxWeight);

      const baseH = Math.round(minCardH + Math.min(1, norm) * maxExtraH);
      // Add vertical height when a single counterparty node has multiple token flows or circular returns
      const totalMetricLines = subFlows.length + retFlows.length;
      const multiLineMinH = totalMetricLines > 1 ? 26 + totalMetricLines * 15 : minCardH;
      const circMinH = item.hasCircularReturn ? 60 + Math.max(0, totalMetricLines - 2) * 14 : minCardH;
      const h = Math.max(baseH, multiLineMinH, circMinH);

      subFlows.forEach((tf) => {
        tf.normWeight = (tf.weight || 0) / maxWeight;
      });
      retFlows.forEach((rtf) => {
        rtf.normWeight = (rtf.weight || 0) / maxWeight;
      });

      const allBranches = !item.isAggregate && Array.isArray(item.subBranches) ? item.subBranches : [];
      const isBranchesExpanded = viewConfig.expandedBranchNodes?.has(item.realAddress);
      const canCollapseBranches = allBranches.length > 6;
      const visibleBranches =
        !canCollapseBranches || isBranchesExpanded ? allBranches : allBranches.slice(0, 5);
      const hiddenBranchCount = Math.max(0, allBranches.length - visibleBranches.length);
      const totalBranchRows = visibleBranches.length + (canCollapseBranches ? 1 : 0);
      const branchZoneH =
        totalBranchRows > 0 ? 5 + totalBranchRows * 22 + (totalBranchRows - 1) * 4 : 0;

      const node = {
        ...item,
        index: idx,
        x: xPos,
        y: curY,
        w: cardW,
        h,
        visibleBranches,
        hiddenBranchCount,
        canCollapseBranches,
        isBranchesExpanded: Boolean(isBranchesExpanded),
        branchZoneH,
        weight: totalNodeWeight,
        normWeight: Math.min(1, norm),
        returnWeight: totalRetWeight
      };
      curY += h + branchZoneH + nodeGap;
      return node;
    });
    const totalColH = laidOut.length > 0 ? curY - nodeGap - padYTop : 0;
    return { nodes: laidOut, totalColH };
  }

  const leftCol = layoutColumn(inflows, padX);
  const rightCol = layoutColumn(outflows, W - padX - cardW);

  const contentH = Math.max(leftCol.totalColH, rightCol.totalColH, 360);
  const H = contentH + padYTop + padYBottom;

  const circularNodes = leftCol.nodes.filter((n) => n.hasCircularReturn);
  if (selfLoopEntry) {
    selfLoopEntry.weight = (selfLoopEntry.tokenFlows || []).reduce((s, tf) => s + (tf.weight || 0), 0);
  }

  const totalLeftRibbonCount =
    leftCol.nodes.reduce((s, n) => s + (n.tokenFlows?.length || 1), 0) + (selfLoopEntry ? 1 : 0);
  const totalRightRibbonCount =
    rightCol.nodes.reduce((s, n) => s + (n.tokenFlows?.length || 1), 0) +
    circularNodes.reduce((s, n) => s + (n.returnTokenFlows?.length || 1), 0) +
    (selfLoopEntry ? 1 : 0);

  const leftTotalWeight =
    leftCol.nodes.reduce((s, n) => s + n.weight, 0) + (selfLoopEntry ? selfLoopEntry.weight : 0) || 1;
  const rightTotalWeight =
    rightCol.nodes.reduce((s, n) => s + n.weight, 0) +
      circularNodes.reduce((s, n) => s + n.returnWeight, 0) +
      (selfLoopEntry ? selfLoopEntry.weight : 0) || 1;

  const leftGap = totalLeftRibbonCount > 40 ? 0.8 : 1.4;
  const rightGap = totalRightRibbonCount > 40 ? 0.8 : 1.4;

  const targetLeftSpan = Math.min(360, Math.max(80, totalLeftRibbonCount * 7));
  const targetRightSpan = Math.min(360, Math.max(80, totalRightRibbonCount * 7));

  if (selfLoopEntry) {
    selfLoopEntry.portThickness = Math.max(
      3.5,
      Math.min(18, (selfLoopEntry.weight / rightTotalWeight) * targetRightSpan)
    );
  }

  leftCol.nodes.forEach((n) => {
    (n.tokenFlows || []).forEach((tf) => {
      tf.portThickness = Math.max(2.2, ((tf.weight || 0) / leftTotalWeight) * targetLeftSpan);
    });
    if (n.hasCircularReturn) {
      (n.returnTokenFlows || []).forEach((rtf) => {
        rtf.returnPortThickness = Math.max(2.4, ((rtf.weight || 0) / rightTotalWeight) * targetRightSpan);
      });
    }
  });

  rightCol.nodes.forEach((n) => {
    (n.tokenFlows || []).forEach((tf) => {
      tf.portThickness = Math.max(2.2, ((tf.weight || 0) / rightTotalWeight) * targetRightSpan);
    });
  });

  const leftPortSpan =
    leftCol.nodes.reduce(
      (s, n) => s + (n.tokenFlows || []).reduce((ts, tf) => ts + tf.portThickness, 0),
      0
    ) +
    (selfLoopEntry ? selfLoopEntry.portThickness : 0) +
    Math.max(0, totalLeftRibbonCount - 1) * leftGap;

  const rightPortSpan =
    rightCol.nodes.reduce(
      (s, n) => s + (n.tokenFlows || []).reduce((ts, tf) => ts + tf.portThickness, 0),
      0
    ) +
    circularNodes.reduce(
      (s, n) => s + (n.returnTokenFlows || []).reduce((ts, rtf) => ts + rtf.returnPortThickness, 0),
      0
    ) +
    (selfLoopEntry ? selfLoopEntry.portThickness : 0) +
    Math.max(0, totalRightRibbonCount - 1) * rightGap;

  const activeTokensInHub = ALL_TOKEN_ORDER.filter(
    (tk) => viewConfig.enabledTokens.has(tk) && ((totalInByToken.get(tk) || 0) > 0 || (totalOutByToken.get(tk) || 0) > 0)
  );
  const extraHubRowsH = Math.max(0, activeTokensInHub.length - 1) * 34;
  const hubCardH = Math.max(238 + extraHubRowsH, Math.max(leftPortSpan, rightPortSpan) + 44);
  const hubX = (W - hubW) / 2;

  const hubCenterY = Math.min(
    H - padYBottom - hubCardH / 2 - 10,
    Math.max(padYTop + hubCardH / 2 + 12, Math.min(360 + padYTop / 2, H / 2))
  );
  const hubY = hubCenterY - hubCardH / 2;

  function alignColumnVertically(col) {
    if (col.nodes.length === 0) return;
    if (col.totalColH >= contentH - 4) return;
    const idealTop = hubCenterY - col.totalColH / 2;
    const clampedTop = Math.max(padYTop, Math.min(H - padYBottom - col.totalColH, idealTop));
    const deltaY = clampedTop - padYTop;
    col.nodes.forEach((n) => (n.y += deltaY));
  }

  alignColumnVertically(leftCol);
  alignColumnVertically(rightCol);

  // Helper to allocate non-overlapping vertical port slots on a node card's edge for 1..3 token ribbons
  function assignNodeEdgeSlots(flowList, zoneTopY, zoneBottomY) {
    const count = flowList.length;
    if (count === 0) return;
    const zoneH = Math.max(8, zoneBottomY - zoneTopY);
    const subGap = count > 1 ? 2.2 : 0;
    const availH = Math.max(count * 3.2, zoneH - (count - 1) * subGap);
    const totalW = flowList.reduce((s, f) => s + (f.weight || 1), 0) || 1;

    // Desired total ribbon span inside the zone
    const maxAvgNorm = Math.max(...flowList.map((f) => f.normWeight || 0.2));
    const targetSpan = Math.min(availH, Math.max(count * 4.2, availH * (0.38 + 0.56 * maxAvgNorm)));
    const totalSpanWithGaps = targetSpan + (count - 1) * subGap;
    let curY = zoneTopY + (zoneH - totalSpanWithGaps) / 2;

    flowList.forEach((f) => {
      const share = (f.weight || 1) / totalW;
      const ribH = Math.max(3.2, share * targetSpan);
      f.nodeY0 = curY;
      f.nodeY1 = curY + ribH;
      curY += ribH + subGap;
    });
  }

  // Assign Left Inflow ribbon endpoints (supporting multiple token ribbons per node!)
  let curLeftPortY = hubCenterY - leftPortSpan / 2;
  if (selfLoopEntry) {
    selfLoopEntry.targetY0 = curLeftPortY;
    selfLoopEntry.targetY1 = curLeftPortY + selfLoopEntry.portThickness;
    curLeftPortY += selfLoopEntry.portThickness + leftGap;
  }

  leftCol.nodes.forEach((n) => {
    const inFlows = n.tokenFlows || [];
    if (n.hasCircularReturn) {
      const retFlows = n.returnTokenFlows || [];
      const splitY = n.y + n.h * (inFlows.length >= retFlows.length ? 0.54 : 0.46);
      assignNodeEdgeSlots(inFlows, n.y + 5, splitY - 2);
      assignNodeEdgeSlots(retFlows, splitY + 2, n.y + n.h - 5);
      retFlows.forEach((rtf) => {
        const retRibH = rtf.nodeY1 - rtf.nodeY0;
        rtf.circRibbonThickness = Math.max(3, (retRibH + rtf.returnPortThickness) / 2);
      });
    } else {
      assignNodeEdgeSlots(inFlows, n.y + 5, n.y + n.h - 5);
    }

    inFlows.forEach((tf) => {
      tf.hubY0 = curLeftPortY;
      tf.hubY1 = curLeftPortY + tf.portThickness;
      curLeftPortY += tf.portThickness + leftGap;
    });
  });

  // Partition circular nodes into top loops (above Hub center) and bottom loops (below Hub center)
  const topCircularNodes = circularNodes.filter((n) => n.y + n.h / 2 <= hubCenterY);
  const bottomCircularNodes = circularNodes.filter((n) => n.y + n.h / 2 > hubCenterY);

  // Assign Hub Right Outflow Port Rail: [selfLoopEntry, topCircularNodes, rightCol.nodes, bottomCircularNodes]
  let curRightPortY = hubCenterY - rightPortSpan / 2;
  if (selfLoopEntry) {
    selfLoopEntry.sourceY0 = curRightPortY;
    selfLoopEntry.sourceY1 = curRightPortY + selfLoopEntry.portThickness;
    curRightPortY += selfLoopEntry.portThickness + rightGap;
  }

  // Count total top circular sub-ribbons for clean non-overlapping arch ordering
  const totalTopCircRibbons = topCircularNodes.reduce(
    (s, n) => s + (n.returnTokenFlows?.length || 1),
    0
  );
  let topCircCounter = 0;
  topCircularNodes.forEach((n) => {
    (n.returnTokenFlows || []).forEach((rtf) => {
      rtf.circSourceY0 = curRightPortY;
      rtf.circSourceY1 = curRightPortY + rtf.returnPortThickness;
      rtf.isTopLoop = true;
      rtf.loopOrder = totalTopCircRibbons - 1 - topCircCounter;
      topCircCounter++;
      curRightPortY += rtf.returnPortThickness + rightGap;
    });
  });

  rightCol.nodes.forEach((n) => {
    const outFlows = n.tokenFlows || [];
    assignNodeEdgeSlots(outFlows, n.y + 5, n.y + n.h - 5);
    outFlows.forEach((tf) => {
      tf.hubY0 = curRightPortY;
      tf.hubY1 = curRightPortY + tf.portThickness;
      curRightPortY += tf.portThickness + rightGap;
    });
  });

  let botCircCounter = 0;
  bottomCircularNodes.forEach((n) => {
    (n.returnTokenFlows || []).forEach((rtf) => {
      rtf.circSourceY0 = curRightPortY;
      rtf.circSourceY1 = curRightPortY + rtf.returnPortThickness;
      rtf.isTopLoop = false;
      rtf.loopOrder = botCircCounter;
      botCircCounter++;
      curRightPortY += rtf.returnPortThickness + rightGap;
    });
  });

  function buildRibbonPath(x0, y0Top, y0Bot, x1, y1Top, y1Bot) {
    const curvature = 0.46;
    const cx0 = x0 + (x1 - x0) * curvature;
    const cx1 = x1 - (x1 - x0) * curvature;
    return [
      `M ${x0} ${y0Top}`,
      `C ${cx0} ${y0Top}, ${cx1} ${y1Top}, ${x1} ${y1Top}`,
      `L ${x1} ${y1Bot}`,
      `C ${cx1} ${y1Bot}, ${cx0} ${y0Bot}, ${x0} ${y0Bot}`,
      'Z'
    ].join(' ');
  }

  function buildCenterlinePath(x0, y0Mid, x1, y1Mid) {
    const curvature = 0.46;
    const cx0 = x0 + (x1 - x0) * curvature;
    const cx1 = x1 - (x1 - x0) * curvature;
    return `M ${x0} ${y0Mid} C ${cx0} ${y0Mid}, ${cx1} ${y1Mid}, ${x1} ${y1Mid}`;
  }

  function buildCircularLoopPathForSubFlow(rtf) {
    const xStart = hubX + hubW;
    const yStart = (rtf.circSourceY0 + rtf.circSourceY1) / 2;
    const xEnd = padX + cardW;
    const yEnd = (rtf.nodeY0 + rtf.nodeY1) / 2;
    const order = rtf.loopOrder || 0;
    const selfClearance = selfLoopEntry ? 26 : 0;
    const apexX = hubX + hubW * 0.35;

    const apexY = rtf.isTopLoop
      ? Math.max(14, Math.min(hubY - 24 - selfClearance - order * 11, yEnd - 24))
      : Math.min(H - 14, Math.max(hubY + hubCardH + 22 + order * 11, yEnd + 24));

    const c1x = xStart + 54 + order * 11;
    const c1y = yStart;
    const c2x = apexX + 82;
    const c2y = apexY;

    const c3x = apexX - 88;
    const c3y = apexY;
    const c4x = xEnd + 66 + order * 9;
    const c4y = yEnd;

    return `M ${xStart} ${yStart} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${apexX} ${apexY} C ${c3x} ${c3y}, ${c4x} ${c4y}, ${xEnd} ${yEnd}`;
  }

  function buildSelfLoopPath(selfNode) {
    const xStart = hubX + hubW;
    const yStart = (selfNode.sourceY0 + selfNode.sourceY1) / 2;
    const xEnd = hubX;
    const yEnd = (selfNode.targetY0 + selfNode.targetY1) / 2;
    const apexX = hubX + hubW / 2;
    const apexY = Math.max(18, hubY - 24);

    return {
      pathD: [
        `M ${xStart} ${yStart}`,
        `C ${xStart + 46} ${yStart}, ${apexX + 64} ${apexY}, ${apexX} ${apexY}`,
        `C ${apexX - 64} ${apexY}, ${xEnd - 46} ${yEnd}, ${xEnd} ${yEnd}`
      ].join(' '),
      apexX,
      apexY
    };
  }

  // Build SVG markup (with distinct gradients for XTZ, tzBTC, and USDt flows)
  const defsMarkup = `
    <defs>
      <!-- Native XTZ Gradients -->
      <linearGradient id="grad-inflow" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0.85" />
        <stop offset="55%" stop-color="#06b6d4" stop-opacity="0.65" />
        <stop offset="100%" stop-color="#6366f1" stop-opacity="0.85" />
      </linearGradient>
      <linearGradient id="grad-special" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.9" />
        <stop offset="100%" stop-color="#6366f1" stop-opacity="0.85" />
      </linearGradient>
      <linearGradient id="grad-outflow" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#6366f1" stop-opacity="0.85" />
        <stop offset="45%" stop-color="#a855f7" stop-opacity="0.65" />
        <stop offset="100%" stop-color="#f43f5e" stop-opacity="0.85" />
      </linearGradient>
      <linearGradient id="grad-circular" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#ec4899" stop-opacity="0.8" />
        <stop offset="100%" stop-color="#a855f7" stop-opacity="0.9" />
      </linearGradient>

      <!-- tzBTC (KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn) Distinct Bitcoin Orange / Gold Gradients -->
      <linearGradient id="grad-inflow-tzbtc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#f7931a" stop-opacity="0.8" />
        <stop offset="100%" stop-color="#ea580c" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-tzbtc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#ea580c" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#f7931a" stop-opacity="0.8" />
        <stop offset="100%" stop-color="#fbbf24" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-tzbtc" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#ea580c" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#f7931a" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#fde047" stop-opacity="0.92" />
      </linearGradient>

      <!-- USDt (KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o / 0x2C03…) Distinct Electric Cyan / Sky Gradients -->
      <linearGradient id="grad-inflow-usdt" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.8" />
        <stop offset="100%" stop-color="#0284c7" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-usdt" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#0284c7" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.8" />
        <stop offset="100%" stop-color="#22d3ee" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-usdt" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#0284c7" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#67e8f9" stop-opacity="0.92" />
      </linearGradient>

      <!-- USDC (0x796Ea11Fa2dD751eD01b53C372fFDB4AAa8f00F9) USD Coin Blue Gradients -->
      <linearGradient id="grad-inflow-usdc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#3b82f6" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-usdc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#3b82f6" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-usdc" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#3b82f6" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#93c5fd" stop-opacity="0.92" />
      </linearGradient>

      <!-- WXTZ (0xc9B53AB2679f573e480d01e0f49e2B5CFB7a3EAb) Wrapped XTZ Indigo Gradients -->
      <linearGradient id="grad-inflow-wxtz" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#a5b4fc" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#6366f1" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#4338ca" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-wxtz" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#4338ca" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#6366f1" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#a5b4fc" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-wxtz" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#4338ca" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#6366f1" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#c7d2fe" stop-opacity="0.92" />
      </linearGradient>

      <!-- WETH (0xfc24f770F94edBca6D6f885E12d4317320BcB401) Bridged WETH Purple Gradients -->
      <linearGradient id="grad-inflow-weth" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#c084fc" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#a855f7" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#7e22ce" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-weth" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#7e22ce" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#a855f7" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#c084fc" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-weth" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#7e22ce" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#a855f7" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#e9d5ff" stop-opacity="0.92" />
      </linearGradient>

      <!-- LBTC (0xecAc9C5F704e954931349Da37F60E39f515c11c1) Lombard Staked Bitcoin Amber/Gold Gradients -->
      <linearGradient id="grad-inflow-lbtc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#fcd34d" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#d97706" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#92400e" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-lbtc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#92400e" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#d97706" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#fcd34d" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-lbtc" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#92400e" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#d97706" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#fde68a" stop-opacity="0.92" />
      </linearGradient>

      <!-- WBTC (0xbFc94CD2B1E55999Cfc7347a9313e88702B83d0F) Wrapped BTC Orange Gradients -->
      <linearGradient id="grad-inflow-wbtc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#fdba74" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#f97316" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#c2410c" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-wbtc" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#c2410c" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#f97316" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#fdba74" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-wbtc" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#c2410c" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#f97316" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#fed7aa" stop-opacity="0.92" />
      </linearGradient>

      <!-- xU3O8 (0x79052Ab3C166D4899a1e0DD033aC3b379AF0B1fD) Uranium Lime Gradients -->
      <linearGradient id="grad-inflow-xu3o8" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#bef264" stop-opacity="0.9" />
        <stop offset="50%" stop-color="#84cc16" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#4d7c0f" stop-opacity="0.88" />
      </linearGradient>
      <linearGradient id="grad-outflow-xu3o8" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#4d7c0f" stop-opacity="0.88" />
        <stop offset="50%" stop-color="#84cc16" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#bef264" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="grad-circular-xu3o8" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#4d7c0f" stop-opacity="0.92" />
        <stop offset="50%" stop-color="#84cc16" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#d9f99d" stop-opacity="0.92" />
      </linearGradient>

      <linearGradient id="grad-self-loop" x1="100%" y1="0%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.95" />
        <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.95" />
        <stop offset="100%" stop-color="#10b981" stop-opacity="0.95" />
      </linearGradient>
      <linearGradient id="grad-hub" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#1e1b4b" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
    </defs>
  `;

  // Render ribbons (multiple ribbons per counterparty node when multiple tokens are present!)
  const leftRibbonX0 = padX + cardW;
  const leftRibbonX1 = hubX;
  const rightRibbonX0 = hubX + hubW;
  const rightRibbonX1 = W - padX - cardW;

  const inflowLinksMarkup = leftCol.nodes
    .map((n) =>
      (n.tokenFlows || [])
        .map((tf) => {
          const tokenDef = TOKEN_DEFINITIONS[tf.tokenKey || 'xtz'] || TOKEN_DEFINITIONS.xtz;
          const d = buildRibbonPath(leftRibbonX0, tf.nodeY0, tf.nodeY1, leftRibbonX1, tf.hubY0, tf.hubY1);
          const centerD = buildCenterlinePath(
            leftRibbonX0,
            (tf.nodeY0 + tf.nodeY1) / 2,
            leftRibbonX1,
            (tf.hubY0 + tf.hubY1) / 2
          );
          const gradId = tf.isSpecial && tf.tokenKey === 'xtz' ? 'url(#grad-special)' : tokenDef.gradInflow;
          const strokeColor = tf.isSpecial && tf.tokenKey === 'xtz' ? '#f59e0b' : tokenDef.inflowColor;
          return `
            <g class="sankey-link-wrap" data-side="in" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}" data-flow-key="${escapeHtml(n.realAddress)}" data-token="${escapeHtml(tf.tokenKey)}">
              <path class="sankey-link sankey-ribbon-link" d="${d}" fill="${gradId}" fill-opacity="0.38" stroke="${strokeColor}" stroke-width="0.6" stroke-opacity="0.48" />
              <path class="sankey-link-flow" d="${centerD}" stroke-width="2" />
            </g>
          `;
        })
        .join('')
    )
    .join('');

  const circularLinksMarkup = circularNodes
    .map((n) =>
      (n.returnTokenFlows || [])
        .map((rtf) => {
          const tokenDef = TOKEN_DEFINITIONS[rtf.tokenKey || 'xtz'] || TOKEN_DEFINITIONS.xtz;
          const loopD = buildCircularLoopPathForSubFlow(rtf);
          const strokeW = Math.max(3.5, Math.min(22, rtf.circRibbonThickness || 6)).toFixed(1);
          return `
            <g class="sankey-link-wrap sankey-circular-wrap" data-side="in" data-circular="true" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}" data-flow-key="${escapeHtml(n.realAddress)}" data-token="${escapeHtml(rtf.tokenKey)}">
              <path class="sankey-link sankey-circular-link" d="${loopD}" fill="none" stroke="${tokenDef.gradCircular}" stroke-width="${strokeW}" stroke-opacity="0.52" stroke-linecap="butt" />
              <path class="sankey-link-flow" d="${loopD}" stroke-width="2" />
            </g>
          `;
        })
        .join('')
    )
    .join('');

  let selfLoopMarkup = '';
  if (selfLoopEntry) {
    const { pathD, apexX, apexY } = buildSelfLoopPath(selfLoopEntry);
    const strokeW = Math.max(4, Math.min(18, selfLoopEntry.portThickness || 6)).toFixed(1);
    const selfParts = (selfLoopEntry.tokenFlows || []).map((tf) => formatTokenAmount(tf.amount, tf.tokenKey, true));
    const pillLabel = `↺ Self: ${selfParts.join(' • ')} (${selfLoopEntry.count})`;
    const pillW = Math.max(114, pillLabel.length * 6.4 + 18);
    selfLoopMarkup = `
      <g class="sankey-link-wrap sankey-self-loop-wrap" id="sankey-self-loop" data-side="self" data-circular="true" data-index="-1" data-addr="${escapeHtml(targetAddress)}" data-flow-key="${escapeHtml(targetAddress)}" style="cursor: pointer;">
        <path class="sankey-link sankey-circular-link sankey-self-link" d="${pathD}" fill="none" stroke="url(#grad-self-loop)" stroke-width="${strokeW}" stroke-opacity="0.58" stroke-linecap="butt" />
        <path class="sankey-link-flow" d="${pathD}" stroke-width="2.2" />
        <rect x="${apexX - pillW / 2}" y="${apexY - 11}" width="${pillW}" height="20" rx="10"
              fill="rgba(15, 23, 42, 0.92)" stroke="#38bdf8" stroke-width="1" />
        <text x="${apexX}" y="${apexY + 3}" text-anchor="middle" fill="#e0f2fe" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600">
          ${escapeHtml(pillLabel)}
        </text>
      </g>
    `;
  }

  const outflowLinksMarkup = rightCol.nodes
    .map((n) =>
      (n.tokenFlows || [])
        .map((tf) => {
          const tokenDef = TOKEN_DEFINITIONS[tf.tokenKey || 'xtz'] || TOKEN_DEFINITIONS.xtz;
          const d = buildRibbonPath(rightRibbonX0, tf.hubY0, tf.hubY1, rightRibbonX1, tf.nodeY0, tf.nodeY1);
          const centerD = buildCenterlinePath(
            rightRibbonX0,
            (tf.hubY0 + tf.hubY1) / 2,
            rightRibbonX1,
            (tf.nodeY0 + tf.nodeY1) / 2
          );
          return `
            <g class="sankey-link-wrap" data-side="out" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}" data-flow-key="${escapeHtml(n.realAddress)}" data-token="${escapeHtml(tf.tokenKey)}">
              <path class="sankey-link sankey-ribbon-link" d="${d}" fill="${tokenDef.gradOutflow}" fill-opacity="0.38" stroke="${tokenDef.outflowColor}" stroke-width="0.6" stroke-opacity="0.48" />
              <path class="sankey-link-flow" d="${centerD}" stroke-width="2" />
            </g>
          `;
        })
        .join('')
    )
    .join('');

  // Render Unified Node Card (supports 1, 2, or 3 token flows + circular returns on a single card!)
  function renderNodeCard(n, side) {
    const isLeft = side === 'in';
    const inFlows = n.tokenFlows || [];
    const retFlows = n.hasCircularReturn ? n.returnTokenFlows || [] : [];
    const primaryTf = inFlows[0] || { tokenKey: 'xtz', sharePct: 0, amount: 0 };
    const primaryDef = TOKEN_DEFINITIONS[primaryTf.tokenKey] || TOKEN_DEFINITIONS.xtz;

    const getFlowTextColor = (tk, isReturn = false) => {
      const def = TOKEN_DEFINITIONS[tk] || TOKEN_DEFINITIONS.xtz;
      if (isReturn) return tk === 'xtz' ? '#f472b6' : def.returnTextColor;
      if (tk !== 'xtz') return isLeft ? def.inflowLight : def.outflowLight;
      return n.isSpecial ? '#f59e0b' : isLeft ? '#10b981' : '#f43f5e';
    };

    const getPortSegmentColor = (tk, isReturn = false) => {
      const def = TOKEN_DEFINITIONS[tk] || TOKEN_DEFINITIONS.xtz;
      if (isReturn) return def.returnColor;
      if (tk !== 'xtz') return def.inflowColor;
      return n.isSpecial ? '#f59e0b' : isLeft ? '#10b981' : '#f43f5e';
    };

    const shareBarW = Math.max(4, Math.min(n.w - 12, (n.sharePct / 100) * (n.w - 12)));
    const allNodeTokenKeys = Array.from(
      new Set([...inFlows.map((tf) => tf.tokenKey), ...retFlows.map((rtf) => rtf.tokenKey)])
    );
    const hasFaOnNode = allNodeTokenKeys.some((tk) => tk !== 'xtz');
    const showTokenTags = viewConfig.faEnabled || hasFaOnNode;

    const biBadge = n.isSelfTransfer
      ? ' ↺'
      : n.hasCircularReturn
      ? ' ↺'
      : n.isBidirectional
      ? ' ⇄'
      : '';

    const tagPlain = showTokenTags
      ? ` [${allNodeTokenKeys.map((tk) => (TOKEN_DEFINITIONS[tk] || TOKEN_DEFINITIONS.xtz).ticker).join('·')}]`
      : '';
    const suffixLen = tagPlain.length + biBadge.length;
    const maxTitleChars = Math.max(8, 22 - Math.ceil(suffixLen * 0.78));
    const rawBaseTitle = n.alias
      ? n.alias
      : suffixLen >= 10
      ? compactAddress(n.realAddress)
      : shortenAddress(n.realAddress);
    const primaryTitle = truncateText(rawBaseTitle, maxTitleChars);

    const tokenTagsMarkup = showTokenTags
      ? `<tspan fill="#64748b" font-size="9.2" font-family="JetBrains Mono, monospace"> [</tspan>` +
        allNodeTokenKeys
          .map((tk) => {
            const def = TOKEN_DEFINITIONS[tk] || TOKEN_DEFINITIONS.xtz;
            return `<tspan fill="${def.badgeText}" font-size="9.2" font-family="JetBrains Mono, monospace">${escapeHtml(def.ticker)}</tspan>`;
          })
          .join('<tspan fill="#64748b" font-size="9.2" font-family="JetBrains Mono, monospace">·</tspan>') +
        `<tspan fill="#64748b" font-size="9.2" font-family="JetBrains Mono, monospace">]</tspan>`
      : '';

    // Concise subtitle so in/out counts and address never collide with right-side volume labels
    const subTitle = n.isAggregate
      ? `${n.count.toLocaleString()} txes • Tap to expand`
      : n.hasCircularReturn
      ? `${n.alias ? compactAddress(n.realAddress) + ' • ' : ''}${n.count.toLocaleString()} in / ${n.returnCount.toLocaleString()} out`
      : n.realAddress === '~Subsidy (all time)~' && n.count > 100
      ? `${n.count.toLocaleString()} subsidy blocks`
      : `${n.alias ? compactAddress(n.realAddress) + ' • ' : ''}${n.count.toLocaleString()} tx${n.count > 1 ? 'es' : ''}`;

    const portBarX = isLeft ? n.x + n.w - 5 : n.x;
    const inspectBtnX = isLeft ? n.x + 8 : n.x + n.w - 28;
    const textLeftX = isLeft ? n.x + 34 : n.x + 14;
    const amountRightX = isLeft ? n.x + n.w - 12 : n.x + n.w - 34;
    const midY = n.y + n.h / 2;

    // Build segmented inner port accent strip matching every ribbon attached to this node
    const portSegments = [
      ...inFlows.map((tf) => ({
        y0: tf.nodeY0,
        y1: tf.nodeY1,
        color: getPortSegmentColor(tf.tokenKey, false)
      })),
      ...retFlows.map((rtf) => ({
        y0: rtf.nodeY0,
        y1: rtf.nodeY1,
        color: getPortSegmentColor(rtf.tokenKey, true)
      }))
    ];

    const portStripMarkup =
      portSegments.length === 1 && !n.hasCircularReturn
        ? `<rect x="${portBarX}" y="${n.y + 4}" width="5" height="${n.h - 8}" rx="2.5" fill="${portSegments[0].color}" />`
        : portSegments
            .map((seg) => {
              const segH = Math.max(4, seg.y1 - seg.y0);
              return `<rect x="${portBarX}" y="${seg.y0}" width="5" height="${segH}" rx="2.2" fill="${seg.color}" />`;
            })
            .join('');

    // Build right-aligned amount lines (1 line if single token, or stacked colored lines for multi-token / circular return)
    const metricLines = [];
    inFlows.forEach((tf) => {
      const sign = n.hasCircularReturn || inFlows.length > 1 ? (isLeft ? '+' : '-') : '';
      metricLines.push({
        text: `${sign}${formatTokenAmount(tf.amount, tf.tokenKey, true)}`,
        color: getFlowTextColor(tf.tokenKey, false),
        fontSize: inFlows.length + retFlows.length > 2 ? '10.2' : '11.2',
        fontWeight: '700'
      });
    });
    retFlows.forEach((rtf) => {
      metricLines.push({
        text: `↺ -${formatTokenAmount(rtf.amount, rtf.tokenKey, true)}`,
        color: getFlowTextColor(rtf.tokenKey, true),
        fontSize: inFlows.length + retFlows.length > 2 ? '9.6' : '10.1',
        fontWeight: '600'
      });
    });

    let rightMetricsMarkup = '';
    if (metricLines.length === 1 && !n.hasCircularReturn) {
      const pctNumStr = `${primaryTf.sharePct >= 10 ? primaryTf.sharePct.toFixed(1) : primaryTf.sharePct.toFixed(2)}%`;
      const pctStr = showTokenTags ? `${pctNumStr} ${primaryDef.ticker}` : pctNumStr;
      rightMetricsMarkup = `
        <text class="node-right-text" x="${amountRightX}" y="${midY - 4}" text-anchor="end" fill="${metricLines[0].color}" font-family="JetBrains Mono, monospace" font-size="11.6" font-weight="700">${escapeHtml(metricLines[0].text)}</text>
        <text class="node-right-text" x="${amountRightX}" y="${midY + 12}" text-anchor="end" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9.8">${escapeHtml(pctStr)}</text>
      `;
    } else {
      const lineStep = metricLines.length >= 4 ? 12.5 : metricLines.length === 3 ? 13.5 : 15;
      const blockH = (metricLines.length - 1) * lineStep;
      const startY = midY - blockH / 2 + 3.5;
      rightMetricsMarkup = metricLines
        .map(
          (line, lIdx) =>
            `<text class="node-right-text" x="${amountRightX}" y="${startY + lIdx * lineStep}" text-anchor="end" fill="${line.color}" font-family="JetBrains Mono, monospace" font-size="${line.fontSize}" font-weight="${line.fontWeight}">${escapeHtml(line.text)}</text>`
        )
        .join('');
    }

    const cardStroke =
      allNodeTokenKeys.length > 1
        ? 'rgba(165, 180, 252, 0.48)'
        : hasFaOnNode
        ? primaryDef.cardBorder
        : n.hasCircularReturn
        ? 'rgba(236, 72, 153, 0.55)'
        : n.isBidirectional
        ? 'rgba(129, 140, 248, 0.5)'
        : 'rgba(255, 255, 255, 0.1)';

    const branchItemsMarkup = (n.visibleBranches || [])
      .map((b, bIdx) => {
        const bH = 22;
        const bY = n.y + n.h + 5 + bIdx * (bH + 4);
        const bMidY = bY + bH / 2;
        const indentX = 26;
        const bX = n.x + indentX;
        const bW = n.w - indentX;
        const trunkX = n.x + 13;
        const lineD = `M ${trunkX} ${n.y + n.h} L ${trunkX} ${bMidY - 5} Q ${trunkX} ${bMidY} ${trunkX + 5} ${bMidY} L ${bX} ${bMidY}`;
        const isL2Branch = b.network === 'etherlink';
        const netLabel = isL2Branch ? 'L2 ↗' : 'L1 ↗';
        const dispAddr = b.alias ? truncateText(b.alias, 16) : shortenAddress(b.address);
        const amtStr = `+${formatTez(b.amount, true)}`;

        return `
          <g class="sankey-l2-branch" data-branch-addr="${escapeHtml(b.address)}" data-branch-net="${escapeHtml(b.network || 'etherlink')}" data-side="${side}" data-index="${n.index}" data-branch-index="${bIdx}">
            <path class="l2-branch-line" d="${lineD}" fill="none" stroke="${isL2Branch ? '#10b981' : '#818cf8'}" stroke-width="1.4" stroke-dasharray="2.5 2" />
            <circle cx="${bX}" cy="${bMidY}" r="2.2" fill="${isL2Branch ? '#34d399' : '#a5b4fc'}" />
            <rect class="l2-branch-pill" x="${bX}" y="${bY}" width="${bW}" height="${bH}" rx="6"
                  fill="${isL2Branch ? 'rgba(6, 78, 59, 0.58)' : 'rgba(30, 27, 75, 0.7)'}"
                  stroke="${isL2Branch ? 'rgba(16, 185, 129, 0.55)' : 'rgba(129, 140, 248, 0.55)'}" stroke-width="1" />
            <rect x="${bX + 5}" y="${bY + 3.5}" width="32" height="15" rx="4"
                  fill="${isL2Branch ? 'rgba(16, 185, 129, 0.25)' : 'rgba(99, 102, 241, 0.28)'}" />
            <text x="${bX + 21}" y="${bMidY + 3.3}" text-anchor="middle" fill="${isL2Branch ? '#6ee7b7' : '#c7d2fe'}" font-family="Inter, sans-serif" font-size="8.6" font-weight="700">${escapeHtml(netLabel)}</text>
            <text x="${bX + 43}" y="${bMidY + 3.4}" fill="#e2e8f0" font-family="JetBrains Mono, monospace" font-size="9.6" font-weight="600">${escapeHtml(dispAddr)}</text>
            <text x="${bX + bW - 8}" y="${bMidY + 3.4}" text-anchor="end" fill="${isL2Branch ? '#34d399' : '#a5b4fc'}" font-family="JetBrains Mono, monospace" font-size="9.6" font-weight="700">${escapeHtml(amtStr)}</text>
          </g>
        `;
      })
      .join('');

    let branchToggleMarkup = '';
    if (n.canCollapseBranches) {
      const tIdx = (n.visibleBranches || []).length;
      const bH = 22;
      const bY = n.y + n.h + 5 + tIdx * (bH + 4);
      const bMidY = bY + bH / 2;
      const indentX = 26;
      const bX = n.x + indentX;
      const bW = n.w - indentX;
      const trunkX = n.x + 13;
      const lineD = `M ${trunkX} ${n.y + n.h} L ${trunkX} ${bMidY - 5} Q ${trunkX} ${bMidY} ${trunkX + 5} ${bMidY} L ${bX} ${bMidY}`;
      const toggleLabel = n.isBranchesExpanded
        ? `Collapse ${n.subBranches.length} bridged addresses ▴`
        : `+ ${n.hiddenBranchCount} more bridged addresses • Click to expand ▾`;

      branchToggleMarkup = `
        <g class="sankey-l2-branch" data-branch-toggle="true" data-node-addr="${escapeHtml(n.realAddress)}" data-side="${side}" data-index="${n.index}">
          <path class="l2-branch-line" d="${lineD}" fill="none" stroke="#64748b" stroke-width="1.3" stroke-dasharray="2.5 2" />
          <rect class="l2-branch-pill" x="${bX}" y="${bY}" width="${bW}" height="${bH}" rx="6"
                fill="rgba(30, 41, 82, 0.72)" stroke="rgba(148, 163, 184, 0.45)" stroke-width="1" />
          <text x="${bX + bW / 2}" y="${bMidY + 3.4}" text-anchor="middle" fill="#cbd5e1" font-family="Inter, sans-serif" font-size="9.4" font-weight="600">${escapeHtml(toggleLabel)}</text>
        </g>
      `;
    }

    const totalBranchRows = (n.visibleBranches ? n.visibleBranches.length : 0) + (n.canCollapseBranches ? 1 : 0);
    const branchHitBridgeMarkup =
      totalBranchRows > 0
        ? `<rect class="node-branch-hit-bridge" x="${n.x}" y="${n.y + n.h - 2}" width="${n.w}" height="${totalBranchRows * 26 + 4}" fill="transparent" style="cursor: default;" />`
        : '';
    const branchesMarkup = branchHitBridgeMarkup + branchItemsMarkup + branchToggleMarkup;

    return `
      <g class="sankey-node-group" data-side="${side}" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}" data-flow-key="${escapeHtml(n.realAddress)}" data-left-x="${textLeftX}" data-right-x="${amountRightX}">
        <!-- Base Card -->
        <rect class="sankey-node-card" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9"
              fill="${n.isAggregate ? 'rgba(30, 41, 82, 0.85)' : 'rgba(15, 20, 44, 0.88)'}"
              stroke="${cardStroke}"
              stroke-width="1" />

        <!-- Subtle Volume Share Progress Bar along bottom -->
        <rect x="${isLeft ? n.x + n.w - 6 - shareBarW : n.x + 6}" y="${n.y + n.h - 3}" width="${shareBarW}" height="2" rx="1"
              fill="${getPortSegmentColor(primaryTf.tokenKey, false)}" fill-opacity="0.7" />

        <!-- Segmented Inner Port Accent Strip -->
        ${portStripMarkup}

        <!-- Inspect Drawer Trigger Button (⋯) -->
        ${
          !n.isAggregate
            ? `<g class="node-inspect-btn" data-side="${side}" data-index="${n.index}" title="Inspect transactions">
                 <rect x="${inspectBtnX}" y="${midY - 10}" width="20" height="20" rx="5" fill="rgba(255,255,255,0.06)" />
                 <text x="${inspectBtnX + 10}" y="${midY + 4}" text-anchor="middle" fill="#94a3b8" font-family="Inter, sans-serif" font-size="11" font-weight="700">⋯</text>
               </g>`
            : ''
        }

        <!-- Primary Label (Alias or Short Address + Multi-Token Tags) -->
        <text class="node-left-text" x="${textLeftX}" y="${midY - 4}" fill="#f8fafc" font-family="Inter, sans-serif" font-size="11.8" font-weight="600">${escapeHtml(primaryTitle)}${tokenTagsMarkup}${escapeHtml(biBadge)}</text>

        <!-- Secondary Meta (Address & Tx Count / In-Out Count) -->
        <text class="node-left-text" x="${textLeftX}" y="${midY + 12}" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="9.8">${escapeHtml(subTitle)}</text>

        <!-- Right-aligned Multi-Token Amounts -->
        ${rightMetricsMarkup}

        <!-- Etherlink L2 / L1 Bridge Destination Tiny Branches -->
        ${branchesMarkup}
      </g>
    `;
  }

  const leftNodesMarkup = leftCol.nodes.map((n) => renderNodeCard(n, 'in')).join('');
  const rightNodesMarkup = rightCol.nodes.map((n) => renderNodeCard(n, 'out')).join('');

  // Render Center Target Account Hub
  const hubRawAlias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || '';
  const hubTitle = truncateText(hubRawAlias || shortenAddress(targetAddress), 22);
  const hubShortAddr = shortenAddress(targetAddress);
  const hubInitial = (hubRawAlias || (isL2Hub ? 'E' : targetAddress) || 'T').replace(/^~/, '').charAt(0).toUpperCase();
  const hubAvatarUrl = `${TZKT_AVATARS_BASE}/${encodeURIComponent(targetAddress)}`;
  const hubMidX = hubX + hubW / 2;
  const contentTopY = hubCenterY - 96 - Math.floor(extraHubRowsH / 2);
  const avatarCy = contentTopY + 46;
  const avatarR = 19;

  const tokensForHubDisplay =
    activeTokensInHub.length > 0
      ? activeTokensInHub
      : [[...viewConfig.enabledTokens][0] || 'xtz'];

  const hubTokenMetricsMarkup = tokensForHubDisplay
    .map((tk, idx) => {
      const yBase = contentTopY + 132 + idx * 34;
      const inVal = totalInByToken.get(tk) || 0;
      const outVal = totalOutByToken.get(tk) || 0;
      const def = TOKEN_DEFINITIONS[tk] || TOKEN_DEFINITIONS.xtz;
      const inColor = tk === 'xtz' ? '#34d399' : def.inflowLight;
      const outColor = tk === 'xtz' ? '#fb7185' : def.outflowLight;
      const dotMarkup =
        tokensForHubDisplay.length > 1
          ? `<tspan fill="${def.badgeText}" font-size="9.5">● </tspan>`
          : '';
      return `
        <text class="hub-row-left" x="${hubX + 18}" y="${yBase}" fill="#94a3b8" font-family="Inter, sans-serif" font-size="10">${dotMarkup}In</text>
        <text class="hub-row-right" x="${hubX + hubW - 18}" y="${yBase}" text-anchor="end" fill="${inColor}" font-family="JetBrains Mono, monospace" font-size="10.8" font-weight="700">+${escapeHtml(formatTokenAmount(inVal, tk, true))}</text>
        <text class="hub-row-left" x="${hubX + 18}" y="${yBase + 15}" fill="#94a3b8" font-family="Inter, sans-serif" font-size="10">${dotMarkup}Out</text>
        <text class="hub-row-right" x="${hubX + hubW - 18}" y="${yBase + 15}" text-anchor="end" fill="${outColor}" font-family="JetBrains Mono, monospace" font-size="10.8" font-weight="700">-${escapeHtml(formatTokenAmount(outVal, tk, true))}</text>
      `;
    })
    .join('');

  const hubFooterY = contentTopY + 132 + tokensForHubDisplay.length * 34 + 12;
  const hubBadgeText = isL2Hub ? 'ETHERLINK L2' : 'TARGET HUB';
  const hubBadgeW = isL2Hub ? 104 : 92;

  const centerHubMarkup = `
    <g class="sankey-hub-group" id="sankey-center-hub" style="cursor: pointer;">
      <clipPath id="hub-avatar-clip">
        <circle cx="${hubMidX}" cy="${avatarCy}" r="${avatarR}" />
      </clipPath>

      <!-- Outer Glow -->
      <rect x="${hubX - 4}" y="${hubY - 4}" width="${hubW + 8}" height="${hubCardH + 8}" rx="18"
            fill="none" stroke="${isL2Hub ? 'rgba(16, 185, 129, 0.32)' : 'rgba(99, 102, 241, 0.3)'}" stroke-width="2" />

      <!-- Main Hub Body -->
      <rect x="${hubX}" y="${hubY}" width="${hubW}" height="${hubCardH}" rx="14"
            fill="url(#grad-hub)" stroke="${isL2Hub ? '#34d399' : '#818cf8'}" stroke-width="1.5" />

      <!-- Left Inflow Port Rail -->
      ${
        totalLeftRibbonCount > 0
          ? `<rect x="${hubX}" y="${hubCenterY - leftPortSpan / 2}" width="6" height="${leftPortSpan}" rx="3" fill="#10b981" />`
          : ''
      }

      <!-- Right Outflow Port Rail -->
      ${
        totalRightRibbonCount > 0
          ? `<rect x="${hubX + hubW - 6}" y="${hubCenterY - rightPortSpan / 2}" width="6" height="${rightPortSpan}" rx="3" fill="#f43f5e" />`
          : ''
      }

      <!-- Hub Badge -->
      <rect x="${hubMidX - hubBadgeW / 2}" y="${contentTopY}" width="${hubBadgeW}" height="20" rx="10"
            fill="${isL2Hub ? 'rgba(16, 185, 129, 0.22)' : 'rgba(99, 102, 241, 0.25)'}"
            stroke="${isL2Hub ? 'rgba(52, 211, 153, 0.48)' : 'rgba(129, 140, 248, 0.4)'}" />
      <text x="${hubMidX}" y="${contentTopY + 13}" text-anchor="middle" fill="${isL2Hub ? '#6ee7b7' : '#c7d2fe'}" font-family="Inter, sans-serif" font-size="9.5" font-weight="700" letter-spacing="0.8">
        ${hubBadgeText}
      </text>

      <!-- Hub Avatar (Click to open in explorer) -->
      <a class="hub-avatar-link" href="${escapeHtml(getExplorerAddressUrl(targetAddress))}" target="_blank" rel="noopener">
        <circle cx="${hubMidX}" cy="${avatarCy}" r="${avatarR}" fill="${isL2Hub ? '#064e3b' : '#312e81'}" />
        <text x="${hubMidX}" y="${avatarCy + 5}" text-anchor="middle" fill="${isL2Hub ? '#6ee7b7' : '#c7d2fe'}" font-family="Space Grotesk, Inter, sans-serif" font-size="14" font-weight="700">
          ${escapeHtml(hubInitial)}
        </text>
        ${
          !isL2Hub
            ? `<image class="hub-avatar-img" href="${escapeHtml(hubAvatarUrl)}" x="${hubMidX - avatarR}" y="${avatarCy - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" clip-path="url(#hub-avatar-clip)" preserveAspectRatio="xMidYMid slice" />`
            : ''
        }
        <circle class="hub-avatar-ring" cx="${hubMidX}" cy="${avatarCy}" r="${avatarR + 0.5}" fill="none" stroke="${isL2Hub ? '#34d399' : '#818cf8'}" stroke-width="1.5" />
      </a>

      <!-- Target Alias & Short Address -->
      <text class="hub-title-text" x="${hubMidX}" y="${contentTopY + 84}" text-anchor="middle" fill="#ffffff" font-family="Space Grotesk, Inter, sans-serif" font-size="14.5" font-weight="700">${escapeHtml(hubTitle)}</text>
      <text x="${hubMidX}" y="${contentTopY + 101}" text-anchor="middle" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11">${escapeHtml(hubShortAddr)}</text>

      <!-- Divider -->
      <line x1="${hubX + 20}" y1="${contentTopY + 114}" x2="${hubX + hubW - 20}" y2="${contentTopY + 114}" stroke="rgba(255,255,255,0.1)" />

      <!-- Hub Per-Token Inflow & Outflow Metrics -->
      ${hubTokenMetricsMarkup}

      <!-- Hub Footer Hint -->
      <text x="${hubMidX}" y="${hubFooterY}" text-anchor="middle" fill="${isL2Hub ? '#34d399' : '#818cf8'}" font-family="Inter, sans-serif" font-size="10">
        Click to copy address
      </text>
    </g>
  `;

  const isDense = totalLeftRibbonCount + totalRightRibbonCount > 120;

  container.innerHTML = `
    <svg class="sankey-svg${isDense ? ' dense-mode' : ''}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${defsMarkup}
      <g class="sankey-links-layer">
        ${inflowLinksMarkup}
        ${outflowLinksMarkup}
        ${circularLinksMarkup}
        ${selfLoopMarkup}
      </g>
      <g class="sankey-hub-layer">
        ${centerHubMarkup}
      </g>
      <g class="sankey-nodes-layer">
        ${leftNodesMarkup}
        ${rightNodesMarkup}
      </g>
    </svg>
  `;

  fitSvgNodeLabels(container.querySelector('.sankey-svg'), hubW);

  if (viewConfig.faEnabled) {
    const sampleRefs = [];
    const visNodes = [...leftCol.nodes, ...rightCol.nodes];
    for (let i = 0; i < visNodes.length && sampleRefs.length < 75; i++) {
      const n = visNodes[i];
      if (n.txHashes) {
        for (let j = 0; j < n.txHashes.length && sampleRefs.length < 75; j++) {
          if (String(n.txHashes[j]).startsWith('txid:')) {
            sampleRefs.push(n.txHashes[j]);
          }
        }
      }
    }
    if (sampleRefs.length > 0) {
      resolveTxRefsToHashes(sampleRefs).catch(() => {});
    }
  }

  bindSankeyInteractions(
    container,
    targetAddress,
    leftCol.nodes,
    rightCol.nodes,
    selfLoopEntry,
    rawInflows,
    rawOutflows,
    addressToAliasMap,
    txHashesMap
  );
}

// ============================================================================
// Mobile & Cross-Browser SVG Text Collision Prevention
// Dynamically measures rendered SVG text widths and clamps any overflowing
// left/right node or hub labels so they can never overlap on mobile devices
// ============================================================================

function fitSvgNodeLabels(svgEl, hubW = 238) {
  if (!svgEl) return;
  try {
    svgEl.querySelectorAll('.sankey-node-group').forEach((group) => {
      const leftX = parseFloat(group.dataset.leftX);
      const rightX = parseFloat(group.dataset.rightX);
      if (isNaN(leftX) || isNaN(rightX) || rightX <= leftX) return;
      const totalSpan = rightX - leftX;
      const leftEls = group.querySelectorAll('.node-left-text');
      const rightEls = group.querySelectorAll('.node-right-text');

      let maxRightW = 0;
      const maxAllowedRightW = Math.floor(totalSpan * 0.45);
      rightEls.forEach((rEl) => {
        const rw = rEl.getComputedTextLength ? rEl.getComputedTextLength() : 0;
        if (rw > maxAllowedRightW && maxAllowedRightW > 40) {
          rEl.setAttribute('textLength', String(maxAllowedRightW));
          rEl.setAttribute('lengthAdjust', 'spacingAndGlyphs');
          if (maxAllowedRightW > maxRightW) maxRightW = maxAllowedRightW;
        } else if (rw > maxRightW) {
          maxRightW = rw;
        }
      });

      const availLeftW = Math.max(68, Math.floor(totalSpan - maxRightW - 10));
      leftEls.forEach((lEl) => {
        const lw = lEl.getComputedTextLength ? lEl.getComputedTextLength() : 0;
        if (lw > availLeftW) {
          lEl.setAttribute('textLength', String(availLeftW));
          lEl.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        }
      });
    });

    const hubGroup = svgEl.querySelector('#sankey-center-hub');
    if (hubGroup) {
      const hubInnerW = hubW - 36;
      const hubTitleEl = hubGroup.querySelector('.hub-title-text');
      if (hubTitleEl && hubTitleEl.getComputedTextLength) {
        const tw = hubTitleEl.getComputedTextLength();
        if (tw > hubInnerW) {
          hubTitleEl.setAttribute('textLength', String(hubInnerW));
          hubTitleEl.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        }
      }

      const hubLefts = hubGroup.querySelectorAll('.hub-row-left');
      const hubRights = hubGroup.querySelectorAll('.hub-row-right');
      const rowCount = Math.min(hubLefts.length, hubRights.length);
      for (let i = 0; i < rowCount; i++) {
        const lEl = hubLefts[i];
        const rEl = hubRights[i];
        const lw = lEl.getComputedTextLength ? lEl.getComputedTextLength() : 32;
        const rw = rEl.getComputedTextLength ? rEl.getComputedTextLength() : 0;
        const maxR = Math.max(60, Math.floor(hubInnerW - lw - 8));
        if (rw > maxR) {
          rEl.setAttribute('textLength', String(maxR));
          rEl.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        }
      }
    }
  } catch {
    // Ignore if SVG is not yet attached or hidden
  }
}

// ============================================================================
// Sankey Diagram Interactions: O(1) Indexed Hover, Delegated Events & Drawer
// ============================================================================

function bindSankeyInteractions(
  container,
  targetAddress,
  leftNodes,
  rightNodes,
  selfLoopEntry,
  rawInflows,
  rawOutflows,
  addressToAliasMap,
  txHashesMap
) {
  const tooltip = document.getElementById('sankey-tooltip');
  const svgEl = container.querySelector('.sankey-svg');
  if (!svgEl) return;

  const addrElementsMap = new Map();
  const keyElementsMap = new Map();

  function registerIndexedEl(key, addr, type, el) {
    let keyBucket = keyElementsMap.get(key);
    if (!keyBucket) {
      keyBucket = { nodes: [], links: [] };
      keyElementsMap.set(key, keyBucket);
    }
    keyBucket[type].push(el);

    if (addr && !addr.startsWith('__aggregate')) {
      let addrBucket = addrElementsMap.get(addr);
      if (!addrBucket) {
        addrBucket = { nodes: [], links: [] };
        addrElementsMap.set(addr, addrBucket);
      }
      addrBucket[type].push(el);
    }
  }

  svgEl.querySelectorAll('.sankey-node-group').forEach((ng) => {
    const key = `${ng.dataset.side}:${ng.dataset.index}`;
    registerIndexedEl(key, ng.dataset.addr, 'nodes', ng);
  });

  svgEl.querySelectorAll('.sankey-link-wrap').forEach((lw) => {
    const key = `${lw.dataset.side}:${lw.dataset.index}`;
    const pathEl = lw.querySelector('.sankey-link');
    const flowEl = lw.querySelector('.sankey-link-flow');
    registerIndexedEl(key, lw.dataset.addr, 'links', { pathEl, flowEl, token: lw.dataset.token });
  });

  let activeNodes = [];
  let activeLinks = [];
  let currentHoverKey = null;
  let clearHighlightTimer = null;
  let cachedTooltipW = 300;
  let cachedTooltipH = 150;

  function getEntry(side, index) {
    if (side === 'self') return selfLoopEntry;
    return side === 'in' ? leftNodes[index] : rightNodes[index];
  }

  function cancelScheduledClear() {
    if (clearHighlightTimer !== null) {
      clearTimeout(clearHighlightTimer);
      clearHighlightTimer = null;
    }
  }

  function clearHighlight() {
    cancelScheduledClear();
    if (activeLinks.length > 0 || activeNodes.length > 0) {
      for (let i = 0; i < activeLinks.length; i++) {
        const { pathEl, flowEl } = activeLinks[i];
        pathEl.classList.remove('highlighted');
        flowEl.classList.remove('active');
      }
      for (let i = 0; i < activeNodes.length; i++) {
        activeNodes[i].classList.remove('highlighted');
      }
      activeLinks = [];
      activeNodes = [];
      svgEl.classList.remove('has-highlight');
    }
    currentHoverKey = null;
    if (tooltip) tooltip.style.display = 'none';
  }

  function scheduleClearHighlight(delayMs = 90) {
    cancelScheduledClear();
    clearHighlightTimer = setTimeout(() => {
      clearHighlightTimer = null;
      clearHighlight();
    }, delayMs);
  }

  function highlightConnection(addr, side, index, specificToken = null) {
    const key = `${side}:${index}`;
    for (let i = 0; i < activeLinks.length; i++) {
      activeLinks[i].pathEl.classList.remove('highlighted');
      activeLinks[i].flowEl.classList.remove('active');
    }
    for (let i = 0; i < activeNodes.length; i++) {
      activeNodes[i].classList.remove('highlighted');
    }

    const bucket =
      addr && !addr.startsWith('__aggregate')
        ? addrElementsMap.get(addr) || keyElementsMap.get(key)
        : keyElementsMap.get(key);

    if (!bucket) {
      activeLinks = [];
      activeNodes = [];
      svgEl.classList.remove('has-highlight');
      return;
    }

    // If hovering a specific token ribbon among multiple ribbons, highlight that token's ribbon(s) + the node card
    activeLinks = specificToken
      ? bucket.links.filter((l) => !l.token || l.token === specificToken)
      : bucket.links;
    if (activeLinks.length === 0) activeLinks = bucket.links;
    activeNodes = bucket.nodes;
    svgEl.classList.add('has-highlight');

    for (let i = 0; i < activeLinks.length; i++) {
      activeLinks[i].pathEl.classList.add('highlighted');
      activeLinks[i].flowEl.classList.add('active');
    }
    for (let i = 0; i < activeNodes.length; i++) {
      activeNodes[i].classList.add('highlighted');
    }
  }

  function cacheTooltipSize() {
    if (!tooltip) return;
    const rect = tooltip.getBoundingClientRect();
    cachedTooltipW = rect.width || 300;
    cachedTooltipH = rect.height || 150;
  }

  function showNodeTooltip(evt, entry, side, hoveredToken = null) {
    if (!tooltip || !entry) return;
    const isLeft = side === 'in';
    const inFlows = entry.tokenFlows || [];
    const retFlows = entry.hasCircularReturn ? entry.returnTokenFlows || [] : [];

    const badgeClass = entry.isSelfTransfer
      ? 'hub'
      : hoveredToken && hoveredToken !== 'xtz'
      ? hoveredToken
      : inFlows.length === 1 && inFlows[0].tokenKey !== 'xtz'
      ? inFlows[0].tokenKey
      : isLeft
      ? 'inflow'
      : 'outflow';

    const badgeText = entry.isSpecial
      ? 'Protocol Flow'
      : entry.isSelfTransfer
      ? 'Self-Transfer (↺)'
      : entry.hasCircularReturn
      ? `Circular Flow ↺ (${inFlows.length + retFlows.length} ribbons)`
      : isLeft
      ? entry.isBidirectional
        ? 'Inflow • Bidirectional ⇄'
        : `Inflow (${inFlows.length > 1 ? inFlows.length + ' Tokens' : 'Sender'})`
      : entry.isBidirectional
      ? 'Outflow • Bidirectional ⇄'
      : `Outflow (${inFlows.length > 1 ? inFlows.length + ' Tokens' : 'Receiver'})`;

    const startStr = formatDateShort(entry.dateRange?.start);
    const endStr = formatDateShort(entry.dateRange?.end);
    const dateSpan = startStr === endStr ? startStr : `${startStr} → ${endStr}`;

    const rowsHtml = [];
    inFlows.forEach((tf) => {
      const def = TOKEN_DEFINITIONS[tf.tokenKey] || TOKEN_DEFINITIONS.xtz;
      const color = tf.tokenKey === 'xtz' ? (isLeft ? 'var(--inflow-light)' : 'var(--outflow-light)') : def.inflowLight;
      const isFocused = hoveredToken && hoveredToken === tf.tokenKey;
      const focusStyle = isFocused ? `border: 1px solid ${def.badgeStroke}; background: ${def.badgeBg};` : '';
      rowsHtml.push(`
        <div class="tt-grid">
          <div class="tt-metric" style="${focusStyle}">
            <div class="tt-metric-lbl">${escapeHtml(def.ticker)} ${isLeft ? 'Sent to Hub' : 'Received'}</div>
            <div class="tt-metric-val" style="color: ${color};">${isLeft ? '+' : '-'}${escapeHtml(formatTokenAmount(tf.amount, tf.tokenKey))}</div>
          </div>
          <div class="tt-metric" style="${focusStyle}">
            <div class="tt-metric-lbl">${escapeHtml(def.ticker)} Share &amp; Txes</div>
            <div class="tt-metric-val">${(tf.sharePct || 0).toFixed(2)}% (${tf.count} tx)</div>
          </div>
        </div>
      `);
    });

    retFlows.forEach((rtf) => {
      const def = TOKEN_DEFINITIONS[rtf.tokenKey] || TOKEN_DEFINITIONS.xtz;
      const color = rtf.tokenKey === 'xtz' ? '#f472b6' : def.returnTextColor;
      rowsHtml.push(`
        <div class="tt-grid">
          <div class="tt-metric">
            <div class="tt-metric-lbl">Returned ↺ (${escapeHtml(def.ticker)})</div>
            <div class="tt-metric-val" style="color: ${color};">-${escapeHtml(formatTokenAmount(rtf.amount, rtf.tokenKey))}</div>
          </div>
          <div class="tt-metric">
            <div class="tt-metric-lbl">Return Share &amp; Txes</div>
            <div class="tt-metric-val">${(rtf.sharePct || 0).toFixed(2)}% (${rtf.count} tx)</div>
          </div>
        </div>
      `);
    });

    if (entry.subBranches && entry.subBranches.length > 0) {
      const topB = entry.subBranches[0];
      const isL2B = topB.network === 'etherlink';
      const moreCount = entry.subBranches.length - 1;
      rowsHtml.push(`
        <div class="tt-grid">
          <div class="tt-metric" style="border: 1px solid ${isL2B ? 'rgba(52, 211, 153, 0.45)' : 'rgba(129, 140, 248, 0.45)'}; background: ${isL2B ? 'rgba(6, 78, 59, 0.35)' : 'rgba(30, 27, 75, 0.4)'};">
            <div class="tt-metric-lbl">${isL2B ? 'Etherlink L2 Dest ↗' : 'Tezos L1 Origin ↗'}</div>
            <div class="tt-metric-val" style="color: ${isL2B ? '#6ee7b7' : '#c7d2fe'};">${escapeHtml(shortenAddress(topB.address))}${moreCount > 0 ? ` (+${moreCount})` : ''}</div>
          </div>
          <div class="tt-metric" style="border: 1px solid ${isL2B ? 'rgba(52, 211, 153, 0.45)' : 'rgba(129, 140, 248, 0.45)'}; background: ${isL2B ? 'rgba(6, 78, 59, 0.35)' : 'rgba(30, 27, 75, 0.4)'};">
            <div class="tt-metric-lbl">Bridged Volume</div>
            <div class="tt-metric-val" style="color: ${isL2B ? '#34d399' : '#a5b4fc'};">+${escapeHtml(formatTez(topB.amount))} (${topB.count} tx)</div>
          </div>
        </div>
      `);
    }

    tooltip.innerHTML = `
      <div class="tt-header">
        <div class="tt-title-wrap">
          <div class="tt-alias">${escapeHtml(entry.alias || shortenAddress(entry.realAddress))}</div>
          ${
            !entry.isAggregate
              ? `<div class="tt-address">${escapeHtml(entry.realAddress)}</div>`
              : `<div class="tt-address">Grouped smaller counterparties</div>`
          }
        </div>
        <span class="tt-badge ${escapeHtml(badgeClass)}">${escapeHtml(badgeText)}</span>
      </div>
      ${rowsHtml.join('')}
      <div class="tt-footer">
        <span><i class="fa-regular fa-calendar"></i> ${escapeHtml(dateSpan)}</span>
        <span>${
          entry.isAggregate
            ? 'Click to expand all'
            : entry.isSelfTransfer
            ? 'Click: Copy &amp; Inspect Self-Txes'
            : 'Click: Copy &amp; Pivot • ⋯: Tx List'
        }</span>
      </div>
    `;
    tooltip.style.display = 'block';
    cacheTooltipSize();
    positionTooltip(evt);
  }

  function showBranchTooltip(evt, entry, branch) {
    if (!tooltip || !entry || !branch) return;
    const isL2 = branch.network === 'etherlink';
    const netTitle = isL2 ? 'Etherlink L2 ↗' : 'Tezos L1 ↗';
    const titleText = branch.alias || shortenAddress(branch.address);

    tooltip.innerHTML = `
      <div class="tt-header">
        <div class="tt-title-wrap">
          <div class="tt-alias">${escapeHtml(titleText)}</div>
          <div class="tt-address">${escapeHtml(branch.address)}</div>
        </div>
        <span class="tt-badge ${isL2 ? 'l2' : 'hub'}">${escapeHtml(netTitle)}</span>
      </div>
      <div class="tt-grid">
        <div class="tt-metric" style="border: 1px solid rgba(52, 211, 153, 0.45); background: rgba(6, 78, 59, 0.35);">
          <div class="tt-metric-lbl">${isL2 ? 'Bridged to Etherlink L2' : 'Bridged to Tezos L1'}</div>
          <div class="tt-metric-val" style="color: #34d399;">+${escapeHtml(formatTez(branch.amount))}</div>
        </div>
        <div class="tt-metric">
          <div class="tt-metric-lbl">Bridge Transfers</div>
          <div class="tt-metric-val">${Number(branch.count) || 0} tx via ${escapeHtml(shortenAddress(entry.realAddress))}</div>
        </div>
      </div>
      <div class="tt-footer">
        <span><i class="fa-solid fa-layer-group"></i> ${isL2 ? 'Etherlink EVM (L2)' : 'Tezos Mainnet (L1)'}</span>
        <span style="color: #6ee7b7; font-weight: 600;">Click to transfer to ${isL2 ? 'L2' : 'L1'} context ↗</span>
      </div>
    `;
    tooltip.style.display = 'block';
    cacheTooltipSize();
    positionTooltip(evt);
  }

  function showHubTooltip(evt) {
    if (!tooltip) return;
    const externalOutflows = rawOutflows.filter((e) => !e.isSelfTransfer);
    const inByToken = computeTokenTotalsMap(rawInflows);
    const outByToken = computeTokenTotalsMap(externalOutflows);
    const alias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || targetAddress;
    const isL2 = isEtherlinkAddress(targetAddress);
    const avatarUrl = isL2
      ? 'icons/tezos.png'
      : `${TZKT_AVATARS_BASE}/${encodeURIComponent(targetAddress)}`;

    const activeTokens = ALL_TOKEN_ORDER.filter((tk) => viewConfig.enabledTokens.has(tk));
    const tokenRowsHtml = activeTokens
      .map((tk) => {
        const def = TOKEN_DEFINITIONS[tk];
        const inAmt = inByToken.get(tk) || 0;
        const outAmt = outByToken.get(tk) || 0;
        const inColor = tk === 'xtz' ? 'var(--inflow-light)' : def.inflowLight;
        const outColor = tk === 'xtz' ? 'var(--outflow-light)' : def.outflowLight;
        return `
          <div class="tt-grid">
            <div class="tt-metric">
              <div class="tt-metric-lbl">${escapeHtml(def.ticker)} In</div>
              <div class="tt-metric-val" style="color:${inColor};">+${escapeHtml(formatTokenAmount(inAmt, tk))}</div>
            </div>
            <div class="tt-metric">
              <div class="tt-metric-lbl">${escapeHtml(def.ticker)} Out</div>
              <div class="tt-metric-val" style="color:${outColor};">-${escapeHtml(formatTokenAmount(outAmt, tk))}</div>
            </div>
          </div>
        `;
      })
      .join('');

    tooltip.innerHTML = `
      <div class="tt-header">
        <img class="tt-avatar" src="${escapeHtml(avatarUrl)}" alt="" onerror="this.src='icons/tezos.png'">
        <div class="tt-title-wrap">
          <div class="tt-alias">${escapeHtml(alias)}</div>
          <div class="tt-address">${escapeHtml(targetAddress)}</div>
        </div>
        <span class="tt-badge ${isL2 ? 'l2' : 'hub'}">${isL2 ? 'Etherlink L2' : 'Target Hub'}</span>
      </div>
      ${tokenRowsHtml}
      <div class="tt-footer">
        <span>Click to copy target address</span>
      </div>
    `;
    tooltip.style.display = 'block';
    cacheTooltipSize();
    positionTooltip(evt);
  }

  function positionTooltip(evt) {
    if (!tooltip || tooltip.style.display === 'none') return;
    const pad = 16;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + cachedTooltipW > window.innerWidth - 12) {
      x = evt.clientX - cachedTooltipW - pad;
    }
    if (y + cachedTooltipH > window.innerHeight - 12) {
      y = evt.clientY - cachedTooltipH - pad;
    }
    tooltip.style.transform = `translate3d(${Math.max(8, x)}px, ${Math.max(8, y)}px, 0)`;
  }

  async function copyEntryToClipboard(entry) {
    const relatedAddress = entry.realAddress;
    const rawRefs = txHashesMap.get(relatedAddress) || entry.txHashes || [];
    const resolvedHashes = await resolveTxRefsToHashes(rawRefs);
    const txHashesText = resolvedHashes.map((hash) => getExplorerTxUrl(hash, relatedAddress)).join('\n');
    const clipboardText = `${relatedAddress}\n\n${txHashesText}`;
    navigator.clipboard
      .writeText(clipboardText)
      .then(() => {
        console.log(clipboardText);
      })
      .catch((err) => {
        console.error('Could not copy text:', err);
      });
    showNotification(`Copied ${shortenAddress(relatedAddress)} & ${resolvedHashes.length} tx links`);
  }

  function handlePrimaryNodeAction(entry) {
    if (!entry) return;
    clearHighlight();

    if (entry.isAggregate) {
      const nextMax = viewConfig.maxNodes < 100 ? 100 : 9999;
      viewConfig.maxNodes = nextMax;
      document.querySelectorAll('#max-nodes-control .seg-btn').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.max) === nextMax);
      });
      renderCurrentSankey();
      showNotification(`Expanded diagram to show ${nextMax === 9999 ? 'all' : 'top ' + nextMax} nodes`);
      return;
    }

    copyEntryToClipboard(entry);

    if (entry.isSelfTransfer) {
      openInspectorDrawer(entry, 'self');
      return;
    }

    const relatedAddress = entry.realAddress;
    if (!relatedAddress.startsWith('~')) {
      input.value = relatedAddress.trim();
      go();
    }
  }

  svgEl.addEventListener('mouseover', (evt) => {
    const branchEl = evt.target.closest('.sankey-l2-branch');
    if (branchEl) {
      cancelScheduledClear();
      const side = branchEl.dataset.side;
      const idx = Number(branchEl.dataset.index);
      const entry = getEntry(side, idx);
      if (branchEl.dataset.branchToggle === 'true') {
        const hoverKey = `branch-toggle:${side}:${idx}`;
        if (currentHoverKey !== hoverKey && entry) {
          currentHoverKey = hoverKey;
          highlightConnection(entry.realAddress, side, idx, 'xtz');
          if (tooltip) tooltip.style.display = 'none';
        }
        return;
      }
      const bIdx = Number(branchEl.dataset.branchIndex);
      const hoverKey = `branch:${side}:${idx}:${bIdx}`;
      const branch = entry?.visibleBranches?.[bIdx] || entry?.subBranches?.[bIdx];
      if (currentHoverKey !== hoverKey && entry && branch) {
        currentHoverKey = hoverKey;
        highlightConnection(entry.realAddress, side, idx, 'xtz');
        showBranchTooltip(evt, entry, branch);
      }
      return;
    }

    const inspectBtn = evt.target.closest('.node-inspect-btn');
    const itemEl = evt.target.closest('.sankey-node-group, .sankey-link-wrap, #sankey-center-hub');
    if (!itemEl) {
      if (currentHoverKey !== null) scheduleClearHighlight(90);
      return;
    }

    cancelScheduledClear();

    if (itemEl.id === 'sankey-center-hub') {
      if (currentHoverKey !== 'hub') {
        clearHighlight();
        currentHoverKey = 'hub';
        showHubTooltip(evt);
      }
      return;
    }

    const side = itemEl.dataset.side;
    const idx = Number(itemEl.dataset.index);
    const hoveredToken = itemEl.classList.contains('sankey-link-wrap') ? itemEl.dataset.token || null : null;
    const hoverKey = `${side}:${idx}:${hoveredToken || 'all'}`;
    const entry = getEntry(side, idx);

    if (inspectBtn) {
      if (currentHoverKey !== hoverKey && entry) {
        currentHoverKey = hoverKey;
        highlightConnection(entry.realAddress, side, idx, null);
      }
      if (tooltip) tooltip.style.display = 'none';
      return;
    }

    if (currentHoverKey === hoverKey) {
      if (entry && tooltip && tooltip.style.display === 'none') {
        showNodeTooltip(evt, entry, side, hoveredToken);
      }
      return;
    }

    currentHoverKey = hoverKey;
    if (entry) {
      highlightConnection(entry.realAddress, side, idx, hoveredToken);
      showNodeTooltip(evt, entry, side, hoveredToken);
    }
  });

  svgEl.addEventListener('mousemove', (evt) => {
    if (currentHoverKey !== null) {
      positionTooltip(evt);
    }
  });

  svgEl.addEventListener('mouseleave', clearHighlight);

  svgEl.addEventListener('click', (evt) => {
    if (evt.target.classList && evt.target.classList.contains('node-branch-hit-bridge')) {
      return;
    }
    const branchEl = evt.target.closest('.sankey-l2-branch');
    if (branchEl) {
      evt.stopPropagation();
      clearHighlight();
      if (branchEl.dataset.branchToggle === 'true') {
        const nodeAddr = branchEl.dataset.nodeAddr;
        if (nodeAddr) {
          if (viewConfig.expandedBranchNodes.has(nodeAddr)) {
            viewConfig.expandedBranchNodes.delete(nodeAddr);
          } else {
            viewConfig.expandedBranchNodes.add(nodeAddr);
          }
          renderCurrentSankey();
        }
        return;
      }
      const side = branchEl.dataset.side;
      const idx = Number(branchEl.dataset.index);
      const bIdx = Number(branchEl.dataset.branchIndex);
      const entry = getEntry(side, idx);
      const branch = entry?.visibleBranches?.[bIdx] || entry?.subBranches?.[bIdx];
      const branchAddr = branch?.address || branchEl.dataset.branchAddr;
      if (branchAddr) {
        const txLinks = (branch?.txHashes || []).map((h) => getExplorerTxUrl(h, entry?.realAddress || branchAddr)).join('\n');
        const clipText = txLinks ? `${branchAddr}\n\n${txLinks}` : branchAddr;
        navigator.clipboard.writeText(clipText).catch(() => {});
        console.log(clipText);
        const isL2 = (branch?.network || branchEl.dataset.branchNet) === 'etherlink';
        showNotification(`Switched to ${isL2 ? 'Etherlink L2' : 'Tezos L1'} context: ${shortenAddress(branchAddr)}`);
        input.value = branchAddr.trim();
        go();
      }
      return;
    }

    const inspectBtn = evt.target.closest('.node-inspect-btn');
    if (inspectBtn) {
      evt.stopPropagation();
      clearHighlight();
      const side = inspectBtn.dataset.side;
      const idx = Number(inspectBtn.dataset.index);
      openInspectorDrawer(getEntry(side, idx), side);
      return;
    }

    const avatarLinkEl = evt.target.closest('.hub-avatar-link');
    if (avatarLinkEl) {
      evt.stopPropagation();
      return;
    }

    const itemEl = evt.target.closest('.sankey-node-group, .sankey-link-wrap, #sankey-center-hub');
    if (!itemEl) return;

    if (itemEl.id === 'sankey-center-hub') {
      navigator.clipboard.writeText(targetAddress).catch(() => {});
      console.log(targetAddress);
      showNotification(`Copied target address: ${shortenAddress(targetAddress)}`);
      return;
    }

    const side = itemEl.dataset.side;
    const idx = Number(itemEl.dataset.index);
    handlePrimaryNodeAction(getEntry(side, idx));
  });

  svgEl.addEventListener('contextmenu', (evt) => {
    const itemEl = evt.target.closest('.sankey-node-group, .sankey-link-wrap');
    if (!itemEl) return;
    const side = itemEl.dataset.side;
    const idx = Number(itemEl.dataset.index);
    const entry = getEntry(side, idx);
    if (entry && !entry.isAggregate) {
      evt.preventDefault();
      clearHighlight();
      openInspectorDrawer(entry, side);
    }
  });
}

// ============================================================================
// Slide-over Transaction Inspector Drawer
// ============================================================================

const inspectorDrawer = document.getElementById('inspector-drawer');
let inspectedEntry = null;

async function openInspectorDrawer(entry, side) {
  if (!inspectorDrawer || !entry) return;
  const tooltipEl = document.getElementById('sankey-tooltip');
  if (tooltipEl) tooltipEl.style.display = 'none';
  inspectedEntry = entry;

  const inFlows = entry.tokenFlows || [];
  const retFlows = entry.hasCircularReturn ? entry.returnTokenFlows || [] : [];

  document.getElementById('drawer-alias').textContent = entry.alias || shortenAddress(entry.realAddress);
  document.getElementById('drawer-address').textContent = entry.realAddress;

  const badge = document.getElementById('drawer-badge');
  const singleFaKey = inFlows.length === 1 && inFlows[0].tokenKey !== 'xtz' ? inFlows[0].tokenKey : null;
  badge.className = `tt-badge ${entry.isSelfTransfer ? 'hub' : singleFaKey ? singleFaKey : side === 'in' ? 'inflow' : 'outflow'}`;
  const tickersText = Array.from(
    new Set([...inFlows.map((tf) => tf.tokenTicker), ...retFlows.map((rtf) => rtf.tokenTicker)])
  ).join(' + ');
  badge.textContent = entry.isSelfTransfer
    ? `${tickersText} • Self-Transfer (Hub ↺ Hub)`
    : entry.hasCircularReturn
    ? `${tickersText} • Circular Flow (In & Returned ↺)`
    : side === 'in'
    ? `${tickersText} • Inflow (Sender)`
    : `${tickersText} • Outflow (Receiver)`;

  const avatar = document.getElementById('drawer-avatar');
  if (entry.realAddress.startsWith('~') || isEtherlinkAddress(entry.realAddress)) {
    avatar.src = 'icons/tezos.png';
  } else {
    avatar.src = `${TZKT_AVATARS_BASE}/${encodeURIComponent(entry.realAddress)}`;
  }

  const volParts = [
    ...inFlows.map((tf) => `${side === 'in' ? '+' : '-'}${formatTokenAmount(tf.amount, tf.tokenKey, true)}`),
    ...retFlows.map((rtf) => `↺ -${formatTokenAmount(rtf.amount, rtf.tokenKey, true)}`)
  ];
  document.getElementById('drawer-volume').textContent = volParts.join(' • ');
  document.getElementById('drawer-txcount').textContent = entry.hasCircularReturn
    ? `${entry.count} in • ${entry.returnCount} returned`
    : `${entry.count} transfers (${inFlows.length} token${inFlows.length > 1 ? 's' : ''})`;

  const tzktLink = document.getElementById('drawer-tzkt-link');
  const targetExplorerAddr = entry.realAddress.startsWith('~') ? currentAddress : entry.realAddress;
  tzktLink.href = getExplorerAddressUrl(targetExplorerAddr);
  tzktLink.innerHTML = `<i class="fa-solid fa-arrow-up-right-from-square"></i> ${
    isEtherlinkAddress(targetExplorerAddr) ? 'Etherlink Explorer' : 'TzKT Profile'
  }`;

  const txListEl = document.getElementById('drawer-tx-list');
  const combinedRawRefs = entry.hasCircularReturn
    ? Array.from(new Set([...(entry.txHashes || []), ...(entry.returnEntry?.txHashes || [])]))
    : entry.txHashes || [];

  const opsLabelEl = document.getElementById('drawer-ops-label');
  if (opsLabelEl) {
    const usesBlockscout =
      isEtherlinkAddress(currentAddress) ||
      isEtherlinkAddress(targetExplorerAddr) ||
      combinedRawRefs.some((r) => isEtherlinkTxHash(r));
    opsLabelEl.textContent = usesBlockscout
      ? 'Related Operations (Blockscout)'
      : 'Related Operations (TzKT)';
  }

  const subBranchesHtml =
    Array.isArray(entry.subBranches) && entry.subBranches.length > 0
      ? entry.subBranches
          .map((b) => {
            const isL2 = b.network === 'etherlink';
            return `
              <button type="button" class="drawer-tx-item drawer-l2-branch-btn" data-branch-addr="${escapeHtml(b.address)}" data-branch-net="${escapeHtml(b.network || 'etherlink')}"
                      style="width: 100%; border: 1px solid ${isL2 ? 'rgba(16, 185, 129, 0.45)' : 'rgba(129, 140, 248, 0.45)'}; background: ${isL2 ? 'rgba(6, 78, 59, 0.35)' : 'rgba(30, 27, 75, 0.45)'}; cursor: pointer; text-align: left;">
                <span style="color: ${isL2 ? '#6ee7b7' : '#c7d2fe'}; font-weight: 600;">
                  ${isL2 ? 'L2 ↗' : 'L1 ↗'} ${escapeHtml(shortenAddress(b.address))} • +${escapeHtml(formatTez(b.amount, true))} (${Number(b.count) || 0} tx)
                </span>
                <span style="font-size: 0.72rem; color: #34d399; font-weight: 600;">Switch to ${isL2 ? 'L2' : 'L1'} →</span>
              </button>
            `;
          })
          .join('')
      : '';

  const renderTxItems = (hashes) => {
    const txItemsHtml = hashes
      .map((hash, idx) => {
        const cleanHash = formatTxRefSync(hash);
        const displayHash = cleanHash.startsWith('txid:')
          ? `Tx ID #${cleanHash.slice(5)}`
          : `${cleanHash.slice(0, 14)}…${cleanHash.slice(-8)}`;
        const href = cleanHash.startsWith('txid:')
          ? getExplorerAddressUrl(entry.realAddress)
          : getExplorerTxUrl(cleanHash, entry.realAddress);
        return `
          <a class="drawer-tx-item" href="${escapeHtml(href)}" target="_blank" rel="noopener">
            <span>#${idx + 1} • ${escapeHtml(displayHash)}</span>
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </a>
        `;
      })
      .join('');
    txListEl.innerHTML = subBranchesHtml + txItemsHtml;

    txListEl.querySelectorAll('.drawer-l2-branch-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bAddr = btn.dataset.branchAddr;
        const isL2 = btn.dataset.branchNet === 'etherlink';
        if (bAddr) {
          inspectorDrawer?.classList.remove('open');
          showNotification(`Switched to ${isL2 ? 'Etherlink L2' : 'Tezos L1'} context: ${shortenAddress(bAddr)}`);
          input.value = bAddr;
          go();
        }
      });
    });
  };

  renderTxItems(combinedRawRefs);
  inspectorDrawer.classList.add('open');

  if (combinedRawRefs.some((r) => String(r).startsWith('txid:'))) {
    const resolved = await resolveTxRefsToHashes(combinedRawRefs);
    if (inspectedEntry === entry) {
      renderTxItems(resolved);
    }
  }
}

document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
  inspectorDrawer?.classList.remove('open');
});

document.addEventListener('click', (evt) => {
  if (!inspectorDrawer || !inspectorDrawer.classList.contains('open')) return;
  if (
    !inspectorDrawer.contains(evt.target) &&
    !evt.target.closest('.node-inspect-btn') &&
    !evt.target.closest('#sankey-self-loop')
  ) {
    inspectorDrawer.classList.remove('open');
  }
});

document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape' && inspectorDrawer?.classList.contains('open')) {
    inspectorDrawer.classList.remove('open');
  }
});

document.getElementById('drawer-pivot-btn')?.addEventListener('click', () => {
  if (!inspectedEntry) return;
  const addr = inspectedEntry.realAddress;
  inspectorDrawer?.classList.remove('open');
  if (!addr.startsWith('~')) {
    input.value = addr;
    go();
  }
});

document.getElementById('drawer-copy-btn')?.addEventListener('click', async () => {
  if (!inspectedEntry) return;
  const combinedRefs = inspectedEntry.hasCircularReturn
    ? Array.from(new Set([...(inspectedEntry.txHashes || []), ...(inspectedEntry.returnEntry?.txHashes || [])]))
    : inspectedEntry.txHashes || [];
  const resolved = await resolveTxRefsToHashes(combinedRefs);
  const txText = resolved.map((h) => getExplorerTxUrl(h, inspectedEntry.realAddress)).join('\n');
  const text = `${inspectedEntry.realAddress}\n\n${txText}`;
  navigator.clipboard.writeText(text).catch(() => {});
  console.log(text);
  showNotification('Address and transactions copied to clipboard/console');
});

// ============================================================================
// High-Resolution PNG Export
// ============================================================================

function exportDiagramAsPng() {
  const svgEl = document.querySelector('#sankey-diagram svg');
  if (!svgEl) {
    showNotification('No diagram to export yet');
    return;
  }

  const width = Number(svgEl.getAttribute('width')) || 1280;
  const height = Number(svgEl.getAttribute('height')) || 700;

  const clone = svgEl.cloneNode(true);
  clone.querySelectorAll('.hub-avatar-img').forEach((el) => el.remove());
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', String(width));
  bgRect.setAttribute('height', String(height));
  bgRect.setAttribute('fill', '#070918');
  clone.insertBefore(bgRect, clone.firstChild);

  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(clone);
  const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = function () {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    const a = document.createElement('a');
    a.download = `eye-of-chad-${shortenAddress(currentAddress || 'tezos')}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    showNotification('Exported high-resolution PNG!');
  };
  img.src = url;
}

// ============================================================================
// Session History Navigation (Back / Forward)
// ============================================================================

document.getElementById('back-button').addEventListener('click', function () {
  if (historyIndex > 0) {
    historyIndex--;
    const previousAddress = history[historyIndex];
    input.value = previousAddress;
    const limit = resultLimitSlider.value;
    updateLocationHash();
    generateDataAndDrawDiagram(previousAddress, limit);
    updateNavigationButtons();
  }
});

document.getElementById('forward-button').addEventListener('click', function () {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    const nextAddress = history[historyIndex];
    input.value = nextAddress;
    const limit = resultLimitSlider.value;
    updateLocationHash();
    generateDataAndDrawDiagram(nextAddress, limit);
    updateNavigationButtons();
  }
});

function updateNavigationButtons() {
  document.getElementById('back-button').disabled = historyIndex <= 0;
  document.getElementById('forward-button').disabled = historyIndex >= history.length - 1;
}

function updateHistory(tezosAddress) {
  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }
  history.push(tezosAddress);
  historyIndex = history.length - 1;
  updateNavigationButtons();
}
