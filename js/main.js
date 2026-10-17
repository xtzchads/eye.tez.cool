// ============================================================================
// The Eye of Chad — Modern Tezos Flow & Sankey Explorer (Unified Multi-Ribbon Node Edition)
// Single node per counterparty address with multiple color-coded token ribbons
// ============================================================================

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
    name: 'Tether USD (USDt)',
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
  }
};

const ALL_TOKEN_ORDER = ['xtz', 'tzbtc', 'usdt'];
const FA_TOKEN_KEYS = ['tzbtc', 'usdt'];
const FA_CONTRACT_LIST = FA_TOKEN_KEYS.map((k) => TOKEN_DEFINITIONS[k].contract).join(',');
const CONTRACT_TO_TOKEN_KEY = new Map(
  FA_TOKEN_KEYS.map((k) => [TOKEN_DEFINITIONS[k].contract, k])
);

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

  if (tokenKey === 'tzbtc') {
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

  // Default FA formatting (e.g. USDt with 6 decimals)
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

  if (!query || query.length > 30) {
    dropdown.style.display = 'none';
    if (query.length === 36) {
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
    let response = await fetch(`https://kukai.api.tzkt.io/v1/suggest/accounts/${encoded}`);
    if (!response.ok) {
      response = await fetch(`https://staging.kukai.api.tzkt.io/v1/suggest/accounts/${encoded}`);
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
    avatar.src = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(suggestion.address)}`;
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

// FA Tokens Switch & Individual Token Pills (XTZ, tzBTC, USDt)
const faTokensToggle = document.getElementById('fa-tokens-toggle');
const faTokensControl = document.getElementById('fa-tokens-control');

function syncTokenControlsUI() {
  if (faTokensToggle) {
    faTokensToggle.checked = viewConfig.faEnabled;
  }
  if (faTokensControl) {
    faTokensControl.classList.toggle('fa-active', viewConfig.faEnabled);
  }
  document.querySelectorAll('#fa-token-pills .token-pill').forEach((pill) => {
    const tk = pill.dataset.token;
    pill.classList.toggle('active', viewConfig.enabledTokens.has(tk));
  });
}

async function onTokenSelectionChanged() {
  const addr = currentAddress || input.value.trim();
  if (!addr) return;
  const limit = Number(resultLimitSlider.value) || 10000;
  const cached = cache.get(addr);

  if (viewConfig.faEnabled && (!cached || (!cached.faExhausted && (cached.faLimit || 0) < limit))) {
    await generateDataAndDrawDiagram(addr, limit);
  } else if (currentAddress) {
    if (cached) {
      currentFaData = (cached.faData || []).slice(0, limit);
    }
    refreshDiagramFromMemory();
  }
}

faTokensToggle?.addEventListener('change', function () {
  if (this.checked) {
    viewConfig.faEnabled = true;
    viewConfig.enabledTokens.add('tzbtc');
    viewConfig.enabledTokens.add('usdt');
    syncTokenControlsUI();
    updateLocationHash();
    showNotification('FA Tokens enabled: Combining XTZ, tzBTC & USDt ribbons per counterparty node');
  } else {
    viewConfig.faEnabled = false;
    viewConfig.enabledTokens = new Set(['xtz']);
    syncTokenControlsUI();
    updateLocationHash();
    showNotification('FA Tokens disabled: Displaying XTZ flows only');
  }
  onTokenSelectionChanged();
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
      const anyFaActive = FA_TOKEN_KEYS.some((k) => viewConfig.enabledTokens.has(k));
      viewConfig.faEnabled = anyFaActive;
    } else {
      viewConfig.enabledTokens.add(tk);
      if (FA_TOKEN_KEYS.includes(tk)) {
        viewConfig.faEnabled = true;
      }
    }

    syncTokenControlsUI();
    updateLocationHash();
    const activeLabels = [...viewConfig.enabledTokens].map((k) => TOKEN_DEFINITIONS[k]?.ticker || k).join(' + ');
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
  if (address) {
    input.value = decodeURIComponent(address.trim());
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
    const parsedTokens = tokensParam
      .toLowerCase()
      .split('+')
      .filter((k) => Boolean(TOKEN_DEFINITIONS[k]));
    if (parsedTokens.length > 0) {
      viewConfig.enabledTokens = new Set(parsedTokens);
      viewConfig.faEnabled = FA_TOKEN_KEYS.some((k) => viewConfig.enabledTokens.has(k));
      syncTokenControlsUI();
    }
  }
  if (address && address.trim() !== currentAddress) {
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

async function fetchAccountMetadata(tezosAddress) {
  try {
    const [accRes, balRes] = await Promise.all([
      fetch(`https://kukai.api.tzkt.io/v1/accounts/${encodeURIComponent(tezosAddress)}?select=alias,balance`),
      fetch(
        `https://kukai.api.tzkt.io/v1/tokens/balances?account=${encodeURIComponent(tezosAddress)}&token.contract.in=${FA_CONTRACT_LIST}&select=token,balance`
      )
    ]);
    const info = accRes.ok ? await accRes.json() : {};
    const tokenBalances = { tzbtc: 0, usdt: 0 };
    if (balRes.ok) {
      const balList = await balRes.json();
      if (Array.isArray(balList)) {
        balList.forEach((item) => {
          const contractAddr = item.token?.contract?.address;
          const tk = CONTRACT_TO_TOKEN_KEY.get(contractAddr);
          if (tk && TOKEN_DEFINITIONS[tk]) {
            const rawBal = parseFloat(item.balance || '0');
            tokenBalances[tk] = rawBal / Math.pow(10, TOKEN_DEFINITIONS[tk].decimals);
          }
        });
      }
    }
    return { ...(info || {}), tokenBalances };
  } catch {
    return null;
  }
}

async function fetchSpecialAccountOps(tezosAddress) {
  try {
    const url = `https://kukai.api.tzkt.io/v1/accounts/${encodeURIComponent(tezosAddress)}/operations?type=activation,origination,migration&status=applied&limit=100`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function fetchOperationsBatch(tezosAddress, lastId = 0, batchLimit = 10000) {
  const clampLimit = Math.min(10000, Math.max(1, Number(batchLimit) || 10000));
  const baseUrl = `https://kukai.api.tzkt.io/v1/operations/transactions?anyof.sender.target=${encodeURIComponent(tezosAddress)}&status=applied&amount.gt=0&sort.desc=id&select=id,hash,timestamp,amount,sender,target&limit=${clampLimit}`;
  const url = lastId > 0 ? `${baseUrl}&offset.cr=${lastId}` : baseUrl;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TzKT HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
      } else {
        console.error('Error fetching operations batch:', err);
        return null;
      }
    }
  }
  return null;
}

async function fetchFaTransfersBatch(tezosAddress, lastId = 0, batchLimit = 10000) {
  const clampLimit = Math.min(10000, Math.max(1, Number(batchLimit) || 10000));
  const baseUrl = `https://kukai.api.tzkt.io/v1/tokens/transfers?anyof.from.to=${encodeURIComponent(tezosAddress)}&token.contract.in=${FA_CONTRACT_LIST}&amount.gt=0&sort.desc=id&select=id,timestamp,token,from,to,amount,transactionId&limit=${clampLimit}`;
  const url = lastId > 0 ? `${baseUrl}&offset.cr=${lastId}` : baseUrl;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TzKT HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
      } else {
        console.error('Error fetching FA token transfers batch:', err);
        return null;
      }
    }
  }
  return null;
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
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      try {
        const res = await fetch(
          `https://kukai.api.tzkt.io/v1/operations/transactions?id.in=${chunk.join(',')}&select=id,hash&limit=${chunk.length}`
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
    }
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
  const numLimit = Number(requestedLimit) || 10000;
  const needFa = viewConfig.faEnabled;

  if (cache.has(tezosAddress)) {
    const cached = cache.get(tezosAddress);
    const xtzReady = cached.exhausted || cached.limit >= numLimit;
    const faReady = !needFa || cached.faExhausted || (cached.faLimit || 0) >= numLimit;
    if (xtzReady && faReady) {
      return {
        operations: [...cached.txData.slice(0, numLimit), ...(cached.specialOps || [])],
        faTransfers: needFa ? (cached.faData || []).slice(0, numLimit) : [],
        accountInfo: cached.accountInfo
      };
    }
  }

  const loaderEl = document.getElementById('loader');
  const loaderStatus = document.getElementById('loader-status');
  const emptyState = document.getElementById('empty-state');
  const colHeadersEl = document.getElementById('sankey-col-headers');
  const diagramEl = document.getElementById('sankey-diagram');
  const statsStrip = document.getElementById('stats-strip');

  if (emptyState) emptyState.style.display = 'none';
  if (colHeadersEl) colHeadersEl.style.display = 'none';
  if (diagramEl) diagramEl.style.display = 'none';
  if (statsStrip) statsStrip.style.display = 'none';
  if (loaderEl) loaderEl.style.display = 'flex';

  const existing = cache.get(tezosAddress);
  const txData = existing ? [...existing.txData] : [];
  let lastOffset = existing ? existing.lastOffset : 0;
  let counter = txData.length;
  let exhausted = existing ? Boolean(existing.exhausted) : false;

  const faData = existing?.faData ? [...existing.faData] : [];
  let faLastOffset = existing?.faLastOffset || 0;
  let faCounter = faData.length;
  let faExhausted = existing ? Boolean(existing.faExhausted) : false;
  let faLimit = existing?.faLimit || 0;

  const accountPromise = existing?.accountInfo
    ? Promise.resolve(existing.accountInfo)
    : fetchAccountMetadata(tezosAddress);

  const specialOpsPromise = existing?.specialOps
    ? Promise.resolve(existing.specialOps)
    : fetchSpecialAccountOps(tezosAddress);

  while (!exhausted && counter < numLimit) {
    const remaining = numLimit - counter;
    const batchSize = Math.min(10000, Math.max(1000, remaining));

    if (loaderStatus) {
      loaderStatus.textContent = `Fetching XTZ transactions from TzKT… ${counter.toLocaleString('en-US')} / ${numLimit.toLocaleString('en-US')}`;
    }

    const batch = await fetchOperationsBatch(tezosAddress, lastOffset, batchSize);
    if (!batch || !Array.isArray(batch) || batch.length === 0) {
      exhausted = true;
      break;
    }

    for (let i = 0; i < batch.length; i++) {
      const op = batch[i];
      if (op.id && op.hash) {
        txIdToHashCache.set(Number(op.id), op.hash);
      }
      txData.push(op);
    }
    lastOffset = batch[batch.length - 1].id;
    counter = txData.length;

    if (batch.length < batchSize) {
      exhausted = true;
      break;
    }
  }

  if (needFa) {
    while (!faExhausted && faCounter < numLimit) {
      const remaining = numLimit - faCounter;
      const batchSize = Math.min(10000, Math.max(1000, remaining));

      if (loaderStatus) {
        loaderStatus.textContent = `Fetching FA token transfers (tzBTC / USDt)… ${faCounter.toLocaleString('en-US')} / ${numLimit.toLocaleString('en-US')}`;
      }

      const batch = await fetchFaTransfersBatch(tezosAddress, faLastOffset, batchSize);
      if (!batch || !Array.isArray(batch) || batch.length === 0) {
        faExhausted = true;
        break;
      }

      for (let i = 0; i < batch.length; i++) {
        faData.push(batch[i]);
      }
      faLastOffset = batch[batch.length - 1].id;
      faCounter = faData.length;

      if (batch.length < batchSize) {
        faExhausted = true;
        break;
      }
    }
    faLimit = Math.max(faCounter, numLimit);
  }

  const [accountInfo, specialOps] = await Promise.all([accountPromise, specialOpsPromise]);

  cache.set(tezosAddress, {
    txData,
    specialOps,
    limit: Math.max(counter, existing?.limit || 0, numLimit),
    lastOffset,
    exhausted,
    faData,
    faLimit,
    faLastOffset,
    faExhausted,
    accountInfo
  });

  return {
    operations: [...txData.slice(0, numLimit), ...specialOps],
    faTransfers: needFa ? faData.slice(0, numLimit) : [],
    accountInfo
  };
}

// ============================================================================
// Unified Counterparty Multi-Token Transaction Parsing
// Groups all enabled token flows for the same counterparty into a single node
// with an array of `tokenFlows` (so 1 node can emit/receive 1, 2, or 3 colored ribbons)
// ============================================================================

function parseTransactions(data, faTransfers, tezosAddress, tezLimitVal) {
  const inflowsMap = new Map(); // Map<realAddress, UnifiedNodeEntry>
  const outflowsMap = new Map(); // Map<realAddress, UnifiedNodeEntry>
  const addressToAliasMap = new Map();
  const txHashesMap = new Map();

  function recordUnifiedFlow(map, keyAddress, displayAlias, amount, timestamp, opRef, isSpecial = false, tokenKey = 'xtz') {
    if (!amount || amount <= 0) return;
    const tokenDef = TOKEN_DEFINITIONS[tokenKey] || TOKEN_DEFINITIONS.xtz;
    let nodeEntry = map.get(keyAddress);

    if (!nodeEntry) {
      nodeEntry = {
        flowKey: keyAddress,
        realAddress: keyAddress,
        alias: displayAlias && displayAlias !== keyAddress ? displayAlias : '',
        address: displayAlias || keyAddress,
        tokenMap: new Map(), // Map<tokenKey, TokenSubFlow>
        tokenFlows: [],
        amount: 0,
        equivalentTez: 0,
        count: 0,
        dateRange: { start: timestamp, end: timestamp },
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
      if (timestamp < nodeEntry.dateRange.start) nodeEntry.dateRange.start = timestamp;
      if (timestamp > nodeEntry.dateRange.end) nodeEntry.dateRange.end = timestamp;
    }

    nodeEntry.count += 1;
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
    tf.count += 1;
    if (opRef && !tf.txHashSet.has(opRef)) {
      tf.txHashSet.add(opRef);
      tf.txHashes.push(opRef);
    }
  }

  // 1. Parse Native XTZ Operations if XTZ is enabled
  if (viewConfig.enabledTokens.has('xtz') && Array.isArray(data)) {
    data.forEach((operation) => {
      const senderAddr = operation.sender?.address || '';
      const targetAddr = operation.target?.address || '';
      const senderAlias = operation.sender?.alias || senderAddr;
      const targetAlias = operation.target?.alias || targetAddr;
      const timestamp = new Date(operation.timestamp);

      if (operation.type === 'activation') {
        const accAddr = operation.account?.address || tezosAddress;
        const accAlias = operation.account?.alias || accAddr;
        addressToAliasMap.set(accAddr, accAlias);

        const specialKey = '~Activation~';
        const amount = parseFloat(operation.balance / 1_000_000);
        recordUnifiedFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true, 'xtz');
      } else if (operation.type === 'migration' && operation.kind === 'bootstrap') {
        const accAddr = operation.account?.address || tezosAddress;
        const accAlias = operation.account?.alias || accAddr;
        addressToAliasMap.set(accAddr, accAlias);

        const specialKey = '~Bootstrap~';
        const amount = parseFloat(operation.balanceChange / 1_000_000);
        recordUnifiedFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true, 'xtz');
      } else if (operation.type === 'migration' && operation.kind === 'subsidy') {
        const accAddr = operation.account?.address || tezosAddress;
        const accAlias = operation.account?.alias || accAddr;
        addressToAliasMap.set(accAddr, accAlias);

        const specialKey = '~Subsidy~';
        const amount = parseFloat(operation.balanceChange / 1_000_000);
        recordUnifiedFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true, 'xtz');
      } else if (operation.type === 'origination') {
        if (operation.contractBalance > 0) {
          const origAddr = operation.originatedContract?.address || '';
          const origAlias = operation.originatedContract?.alias || origAddr;
          const amount = parseFloat(operation.contractBalance / 1_000_000);

          if (senderAddr === tezosAddress && origAddr) {
            addressToAliasMap.set(senderAddr, senderAlias);
            addressToAliasMap.set(origAddr, origAlias);
            recordUnifiedFlow(outflowsMap, origAddr, origAlias, amount, timestamp, operation.hash, false, 'xtz');
          } else if (origAddr === tezosAddress && senderAddr) {
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
          if (senderAddr === tezosAddress && targetAddr) {
            recordUnifiedFlow(outflowsMap, targetAddr, targetAlias, amount, timestamp, operation.hash, false, 'xtz');
          }
          if (targetAddr === tezosAddress && senderAddr && senderAddr !== tezosAddress) {
            recordUnifiedFlow(inflowsMap, senderAddr, senderAlias, amount, timestamp, operation.hash, false, 'xtz');
          }
        }
      }
    });
  }

  // 2. Parse FA Token Transfers (tzBTC, USDt) when FA Tokens switch is enabled
  if (viewConfig.faEnabled && Array.isArray(faTransfers)) {
    faTransfers.forEach((transfer) => {
      const contractAddr = transfer.token?.contract?.address;
      const tokenKey = CONTRACT_TO_TOKEN_KEY.get(contractAddr);
      if (!tokenKey || !viewConfig.enabledTokens.has(tokenKey)) return;

      const tokenDef = TOKEN_DEFINITIONS[tokenKey];
      const decimals = Number(tokenDef.decimals || transfer.token?.metadata?.decimals || 6);
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
      const opRef = txId
        ? txIdToHashCache.get(Number(txId)) || `txid:${txId}`
        : '';

      if (fromAddr === tezosAddress && toAddr) {
        const isSpecial = toAddr.startsWith('~');
        recordUnifiedFlow(outflowsMap, toAddr, toAlias, amount, timestamp, opRef, isSpecial, tokenKey);
      }
      if (toAddr === tezosAddress && fromAddr && fromAddr !== tezosAddress) {
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
    entry.isSelfTransfer = entry.realAddress === tezosAddress;
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

  if (!result || (!hasXtzOps && !hasFaOps)) {
    showNotification('No operations found for this address');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) {
      emptyState.style.display = 'block';
      emptyState.querySelector('h2').textContent = 'No Value Flows Found';
      emptyState.querySelector('p').textContent = viewConfig.faEnabled
        ? `No applied XTZ, tzBTC, or USDt operations were found for "${tezosAddress}". Check the address or try another wallet or contract.`
        : `No applied XTZ operations were found for "${tezosAddress}". Try enabling the FA Tokens switch (tzBTC / USDt) or check another address.`;
    }
    return;
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
  const colHeadersEl = document.getElementById('sankey-col-headers');
  if (colHeadersEl) colHeadersEl.style.display = '';
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
    if (viewConfig.circularFlows && side === 'in' && a.isBidirectional !== b.isBidirectional) {
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

  // Update column headers
  const hdrIn = document.getElementById('hdr-inflows-label');
  const hdrOut = document.getElementById('hdr-outflows-label');
  const hdrCenter = document.getElementById('hdr-center-label');
  if (hdrIn) {
    const circNote = mergedCircularAddresses.size > 0 ? ` • ${mergedCircularAddresses.size} Circular ↺` : '';
    hdrIn.textContent = `Inflows (${rawInflows.length} Senders • ${formatMultiTokenSummaryPlain(totalInByToken, true)}${circNote})`;
  }
  if (hdrOut) {
    hdrOut.textContent = `Outflows (${externalRawOutflows.length} Receivers • ${formatMultiTokenSummaryPlain(totalOutByToken, true)})`;
  }
  const hubAlias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || shortenAddress(targetAddress);
  if (hdrCenter) {
    hdrCenter.textContent = `Target Hub — ${hubAlias}`;
  }

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

      const node = {
        ...item,
        index: idx,
        x: xPos,
        y: curY,
        w: cardW,
        h,
        weight: totalNodeWeight,
        normWeight: Math.min(1, norm),
        returnWeight: totalRetWeight
      };
      curY += h + nodeGap;
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

      <!-- USDt (KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o) Distinct Electric Cyan / Sky Gradients -->
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
      ? `${n.alias ? compactAddress(n.realAddress) + ' • ' : ''}${n.count} in / ${n.returnCount} out`
      : `${n.alias ? compactAddress(n.realAddress) + ' • ' : ''}${n.count} tx${n.count > 1 ? 'es' : ''}`;

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
      </g>
    `;
  }

  const leftNodesMarkup = leftCol.nodes.map((n) => renderNodeCard(n, 'in')).join('');
  const rightNodesMarkup = rightCol.nodes.map((n) => renderNodeCard(n, 'out')).join('');

  // Render Center Target Account Hub
  const hubRawAlias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || '';
  const hubTitle = truncateText(hubRawAlias || shortenAddress(targetAddress), 22);
  const hubShortAddr = shortenAddress(targetAddress);
  const hubInitial = (hubRawAlias || targetAddress || 'T').replace(/^~/, '').charAt(0).toUpperCase();
  const hubAvatarUrl = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(targetAddress)}`;
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

  const centerHubMarkup = `
    <g class="sankey-hub-group" id="sankey-center-hub" style="cursor: pointer;">
      <clipPath id="hub-avatar-clip">
        <circle cx="${hubMidX}" cy="${avatarCy}" r="${avatarR}" />
      </clipPath>

      <!-- Outer Glow -->
      <rect x="${hubX - 4}" y="${hubY - 4}" width="${hubW + 8}" height="${hubCardH + 8}" rx="18"
            fill="none" stroke="rgba(99, 102, 241, 0.3)" stroke-width="2" />

      <!-- Main Hub Body -->
      <rect x="${hubX}" y="${hubY}" width="${hubW}" height="${hubCardH}" rx="14"
            fill="url(#grad-hub)" stroke="#818cf8" stroke-width="1.5" />

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
      <rect x="${hubMidX - 46}" y="${contentTopY}" width="92" height="20" rx="10" fill="rgba(99, 102, 241, 0.25)" stroke="rgba(129, 140, 248, 0.4)" />
      <text x="${hubMidX}" y="${contentTopY + 13}" text-anchor="middle" fill="#c7d2fe" font-family="Inter, sans-serif" font-size="9.5" font-weight="700" letter-spacing="0.8">
        TARGET HUB
      </text>

      <!-- Hub Avatar -->
      <circle cx="${hubMidX}" cy="${avatarCy}" r="${avatarR}" fill="#312e81" />
      <text x="${hubMidX}" y="${avatarCy + 5}" text-anchor="middle" fill="#c7d2fe" font-family="Space Grotesk, Inter, sans-serif" font-size="14" font-weight="700">
        ${escapeHtml(hubInitial)}
      </text>
      <image class="hub-avatar-img" href="${hubAvatarUrl}" x="${hubMidX - avatarR}" y="${avatarCy - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" clip-path="url(#hub-avatar-clip)" preserveAspectRatio="xMidYMid slice" />
      <circle cx="${hubMidX}" cy="${avatarCy}" r="${avatarR + 0.5}" fill="none" stroke="#818cf8" stroke-width="1.5" />

      <!-- Target Alias & Short Address -->
      <text class="hub-title-text" x="${hubMidX}" y="${contentTopY + 84}" text-anchor="middle" fill="#ffffff" font-family="Space Grotesk, Inter, sans-serif" font-size="14.5" font-weight="700">${escapeHtml(hubTitle)}</text>
      <text x="${hubMidX}" y="${contentTopY + 101}" text-anchor="middle" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11">${escapeHtml(hubShortAddr)}</text>

      <!-- Divider -->
      <line x1="${hubX + 20}" y1="${contentTopY + 114}" x2="${hubX + hubW - 20}" y2="${contentTopY + 114}" stroke="rgba(255,255,255,0.1)" />

      <!-- Hub Per-Token Inflow & Outflow Metrics -->
      ${hubTokenMetricsMarkup}

      <!-- Hub Footer Hint -->
      <text x="${hubMidX}" y="${hubFooterY}" text-anchor="middle" fill="#818cf8" font-family="Inter, sans-serif" font-size="10">
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
  let cachedTooltipW = 300;
  let cachedTooltipH = 150;

  function getEntry(side, index) {
    if (side === 'self') return selfLoopEntry;
    return side === 'in' ? leftNodes[index] : rightNodes[index];
  }

  function clearHighlight() {
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
        <span class="tt-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
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

  function showHubTooltip(evt) {
    if (!tooltip) return;
    const externalOutflows = rawOutflows.filter((e) => !e.isSelfTransfer);
    const inByToken = computeTokenTotalsMap(rawInflows);
    const outByToken = computeTokenTotalsMap(externalOutflows);
    const alias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || targetAddress;
    const avatarUrl = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(targetAddress)}`;

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
        <img class="tt-avatar" src="${avatarUrl}" alt="" onerror="this.src='icons/tezos.png'">
        <div class="tt-title-wrap">
          <div class="tt-alias">${escapeHtml(alias)}</div>
          <div class="tt-address">${escapeHtml(targetAddress)}</div>
        </div>
        <span class="tt-badge hub">Target Hub</span>
      </div>
      ${tokenRowsHtml}
      <div class="tt-footer">
        <span>Click to copy target address</span>
        <span>Right-click to inspect</span>
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
    const txHashesText = resolvedHashes.map((hash) => `https://tzkt.io/${hash}`).join('\n');
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
    const inspectBtn = evt.target.closest('.node-inspect-btn');
    const itemEl = evt.target.closest('.sankey-node-group, .sankey-link-wrap, #sankey-center-hub');
    if (!itemEl) {
      if (currentHoverKey !== null) clearHighlight();
      return;
    }

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
    const inspectBtn = evt.target.closest('.node-inspect-btn');
    if (inspectBtn) {
      evt.stopPropagation();
      clearHighlight();
      const side = inspectBtn.dataset.side;
      const idx = Number(inspectBtn.dataset.index);
      openInspectorDrawer(getEntry(side, idx), side);
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
  if (entry.realAddress.startsWith('~')) {
    avatar.src = 'icons/tezos.png';
  } else {
    avatar.src = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(entry.realAddress)}`;
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
  tzktLink.href = entry.realAddress.startsWith('~')
    ? `https://tzkt.io/${encodeURIComponent(currentAddress)}`
    : `https://tzkt.io/${encodeURIComponent(entry.realAddress)}`;

  const txListEl = document.getElementById('drawer-tx-list');
  const combinedRawRefs = entry.hasCircularReturn
    ? Array.from(new Set([...(entry.txHashes || []), ...(entry.returnEntry?.txHashes || [])]))
    : entry.txHashes || [];

  const renderTxItems = (hashes) => {
    txListEl.innerHTML = hashes
      .map((hash, idx) => {
        const cleanHash = formatTxRefSync(hash);
        const displayHash = cleanHash.startsWith('txid:')
          ? `Tx ID #${cleanHash.slice(5)}`
          : `${cleanHash.slice(0, 14)}…${cleanHash.slice(-8)}`;
        const href = cleanHash.startsWith('txid:')
          ? `https://tzkt.io/${encodeURIComponent(entry.realAddress)}`
          : `https://tzkt.io/${encodeURIComponent(cleanHash)}`;
        return `
          <a class="drawer-tx-item" href="${href}" target="_blank" rel="noopener">
            <span>#${idx + 1} • ${escapeHtml(displayHash)}</span>
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </a>
        `;
      })
      .join('');
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
  const txText = resolved.map((h) => `https://tzkt.io/${h}`).join('\n');
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
