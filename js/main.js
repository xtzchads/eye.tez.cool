// ============================================================================
// The Eye of Chad — Modern Tezos Flow & Sankey Explorer
// Pure HTML + CSS + Vanilla JS (Zero external chart library dependencies)
// ============================================================================

const input = document.getElementById('target-address');
const dropdown = document.createElement('div');
dropdown.className = 'address-dropdown';

// Session state & cache
const cache = new Map(); // Map<address, { data, limit, lastOffset, exhausted, accountInfo }>
let history = [];
let historyIndex = -1;

// Active diagram state (allows instant re-rendering on filter/scale/sort changes)
let currentAddress = '';
let currentRawData = [];
let currentAccountInfo = null;
let currentParsed = null;

// Readability / View settings
let viewConfig = {
  scaleMode: 'sqrt',    // 'sqrt' | 'log' | 'linear'
  maxNodes: 50,         // 25 | 50 | 100 | 9999
  sortMode: 'amount',   // 'amount' | 'count' | 'recent'
  circularFlows: true,  // true = Circular Loopbacks (↺), false = Split (⇄)
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
  }
  if (abs >= 100) {
    return `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} ꜩ`;
  }
  if (abs >= 1) {
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ꜩ`;
  }
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ꜩ`;
}

function shortenAddress(addr) {
  if (!addr) return '';
  if (addr.startsWith('~')) return addr;
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 7)}…${addr.slice(-5)}`;
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
    let response = await fetch(`https://api.tzkt.io/v1/suggest/accounts/${encoded}`);
    if (!response.ok) {
      response = await fetch(`https://staging.api.tzkt.io/v1/suggest/accounts/${encoded}`);
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
  if (currentAddress && currentRawData.length > 0) {
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
    if (currentAddress && currentRawData.length > 0) {
      refreshDiagramFromMemory();
    } else if (input.value.trim()) {
      go();
    }
  });
});

// Toolbar controls: Ribbon Scale, Max Nodes, Sort Mode, Search Filter, Full Height, Export PNG
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
            ? `Circular Flows (↺): Looping ${totalLoops} flow${totalLoops > 1 ? 's' : ''} (${biCount} return, ${selfCount} self)`
            : 'Circular Flows (↺) enabled (0 circular or self-transfer flows here)'
        );
      } else {
        showNotification('Split Flows (⇄): Showing inflows on left and outflows on right');
      }
    }
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

// Update URL hash in exact backwards-compatible format: #address,resultLimit,tezLimit
function updateLocationHash() {
  const tezosAddress = input.value.trim();
  const resultLimitValue = resultLimitSlider.value;
  const tezLimitValue = tezLimitSlider.value;
  if (tezosAddress) {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', `#${tezosAddress},${resultLimitValue},${tezLimitValue}`);
    } else {
      location.hash = `${tezosAddress},${resultLimitValue},${tezLimitValue}`;
    }
  }
}

function applyHashFromUrl() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const [address, resultLimitValue, tezLimitValue] = hash.split(',');
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
  if (address && address.trim() !== currentAddress) {
    go();
  }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  updateSliderTrack(resultLimitSlider);
  updateSliderTrack(tezLimitSlider);
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
    const res = await fetch(`https://api.tzkt.io/v1/accounts/${encodeURIComponent(tezosAddress)}?select=alias,balance`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchSpecialAccountOps(tezosAddress) {
  try {
    const url = `https://api.tzkt.io/v1/accounts/${encodeURIComponent(tezosAddress)}/operations?type=activation,origination,migration&status=applied&limit=100`;
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
  const baseUrl = `https://api.tzkt.io/v1/operations/transactions?anyof.sender.target=${encodeURIComponent(tezosAddress)}&status=applied&amount.gt=0&sort.desc=id&select=id,hash,timestamp,amount,sender,target&limit=${clampLimit}`;
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

async function fetchAllData(tezosAddress, requestedLimit) {
  const numLimit = Number(requestedLimit) || 10000;

  if (cache.has(tezosAddress)) {
    const cached = cache.get(tezosAddress);
    if (cached.exhausted || cached.limit >= numLimit) {
      return {
        operations: [...cached.txData.slice(0, numLimit), ...(cached.specialOps || [])],
        accountInfo: cached.accountInfo
      };
    }
  }

  // Show loader inside the unified workspace while keeping the block header visible
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

  // Start from existing cached data if expanding depth on same address
  const existing = cache.get(tezosAddress);
  const txData = existing ? [...existing.txData] : [];
  let lastOffset = existing ? existing.lastOffset : 0;
  let counter = txData.length;
  let exhausted = false;

  const accountPromise = existing?.accountInfo
    ? Promise.resolve(existing.accountInfo)
    : fetchAccountMetadata(tezosAddress);

  const specialOpsPromise = existing?.specialOps
    ? Promise.resolve(existing.specialOps)
    : fetchSpecialAccountOps(tezosAddress);

  while (counter < numLimit) {
    const remaining = numLimit - counter;
    const batchSize = Math.min(10000, Math.max(1000, remaining));

    if (loaderStatus) {
      loaderStatus.textContent = `Fetching transactions from TzKT… ${counter.toLocaleString('en-US')} / ${numLimit.toLocaleString('en-US')}`;
    }

    const batch = await fetchOperationsBatch(tezosAddress, lastOffset, batchSize);
    if (!batch || !Array.isArray(batch) || batch.length === 0) {
      exhausted = true;
      break;
    }

    for (let i = 0; i < batch.length; i++) {
      txData.push(batch[i]);
    }
    lastOffset = batch[batch.length - 1].id;
    counter = txData.length;

    if (batch.length < batchSize) {
      exhausted = true;
      break;
    }
  }

  const [accountInfo, specialOps] = await Promise.all([accountPromise, specialOpsPromise]);

  cache.set(tezosAddress, {
    txData,
    specialOps,
    limit: Math.max(counter, numLimit),
    lastOffset,
    exhausted,
    accountInfo
  });

  return {
    operations: [...txData.slice(0, numLimit), ...specialOps],
    accountInfo
  };
}

// ============================================================================
// Transaction Parsing
// ============================================================================

function parseTransactions(data, tezosAddress, tezLimitVal) {
  const inflowsMap = new Map();
  const outflowsMap = new Map();
  const addressToAliasMap = new Map();
  const txHashesMap = new Map(); // Keyed by display label AND address for full compatibility

  if (!data || !Array.isArray(data)) {
    return {
      inflows: [],
      outflows: [],
      allInflowsCount: 0,
      allOutflowsCount: 0,
      addressToAliasMap,
      txHashesMap
    };
  }

  function recordFlow(map, keyAddress, displayAlias, amount, timestamp, opHash, isSpecial = false) {
    if (!amount || amount <= 0) return;
    const existing = map.get(keyAddress);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
      if (timestamp < existing.dateRange.start) existing.dateRange.start = timestamp;
      if (timestamp > existing.dateRange.end) existing.dateRange.end = timestamp;
      if (opHash && !existing.txHashSet.has(opHash)) {
        existing.txHashSet.add(opHash);
        existing.txHashes.push(opHash);
      }
      if (!existing.alias && displayAlias && displayAlias !== keyAddress) {
        existing.alias = displayAlias;
      }
    } else {
      const txHashSet = new Set(opHash ? [opHash] : []);
      map.set(keyAddress, {
        realAddress: keyAddress,
        alias: displayAlias && displayAlias !== keyAddress ? displayAlias : '',
        address: displayAlias || keyAddress, // Preserves display label compatibility
        amount,
        count: 1,
        dateRange: { start: timestamp, end: timestamp },
        txHashes: opHash ? [opHash] : [],
        txHashSet,
        isSpecial
      });
    }
  }

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
      recordFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true);
    } else if (operation.type === 'migration' && operation.kind === 'bootstrap') {
      const accAddr = operation.account?.address || tezosAddress;
      const accAlias = operation.account?.alias || accAddr;
      addressToAliasMap.set(accAddr, accAlias);

      const specialKey = '~Bootstrap~';
      const amount = parseFloat(operation.balanceChange / 1_000_000);
      recordFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true);
    } else if (operation.type === 'migration' && operation.kind === 'subsidy') {
      const accAddr = operation.account?.address || tezosAddress;
      const accAlias = operation.account?.alias || accAddr;
      addressToAliasMap.set(accAddr, accAlias);

      const specialKey = '~Subsidy~';
      const amount = parseFloat(operation.balanceChange / 1_000_000);
      recordFlow(inflowsMap, specialKey, specialKey, amount, timestamp, operation.hash, true);
    } else if (operation.type === 'origination') {
      if (operation.contractBalance > 0) {
        const origAddr = operation.originatedContract?.address || '';
        const origAlias = operation.originatedContract?.alias || origAddr;
        const amount = parseFloat(operation.contractBalance / 1_000_000);

        if (senderAddr === tezosAddress && origAddr) {
          addressToAliasMap.set(senderAddr, senderAlias);
          addressToAliasMap.set(origAddr, origAlias);
          recordFlow(outflowsMap, origAddr, origAlias, amount, timestamp, operation.hash, false);
        } else if (origAddr === tezosAddress && senderAddr) {
          addressToAliasMap.set(senderAddr, senderAlias);
          addressToAliasMap.set(origAddr, origAlias);
          recordFlow(inflowsMap, senderAddr, senderAlias, amount, timestamp, operation.hash, false);
        }
      }
    } else if (!operation.type || operation.type === 'transaction') {
      if (senderAddr) addressToAliasMap.set(senderAddr, senderAlias);
      if (targetAddr) addressToAliasMap.set(targetAddr, targetAlias);

      const amount = parseFloat(operation.amount / 1_000_000);
      if (amount > 0) {
        if (senderAddr === tezosAddress && targetAddr) {
          recordFlow(outflowsMap, targetAddr, targetAlias, amount, timestamp, operation.hash, false);
        }
        if (targetAddr === tezosAddress && senderAddr && senderAddr !== tezosAddress) {
          recordFlow(inflowsMap, senderAddr, senderAlias, amount, timestamp, operation.hash, false);
        }
      }
    }
  });

  const minTez = parseFloat(tezLimitVal) || 0;
  const allInflowsCount = inflowsMap.size;
  const allOutflowsCount = outflowsMap.size;

  const inflows = [...inflowsMap.values()].filter((entry) => entry.amount >= minTez);
  const outflows = [...outflowsMap.values()].filter((entry) => entry.amount >= minTez);

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

  if (!result || !result.operations || result.operations.length === 0) {
    showNotification('No operations found for this address');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) {
      emptyState.style.display = 'block';
      emptyState.querySelector('h2').textContent = 'No Value Flows Found';
      emptyState.querySelector('p').textContent = `No applied XTZ operations were found for "${tezosAddress}". Check the address or try another wallet or contract.`;
    }
    return;
  }

  currentRawData = result.operations;
  currentAccountInfo = result.accountInfo;

  if (historyIndex === -1 || history[historyIndex] !== tezosAddress) {
    updateHistory(tezosAddress);
  }

  refreshDiagramFromMemory();
}

function refreshDiagramFromMemory() {
  const tezLimitVal = tezLimitSlider.value;
  currentParsed = parseTransactions(currentRawData, currentAddress, tezLimitVal);

  const { inflows, outflows, addressToAliasMap } = currentParsed;
  if (currentAccountInfo?.alias) {
    addressToAliasMap.set(currentAddress, currentAccountInfo.alias);
  }

  updateStatsStrip(currentAddress, inflows, outflows, currentRawData.length, currentAccountInfo);

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('stats-strip').style.display = 'grid';
  document.getElementById('sankey-workspace').style.display = 'flex';
  const colHeadersEl = document.getElementById('sankey-col-headers');
  if (colHeadersEl) colHeadersEl.style.display = '';
  document.getElementById('sankey-diagram').style.display = 'block';

  renderCurrentSankey();
}

function updateStatsStrip(targetAddress, inflows, outflows, opsCount, accountInfo) {
  const externalInflows = inflows.filter((e) => !e.isSelfTransfer);
  const externalOutflows = outflows.filter((e) => !e.isSelfTransfer);
  const selfEntry = outflows.find((o) => o.isSelfTransfer);

  const numInflows = externalInflows.length;
  const amInflows = externalInflows.reduce((sum, e) => sum + (e.amount || 0), 0);
  const txInflows = externalInflows.reduce((sum, e) => sum + (e.count || 0), 0);

  const numOutflows = externalOutflows.length;
  const amOutflows = externalOutflows.reduce((sum, e) => sum + (e.amount || 0), 0);
  const txOutflows = externalOutflows.reduce((sum, e) => sum + (e.count || 0), 0);

  const netFlow = amInflows - amOutflows;
  const netSign = netFlow > 0 ? '+' : '';

  console.log(
    `inputs:${numInflows}; outputs:${numOutflows}\r\nin:${amInflows.toFixed(2)}; out:${amOutflows.toFixed(2)}`
  );

  document.getElementById('stat-inflow-val').textContent = formatTez(amInflows);
  document.getElementById('stat-inflow-meta').textContent = `${numInflows.toLocaleString()} senders • ${txInflows.toLocaleString()} txes`;

  document.getElementById('stat-outflow-val').textContent = formatTez(amOutflows);
  document.getElementById('stat-outflow-meta').textContent = `${numOutflows.toLocaleString()} receivers • ${txOutflows.toLocaleString()} txes`;

  const netEl = document.getElementById('stat-net-val');
  netEl.textContent = `${netSign}${formatTez(netFlow)}`;
  netEl.style.color = netFlow >= 0 ? 'var(--inflow-light)' : 'var(--outflow-light)';

  const balanceStr = accountInfo && typeof accountInfo.balance === 'number'
    ? `Live balance: ${formatTez(accountInfo.balance / 1_000_000)}`
    : 'Filtered net delta';
  document.getElementById('stat-net-meta').textContent = balanceStr;

  document.getElementById('stat-scope-val').textContent = `${opsCount.toLocaleString()} ops`;
  const biCount = externalInflows.filter((i) => i.isBidirectional).length;
  const metaParts = [];
  if (biCount > 0) metaParts.push(`${biCount} bidirectional (⇄)`);
  if (selfEntry) metaParts.push(`${selfEntry.count} self-tx (${formatTez(selfEntry.amount, true)} ↺)`);
  document.getElementById('stat-scope-meta').textContent =
    metaParts.length > 0 ? metaParts.join(' • ') : 'Click any node to copy & pivot';
}

// ============================================================================
// High-Readability Custom SVG Sankey Diagram Engine
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

function sortAndGroupFlows(entries, side, totalAmount) {
  const query = viewConfig.searchQuery;
  let filtered = entries;
  if (query) {
    filtered = entries.filter(
      (e) =>
        e.realAddress.toLowerCase().includes(query) ||
        (e.alias && e.alias.toLowerCase().includes(query))
    );
  }

  const sorted = [...filtered].sort((a, b) => {
    if (viewConfig.circularFlows && side === 'in' && a.isBidirectional !== b.isBidirectional) {
      return a.isBidirectional ? -1 : 1;
    }
    if (viewConfig.sortMode === 'count') {
      return b.count - a.count || b.amount - a.amount;
    }
    if (viewConfig.sortMode === 'recent') {
      return b.dateRange.end.getTime() - a.dateRange.end.getTime();
    }
    return b.amount - a.amount;
  });

  const maxN = viewConfig.maxNodes || 50;
  if (sorted.length <= maxN) {
    return sorted.map((item) => ({
      ...item,
      sharePct: totalAmount > 0 ? (item.amount / totalAmount) * 100 : 0,
      isAggregate: false
    }));
  }

  const topItems = sorted.slice(0, maxN).map((item) => ({
    ...item,
    sharePct: totalAmount > 0 ? (item.amount / totalAmount) * 100 : 0,
    isAggregate: false
  }));

  const restItems = sorted.slice(maxN);
  let restAmount = 0;
  let restCount = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const restHashes = [];

  for (let i = 0; i < restItems.length; i++) {
    const e = restItems[i];
    restAmount += e.amount;
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
  }
  const minDate = new Date(minTs === Infinity ? Date.now() : minTs);
  const maxDate = new Date(maxTs === -Infinity ? Date.now() : maxTs);

  topItems.push({
    realAddress: `__aggregate_${side}__`,
    alias: `+ ${restItems.length} smaller ${side === 'in' ? 'senders' : 'receivers'}`,
    address: `+ ${restItems.length} smaller ${side === 'in' ? 'senders' : 'receivers'}`,
    amount: restAmount,
    count: restCount,
    dateRange: { start: minDate, end: maxDate },
    txHashes: restHashes,
    sharePct: totalAmount > 0 ? (restAmount / totalAmount) * 100 : 0,
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
  // Default: 'sqrt' (Balanced)
  return Math.sqrt(v);
}

function drawSankeyDiagram(targetAddress, rawInflows, rawOutflows, addressToAliasMap, txHashesMap) {
  const container = document.getElementById('sankey-diagram');
  if (!container) return;

  const externalRawOutflows = rawOutflows.filter((e) => !e.isSelfTransfer);
  const totalInAmount = rawInflows.reduce((s, e) => s + e.amount, 0);
  const totalOutAmount = externalRawOutflows.reduce((s, e) => s + e.amount, 0);

  const inflows = sortAndGroupFlows(rawInflows, 'in', totalInAmount);

  // If Circular Flows mode (↺) is active, match visible inflow nodes that also received return funds, plus Hub self-transfers
  const rawOutflowMap = new Map(rawOutflows.map((o) => [o.realAddress, o]));
  const mergedCircularAddresses = new Set();
  let selfLoopEntry = null;

  if (viewConfig.circularFlows) {
    // 1. Check if the Hub sent funds to itself (Self-Transfer: Hub -> Hub)
    const rawSelf = rawOutflowMap.get(targetAddress);
    if (rawSelf && rawSelf.amount > 0) {
      selfLoopEntry = {
        ...rawSelf,
        isSelfTransfer: true,
        sharePct: 100
      };
      mergedCircularAddresses.add(targetAddress);
    }

    // 2. Match visible inflow senders that received return funds from the Hub
    inflows.forEach((item) => {
      if (!item.isAggregate && item.realAddress !== targetAddress && rawOutflowMap.has(item.realAddress)) {
        const retEntry = rawOutflowMap.get(item.realAddress);
        if (retEntry && retEntry.amount > 0) {
          item.hasCircularReturn = true;
          item.returnEntry = retEntry;
          item.returnAmount = retEntry.amount;
          item.returnCount = retEntry.count;
          item.returnSharePct = totalOutAmount > 0 ? (retEntry.amount / totalOutAmount) * 100 : 0;
          mergedCircularAddresses.add(item.realAddress);
        }
      }
    });
  }

  const effectiveRawOutflows = viewConfig.circularFlows
    ? externalRawOutflows.filter((o) => !mergedCircularAddresses.has(o.realAddress))
    : rawOutflows;
  const outflows = sortAndGroupFlows(effectiveRawOutflows, 'out', totalOutAmount);

  // Update column headers
  const hdrIn = document.getElementById('hdr-inflows-label');
  const hdrOut = document.getElementById('hdr-outflows-label');
  const hdrCenter = document.getElementById('hdr-center-label');
  if (hdrIn) {
    const circNote = mergedCircularAddresses.size > 0 ? ` • ${mergedCircularAddresses.size} Circular ↺` : '';
    hdrIn.textContent = `Inflows (${rawInflows.length} Senders • ${formatTez(totalInAmount, true)}${circNote})`;
  }
  if (hdrOut) {
    hdrOut.textContent = `Outflows (${externalRawOutflows.length} Receivers • ${formatTez(totalOutAmount, true)})`;
  }
  const hubAlias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || shortenAddress(targetAddress);
  if (hdrCenter) {
    hdrCenter.textContent = `Target Hub — ${hubAlias}`;
  }

  // Handle case where filter hid all nodes
  if (inflows.length === 0 && outflows.length === 0 && !selfLoopEntry) {
    container.innerHTML = `
      <div style="padding: 64px 24px; text-align: center; color: var(--text-secondary);">
        <i class="fa-solid fa-filter-circle-xmark" style="font-size: 2rem; color: var(--accent-primary); margin-bottom: 12px;"></i>
        <div style="font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">No counterparties match current filter</div>
        <div style="font-size: 0.85rem;">Try lowering the Min Flow (ꜩ) slider or clearing the node search box.</div>
      </div>
    `;
    return;
  }

  // Geometry constants
  const containerWidth = Math.max(1020, container.clientWidth || 1280);
  const W = containerWidth;
  const padX = 24;
  const circularCount = mergedCircularAddresses.size;
  const padYTop = circularCount > 0 ? Math.min(145, 68 + circularCount * 12) : 28;
  const padYBottom = circularCount > 0 ? Math.min(130, 56 + circularCount * 12) : 28;
  const cardW = Math.min(310, Math.max(245, Math.floor(W * 0.24)));
  const hubW = 214;

  const minCardH = 44;
  const maxExtraH = 42;
  const nodeGap = 9;

  // Compute weights for scaling node heights & ribbon thicknesses
  const allAmounts = [
    ...inflows.map((e) => e.amount),
    ...inflows.filter((e) => e.hasCircularReturn).map((e) => e.returnAmount),
    ...outflows.map((e) => e.amount),
    ...(selfLoopEntry ? [selfLoopEntry.amount] : [])
  ];
  let maxWeight = 0.0001;
  for (let i = 0; i < allAmounts.length; i++) {
    const w = computeScaledWeight(allAmounts[i], viewConfig.scaleMode);
    if (w > maxWeight) maxWeight = w;
  }

  function layoutColumn(items, xPos) {
    let curY = padYTop;
    const laidOut = items.map((item, idx) => {
      const w = computeScaledWeight(item.amount, viewConfig.scaleMode);
      const norm = w / maxWeight;
      const baseH = Math.round(minCardH + norm * maxExtraH);
      const h = item.hasCircularReturn ? Math.max(60, baseH + 14) : baseH;
      const retW = item.hasCircularReturn ? computeScaledWeight(item.returnAmount, viewConfig.scaleMode) : 0;
      const retNorm = item.hasCircularReturn ? retW / maxWeight : 0;
      const node = {
        ...item,
        index: idx,
        x: xPos,
        y: curY,
        w: cardW,
        h,
        weight: w,
        normWeight: norm,
        returnWeight: retW,
        returnNormWeight: retNorm
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

  // Compute Hub port rail heights and exact ribbon thicknesses
  const circularNodes = leftCol.nodes.filter((n) => n.hasCircularReturn);
  if (selfLoopEntry) {
    selfLoopEntry.weight = computeScaledWeight(selfLoopEntry.amount, viewConfig.scaleMode);
  }

  const leftTotalWeight =
    leftCol.nodes.reduce((s, n) => s + n.weight, 0) + (selfLoopEntry ? selfLoopEntry.weight : 0) || 1;
  const rightTotalWeight =
    rightCol.nodes.reduce((s, n) => s + n.weight, 0) +
      circularNodes.reduce((s, n) => s + n.returnWeight, 0) +
      (selfLoopEntry ? selfLoopEntry.weight : 0) || 1;

  const totalLeftCount = leftCol.nodes.length + (selfLoopEntry ? 1 : 0);
  const totalRightCount = rightCol.nodes.length + circularNodes.length + (selfLoopEntry ? 1 : 0);
  const leftGap = totalLeftCount > 40 ? 0.8 : 1.5;
  const rightGap = totalRightCount > 40 ? 0.8 : 1.5;

  const targetLeftSpan = Math.min(340, Math.max(80, totalLeftCount * 7));
  const targetRightSpan = Math.min(340, Math.max(80, totalRightCount * 7));

  if (selfLoopEntry) {
    selfLoopEntry.portThickness = Math.max(
      3.5,
      Math.min(18, (selfLoopEntry.weight / rightTotalWeight) * targetRightSpan)
    );
  }

  leftCol.nodes.forEach((n) => {
    n.portThickness = Math.max(2.2, (n.weight / leftTotalWeight) * targetLeftSpan);
    if (n.hasCircularReturn) {
      n.returnPortThickness = Math.max(2.4, (n.returnWeight / rightTotalWeight) * targetRightSpan);
    }
  });
  rightCol.nodes.forEach((n) => {
    n.portThickness = Math.max(2.2, (n.weight / rightTotalWeight) * targetRightSpan);
  });

  const leftPortSpan =
    leftCol.nodes.reduce((s, n) => s + n.portThickness, 0) +
    (selfLoopEntry ? selfLoopEntry.portThickness : 0) +
    Math.max(0, totalLeftCount - 1) * leftGap;
  const rightPortSpan =
    rightCol.nodes.reduce((s, n) => s + n.portThickness, 0) +
    circularNodes.reduce((s, n) => s + n.returnPortThickness, 0) +
    (selfLoopEntry ? selfLoopEntry.portThickness : 0) +
    Math.max(0, totalRightCount - 1) * rightGap;

  const hubCardH = Math.max(238, Math.max(leftPortSpan, rightPortSpan) + 44);
  const hubX = (W - hubW) / 2;

  // Position Hub comfortably near center while respecting top/bottom circular loop clearance
  const hubCenterY = Math.min(
    H - padYBottom - hubCardH / 2 - 10,
    Math.max(padYTop + hubCardH / 2 + 12, Math.min(360 + padYTop / 2, H / 2))
  );
  const hubY = hubCenterY - hubCardH / 2;

  // Align shorter column around hubCenterY so small inflow/outflow sets aren't buried far down
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

  // Assign Left Inflow ribbon endpoints (with selfLoopEntry occupying the top slot if present)
  let curLeftPortY = hubCenterY - leftPortSpan / 2;
  if (selfLoopEntry) {
    selfLoopEntry.targetY0 = curLeftPortY;
    selfLoopEntry.targetY1 = curLeftPortY + selfLoopEntry.portThickness;
    curLeftPortY += selfLoopEntry.portThickness + leftGap;
  }

  leftCol.nodes.forEach((n) => {
    if (n.hasCircularReturn) {
      // Upper half of right edge is Inflow (Node -> Hub), lower half is Circular Return (Hub -> Node)
      const topHalfMidY = n.y + n.h * 0.3;
      const botHalfMidY = n.y + n.h * 0.72;
      const inRibbonH = Math.max(3.5, Math.min(n.h * 0.36, 5 + n.normWeight * (n.h * 0.32)));
      const retRibbonH = Math.max(3.5, Math.min(n.h * 0.34, 4.5 + n.returnNormWeight * (n.h * 0.3)));

      n.sourceY0 = topHalfMidY - inRibbonH / 2;
      n.sourceY1 = topHalfMidY + inRibbonH / 2;

      n.circTargetY0 = botHalfMidY - retRibbonH / 2;
      n.circTargetY1 = botHalfMidY + retRibbonH / 2;
      n.circRibbonThickness = Math.max(3, (retRibbonH + n.returnPortThickness) / 2);
    } else {
      const nodeRibbonH = Math.max(4, Math.min(n.h - 10, 6 + n.normWeight * (n.h - 14)));
      const midNodeY = n.y + n.h / 2;
      n.sourceY0 = midNodeY - nodeRibbonH / 2;
      n.sourceY1 = midNodeY + nodeRibbonH / 2;
    }

    n.targetY0 = curLeftPortY;
    n.targetY1 = curLeftPortY + n.portThickness;
    curLeftPortY += n.portThickness + leftGap;
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

  topCircularNodes.forEach((n, idx) => {
    n.circSourceY0 = curRightPortY;
    n.circSourceY1 = curRightPortY + n.returnPortThickness;
    n.isTopLoop = true;
    // Outermost loop (idx 0, highest node) arches highest over the Hub
    n.loopOrder = topCircularNodes.length - 1 - idx;
    curRightPortY += n.returnPortThickness + rightGap;
  });

  rightCol.nodes.forEach((n) => {
    const nodeRibbonH = Math.max(4, Math.min(n.h - 10, 6 + n.normWeight * (n.h - 14)));
    const midNodeY = n.y + n.h / 2;

    n.sourceY0 = curRightPortY;
    n.sourceY1 = curRightPortY + n.portThickness;
    n.targetY0 = midNodeY - nodeRibbonH / 2;
    n.targetY1 = midNodeY + nodeRibbonH / 2;
    curRightPortY += n.portThickness + rightGap;
  });

  bottomCircularNodes.forEach((n, idx) => {
    n.circSourceY0 = curRightPortY;
    n.circSourceY1 = curRightPortY + n.returnPortThickness;
    n.isTopLoop = false;
    // Innermost loop (idx 0) arches closest under the Hub; lowest node arches deepest
    n.loopOrder = idx;
    curRightPortY += n.returnPortThickness + rightGap;
  });

  // Helper to build closed Cubic Bezier ribbon path
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

  // Helper to build smooth G1-continuous circular return loop around the Hub (Hub Right -> Left Node Return Port)
  function buildCircularLoopPath(n) {
    const xStart = hubX + hubW;
    const yStart = (n.circSourceY0 + n.circSourceY1) / 2;
    const xEnd = padX + cardW;
    const yEnd = (n.circTargetY0 + n.circTargetY1) / 2;
    const order = n.loopOrder || 0;
    const selfClearance = selfLoopEntry ? 26 : 0;
    const apexX = hubX + hubW * 0.35;

    const apexY = n.isTopLoop
      ? Math.max(14, Math.min(hubY - 24 - selfClearance - order * 12, yEnd - 26))
      : Math.min(H - 14, Math.max(hubY + hubCardH + 22 + order * 12, yEnd + 26));

    const c1x = xStart + 54 + order * 12;
    const c1y = yStart;
    const c2x = apexX + 82;
    const c2y = apexY;

    const c3x = apexX - 88;
    const c3y = apexY;
    const c4x = xEnd + 66 + order * 10;
    const c4y = yEnd;

    return `M ${xStart} ${yStart} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${apexX} ${apexY} C ${c3x} ${c3y}, ${c4x} ${c4y}, ${xEnd} ${yEnd}`;
  }

  // Helper to build Hub Self-Transfer Crown Loop (Hub Right Outflow Port -> Crown Arch -> Hub Left Inflow Port)
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

  // Build SVG markup
  const defsMarkup = `
    <defs>
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

  // Render ribbons
  const leftRibbonX0 = padX + cardW;
  const leftRibbonX1 = hubX;
  const rightRibbonX0 = hubX + hubW;
  const rightRibbonX1 = W - padX - cardW;

  const inflowLinksMarkup = leftCol.nodes
    .map((n) => {
      const d = buildRibbonPath(leftRibbonX0, n.sourceY0, n.sourceY1, leftRibbonX1, n.targetY0, n.targetY1);
      const centerD = buildCenterlinePath(
        leftRibbonX0,
        (n.sourceY0 + n.sourceY1) / 2,
        leftRibbonX1,
        (n.targetY0 + n.targetY1) / 2
      );
      const gradId = n.isSpecial ? 'url(#grad-special)' : 'url(#grad-inflow)';
      return `
        <g class="sankey-link-wrap" data-side="in" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}">
          <path class="sankey-link sankey-ribbon-link" d="${d}" fill="${gradId}" fill-opacity="0.36" stroke="${n.isSpecial ? '#f59e0b' : '#10b981'}" stroke-width="0.6" stroke-opacity="0.45" />
          <path class="sankey-link-flow" d="${centerD}" stroke-width="2" />
        </g>
      `;
    })
    .join('');

  const circularLinksMarkup = circularNodes
    .map((n) => {
      const loopD = buildCircularLoopPath(n);
      const strokeW = Math.max(3.5, Math.min(22, n.circRibbonThickness || 6)).toFixed(1);
      return `
        <g class="sankey-link-wrap sankey-circular-wrap" data-side="in" data-circular="true" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}">
          <path class="sankey-link sankey-circular-link" d="${loopD}" fill="none" stroke="url(#grad-circular)" stroke-width="${strokeW}" stroke-opacity="0.46" stroke-linecap="butt" />
          <path class="sankey-link-flow" d="${loopD}" stroke-width="2" />
        </g>
      `;
    })
    .join('');

  let selfLoopMarkup = '';
  if (selfLoopEntry) {
    const { pathD, apexX, apexY } = buildSelfLoopPath(selfLoopEntry);
    const strokeW = Math.max(4, Math.min(18, selfLoopEntry.portThickness || 6)).toFixed(1);
    const pillLabel = `↺ Self: ${formatTez(selfLoopEntry.amount, true)} (${selfLoopEntry.count})`;
    const pillW = Math.max(114, pillLabel.length * 6.4 + 18);
    selfLoopMarkup = `
      <g class="sankey-link-wrap sankey-self-loop-wrap" id="sankey-self-loop" data-side="self" data-circular="true" data-index="-1" data-addr="${escapeHtml(targetAddress)}" style="cursor: pointer;">
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
    .map((n) => {
      const d = buildRibbonPath(rightRibbonX0, n.sourceY0, n.sourceY1, rightRibbonX1, n.targetY0, n.targetY1);
      const centerD = buildCenterlinePath(
        rightRibbonX0,
        (n.sourceY0 + n.sourceY1) / 2,
        rightRibbonX1,
        (n.targetY0 + n.targetY1) / 2
      );
      return `
        <g class="sankey-link-wrap" data-side="out" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}">
          <path class="sankey-link sankey-ribbon-link" d="${d}" fill="url(#grad-outflow)" fill-opacity="0.36" stroke="#f43f5e" stroke-width="0.6" stroke-opacity="0.45" />
          <path class="sankey-link-flow" d="${centerD}" stroke-width="2" />
        </g>
      `;
    })
    .join('');

  // Render Node Card helper
  function renderNodeCard(n, side) {
    const isLeft = side === 'in';
    const accentColor = n.isSpecial ? '#f59e0b' : n.isSelfTransfer ? '#38bdf8' : isLeft ? '#10b981' : '#f43f5e';
    const shareBarW = Math.max(4, Math.min(n.w - 12, (n.sharePct / 100) * (n.w - 12)));
    const primaryTitle = n.alias ? truncateText(n.alias, 19) : shortenAddress(n.realAddress);
    const biBadge = n.isSelfTransfer
      ? ' ↺ (Self)'
      : n.hasCircularReturn
      ? ' ↺'
      : n.isBidirectional
      ? ' ⇄'
      : '';
    const subTitle = n.isAggregate
      ? `${n.count.toLocaleString()} txes combined • Click to expand`
      : n.hasCircularReturn
      ? `${n.alias ? shortenAddress(n.realAddress) + ' • ' : ''}${n.count} in / ${n.returnCount} out`
      : `${n.alias ? shortenAddress(n.realAddress) + ' • ' : ''}${n.count} tx${n.count > 1 ? 'es' : ''}`;

    const amountStr = formatTez(n.amount, true);
    const pctStr = `${n.sharePct >= 10 ? n.sharePct.toFixed(1) : n.sharePct.toFixed(2)}%`;

    const portBarX = isLeft ? n.x + n.w - 5 : n.x;
    const inspectBtnX = isLeft ? n.x + 8 : n.x + n.w - 28;
    const textLeftX = isLeft ? n.x + 34 : n.x + 14;
    const amountRightX = isLeft ? n.x + n.w - 12 : n.x + n.w - 34;

    const midY = n.y + n.h / 2;

    const portStripMarkup = n.hasCircularReturn
      ? `
        <rect x="${portBarX}" y="${n.y + 4}" width="5" height="${Math.max(8, n.h / 2 - 5)}" rx="2.5" fill="#10b981" />
        <rect x="${portBarX}" y="${n.y + n.h / 2 + 1}" width="5" height="${Math.max(8, n.h / 2 - 5)}" rx="2.5" fill="#ec4899" />
      `
      : `<rect x="${portBarX}" y="${n.y + 4}" width="5" height="${n.h - 8}" rx="2.5" fill="${accentColor}" />`;

    const rightMetricsMarkup = n.hasCircularReturn
      ? `
        <text x="${amountRightX}" y="${midY - 6}" text-anchor="end" fill="#10b981" font-family="JetBrains Mono, monospace" font-size="11.5" font-weight="700">
          +${escapeHtml(amountStr)}
        </text>
        <text x="${amountRightX}" y="${midY + 11}" text-anchor="end" fill="#f472b6" font-family="JetBrains Mono, monospace" font-size="10.8" font-weight="600">
          ↺ -${escapeHtml(formatTez(n.returnAmount, true))}
        </text>
      `
      : `
        <text x="${amountRightX}" y="${midY - 4}" text-anchor="end" fill="${accentColor}" font-family="JetBrains Mono, monospace" font-size="12" font-weight="700">
          ${escapeHtml(amountStr)}
        </text>
        <text x="${amountRightX}" y="${midY + 12}" text-anchor="end" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="10">
          ${escapeHtml(pctStr)}
        </text>
      `;

    return `
      <g class="sankey-node-group" data-side="${side}" data-index="${n.index}" data-addr="${escapeHtml(n.realAddress)}">
        <!-- Base Card -->
        <rect class="sankey-node-card" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9"
              fill="${n.isAggregate ? 'rgba(30, 41, 82, 0.85)' : 'rgba(15, 20, 44, 0.88)'}"
              stroke="${
                n.isSelfTransfer
                  ? 'rgba(56, 189, 248, 0.6)'
                  : n.hasCircularReturn
                  ? 'rgba(236, 72, 153, 0.55)'
                  : n.isBidirectional
                  ? 'rgba(129, 140, 248, 0.5)'
                  : 'rgba(255, 255, 255, 0.1)'
              }"
              stroke-width="1" />

        <!-- Subtle Volume Share Progress Bar along bottom -->
        <rect x="${isLeft ? n.x + n.w - 6 - shareBarW : n.x + 6}" y="${n.y + n.h - 3}" width="${shareBarW}" height="2" rx="1"
              fill="${accentColor}" fill-opacity="0.65" />

        <!-- Inner Port Accent Strip -->
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

        <!-- Primary Label (Alias or Short Address) -->
        <text x="${textLeftX}" y="${midY - 4}" fill="#f8fafc" font-family="Inter, sans-serif" font-size="12.5" font-weight="600">
          ${escapeHtml(primaryTitle)}${escapeHtml(biBadge)}
        </text>

        <!-- Secondary Meta (Address & Tx Count) -->
        <text x="${textLeftX}" y="${midY + 12}" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10.2">
          ${escapeHtml(subTitle)}
        </text>

        <!-- Right-aligned Amount & Share % / Circular Return -->
        ${rightMetricsMarkup}
      </g>
    `;
  }

  const leftNodesMarkup = leftCol.nodes.map((n) => renderNodeCard(n, 'in')).join('');
  const rightNodesMarkup = rightCol.nodes.map((n) => renderNodeCard(n, 'out')).join('');

  // Render Center Target Account Hub (content centered around hubCenterY)
  const hubRawAlias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || '';
  const hubTitle = truncateText(hubRawAlias || shortenAddress(targetAddress), 22);
  const hubShortAddr = shortenAddress(targetAddress);
  const hubInitial = (hubRawAlias || targetAddress || 'T').replace(/^~/, '').charAt(0).toUpperCase();
  const hubAvatarUrl = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(targetAddress)}`;
  const hubMidX = hubX + hubW / 2;
  const contentTopY = hubCenterY - 96;
  const avatarCy = contentTopY + 46;
  const avatarR = 19;

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
        totalLeftCount > 0
          ? `<rect x="${hubX}" y="${hubCenterY - leftPortSpan / 2}" width="6" height="${leftPortSpan}" rx="3" fill="#10b981" />`
          : ''
      }

      <!-- Right Outflow Port Rail -->
      ${
        totalRightCount > 0
          ? `<rect x="${hubX + hubW - 6}" y="${hubCenterY - rightPortSpan / 2}" width="6" height="${rightPortSpan}" rx="3" fill="#f43f5e" />`
          : ''
      }

      <!-- Hub Badge -->
      <rect x="${hubMidX - 46}" y="${contentTopY}" width="92" height="20" rx="10" fill="rgba(99, 102, 241, 0.25)" stroke="rgba(129, 140, 248, 0.4)" />
      <text x="${hubMidX}" y="${contentTopY + 13}" text-anchor="middle" fill="#c7d2fe" font-family="Inter, sans-serif" font-size="9.5" font-weight="700" letter-spacing="0.8">
        TARGET HUB
      </text>

      <!-- Hub Avatar (between TARGET HUB label and Alias/Address) -->
      <circle cx="${hubMidX}" cy="${avatarCy}" r="${avatarR}" fill="#312e81" />
      <text x="${hubMidX}" y="${avatarCy + 5}" text-anchor="middle" fill="#c7d2fe" font-family="Space Grotesk, Inter, sans-serif" font-size="14" font-weight="700">
        ${escapeHtml(hubInitial)}
      </text>
      <image class="hub-avatar-img" href="${hubAvatarUrl}" x="${hubMidX - avatarR}" y="${avatarCy - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" clip-path="url(#hub-avatar-clip)" preserveAspectRatio="xMidYMid slice" />
      <circle cx="${hubMidX}" cy="${avatarCy}" r="${avatarR + 0.5}" fill="none" stroke="#818cf8" stroke-width="1.5" />

      <!-- Target Alias & Short Address -->
      <text x="${hubMidX}" y="${contentTopY + 84}" text-anchor="middle" fill="#ffffff" font-family="Space Grotesk, Inter, sans-serif" font-size="14.5" font-weight="700">
        ${escapeHtml(hubTitle)}
      </text>
      <text x="${hubMidX}" y="${contentTopY + 101}" text-anchor="middle" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11">
        ${escapeHtml(hubShortAddr)}
      </text>

      <!-- Divider -->
      <line x1="${hubX + 20}" y1="${contentTopY + 114}" x2="${hubX + hubW - 20}" y2="${contentTopY + 114}" stroke="rgba(255,255,255,0.1)" />

      <!-- Hub Inflow Metric -->
      <text x="${hubX + 22}" y="${contentTopY + 135}" fill="#94a3b8" font-family="Inter, sans-serif" font-size="10.5">In (${rawInflows.length})</text>
      <text x="${hubX + hubW - 22}" y="${contentTopY + 135}" text-anchor="end" fill="#34d399" font-family="JetBrains Mono, monospace" font-size="11.5" font-weight="700">
        +${escapeHtml(formatTez(totalInAmount, true))}
      </text>

      <!-- Hub Outflow Metric -->
      <text x="${hubX + 22}" y="${contentTopY + 156}" fill="#94a3b8" font-family="Inter, sans-serif" font-size="10.5">Out (${externalRawOutflows.length})</text>
      <text x="${hubX + hubW - 22}" y="${contentTopY + 156}" text-anchor="end" fill="#fb7185" font-family="JetBrains Mono, monospace" font-size="11.5" font-weight="700">
        -${escapeHtml(formatTez(totalOutAmount, true))}
      </text>

      <!-- Hub Footer Hint -->
      <text x="${hubMidX}" y="${contentTopY + 182}" text-anchor="middle" fill="#818cf8" font-family="Inter, sans-serif" font-size="10">
        Click to copy address
      </text>
    </g>
  `;

  const isDense = leftCol.nodes.length + rightCol.nodes.length > 120;

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

  // Bind Hover, Click, and Inspector Events
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

  // Build O(1) lookup tables by address and by (side:index) so hover never scans O(N) DOM elements
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
    registerIndexedEl(key, lw.dataset.addr, 'links', { pathEl, flowEl });
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

  function highlightConnection(addr, side, index) {
    const key = `${side}:${index}`;
    // Clear only previously highlighted 1-4 elements (O(1))
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

    activeLinks = bucket.links;
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

  function showNodeTooltip(evt, entry, side) {
    if (!tooltip || !entry) return;
    const isLeft = side === 'in';
    const badgeClass = entry.isSelfTransfer ? 'hub' : isLeft ? 'inflow' : 'outflow';
    const badgeText = entry.isSpecial
      ? 'Protocol Flow'
      : entry.isSelfTransfer
      ? 'Self-Transfer (Hub ↺ Hub)'
      : entry.hasCircularReturn
      ? 'Circular Flow ↺'
      : isLeft
      ? entry.isBidirectional
        ? 'Inflow • Bidirectional ⇄'
        : 'Inflow (Sender)'
      : entry.isBidirectional
      ? 'Outflow • Bidirectional ⇄'
      : 'Outflow (Receiver)';

    const startStr = formatDateShort(entry.dateRange?.start);
    const endStr = formatDateShort(entry.dateRange?.end);
    const dateSpan = startStr === endStr ? startStr : `${startStr} → ${endStr}`;

    const metricsGridHtml = entry.hasCircularReturn
      ? `
        <div class="tt-grid">
          <div class="tt-metric">
            <div class="tt-metric-lbl">Sent to Hub (${entry.count} tx)</div>
            <div class="tt-metric-val" style="color: var(--inflow-light);">+${escapeHtml(formatTez(entry.amount))}</div>
          </div>
          <div class="tt-metric">
            <div class="tt-metric-lbl">Returned ↺ (${entry.returnCount} tx)</div>
            <div class="tt-metric-val" style="color: #f472b6;">-${escapeHtml(formatTez(entry.returnAmount))}</div>
          </div>
        </div>
      `
      : entry.isSelfTransfer
      ? `
        <div class="tt-grid">
          <div class="tt-metric">
            <div class="tt-metric-lbl">Self-Transfer Volume</div>
            <div class="tt-metric-val">${escapeHtml(formatTez(entry.amount))}</div>
          </div>
          <div class="tt-metric">
            <div class="tt-metric-lbl">Net Flow Impact</div>
            <div class="tt-metric-val" style="color: #38bdf8;">0 ꜩ (${entry.count} tx)</div>
          </div>
        </div>
      `
      : `
        <div class="tt-grid">
          <div class="tt-metric">
            <div class="tt-metric-lbl">Volume</div>
            <div class="tt-metric-val">${escapeHtml(formatTez(entry.amount))}</div>
          </div>
          <div class="tt-metric">
            <div class="tt-metric-lbl">Share &amp; Txes</div>
            <div class="tt-metric-val">${entry.sharePct.toFixed(2)}% (${entry.count} tx)</div>
          </div>
        </div>
      `;

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
        <span class="tt-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${metricsGridHtml}
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
    const totalIn = rawInflows.reduce((s, e) => s + e.amount, 0);
    const totalOut = externalOutflows.reduce((s, e) => s + e.amount, 0);
    const alias = addressToAliasMap.get(targetAddress) || currentAccountInfo?.alias || targetAddress;
    const avatarUrl = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(targetAddress)}`;
    tooltip.innerHTML = `
      <div class="tt-header">
        <img class="tt-avatar" src="${avatarUrl}" alt="" onerror="this.src='icons/tezos.png'">
        <div class="tt-title-wrap">
          <div class="tt-alias">${escapeHtml(alias)}</div>
          <div class="tt-address">${escapeHtml(targetAddress)}</div>
        </div>
        <span class="tt-badge hub">Target Hub</span>
      </div>
      <div class="tt-grid">
        <div class="tt-metric">
          <div class="tt-metric-lbl">Total In (${rawInflows.length})</div>
          <div class="tt-metric-val" style="color:var(--inflow-light);">+${escapeHtml(formatTez(totalIn))}</div>
        </div>
        <div class="tt-metric">
          <div class="tt-metric-lbl">Total Out (${externalOutflows.length})</div>
          <div class="tt-metric-val" style="color:var(--outflow-light);">-${escapeHtml(formatTez(totalOut))}</div>
        </div>
      </div>
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

  function copyEntryToClipboard(entry) {
    const relatedAddress = entry.realAddress;
    const txHashes = txHashesMap.get(relatedAddress) || entry.txHashes || [];
    const txHashesText = txHashes.map((hash) => `https://tzkt.io/${hash}`).join('\n');
    const clipboardText = `${relatedAddress}\n\n${txHashesText}`;
    navigator.clipboard
      .writeText(clipboardText)
      .then(() => {
        console.log(clipboardText);
      })
      .catch((err) => {
        console.error('Could not copy text:', err);
      });
    showNotification(`Copied ${shortenAddress(relatedAddress)} & ${txHashes.length} tx links`);
  }

  function handlePrimaryNodeAction(entry) {
    if (!entry) return;
    clearHighlight();

    // If aggregate node clicked, expand maxNodes to show more/all!
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
    if (
      relatedAddress !== '~Activation~' &&
      relatedAddress !== '~Bootstrap~' &&
      relatedAddress !== '~Subsidy~'
    ) {
      input.value = relatedAddress.trim();
      go();
    }
  }

  // Single Delegated Event Listeners on SVG (replaces 10 * N per-element listeners)
  svgEl.addEventListener('mouseover', (evt) => {
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
    const hoverKey = `${side}:${idx}`;
    if (currentHoverKey === hoverKey) return;

    currentHoverKey = hoverKey;
    const entry = getEntry(side, idx);
    if (entry) {
      highlightConnection(entry.realAddress, side, idx);
      showNodeTooltip(evt, entry, side);
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
      openInspectorDrawer(entry, side);
    }
  });
}

// ============================================================================
// Slide-over Transaction Inspector Drawer
// ============================================================================

const inspectorDrawer = document.getElementById('inspector-drawer');
let inspectedEntry = null;

function openInspectorDrawer(entry, side) {
  if (!inspectorDrawer || !entry) return;
  inspectedEntry = entry;

  document.getElementById('drawer-alias').textContent = entry.alias || shortenAddress(entry.realAddress);
  document.getElementById('drawer-address').textContent = entry.realAddress;

  const badge = document.getElementById('drawer-badge');
  badge.className = `tt-badge ${entry.isSelfTransfer ? 'hub' : side === 'in' ? 'inflow' : 'outflow'}`;
  badge.textContent = entry.isSelfTransfer
    ? 'Self-Transfer (Hub ↺ Hub)'
    : entry.hasCircularReturn
    ? 'Circular Flow (In & Returned ↺)'
    : side === 'in'
    ? 'Inflow (Sender)'
    : 'Outflow (Receiver)';

  const avatar = document.getElementById('drawer-avatar');
  if (entry.realAddress.startsWith('~')) {
    avatar.src = 'icons/tezos.png';
  } else {
    avatar.src = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(entry.realAddress)}`;
  }

  document.getElementById('drawer-volume').textContent = entry.hasCircularReturn
    ? `+${formatTez(entry.amount, true)} / ↺ -${formatTez(entry.returnAmount, true)}`
    : formatTez(entry.amount);
  document.getElementById('drawer-txcount').textContent = entry.hasCircularReturn
    ? `${entry.count} in • ${entry.returnCount} returned`
    : entry.isSelfTransfer
    ? `${entry.count} self-tx (0 ꜩ net)`
    : `${entry.count} (${entry.sharePct.toFixed(2)}%)`;

  const tzktLink = document.getElementById('drawer-tzkt-link');
  tzktLink.href = entry.realAddress.startsWith('~')
    ? `https://tzkt.io/${encodeURIComponent(currentAddress)}`
    : `https://tzkt.io/${encodeURIComponent(entry.realAddress)}`;

  const txListEl = document.getElementById('drawer-tx-list');
  const combinedHashes = entry.hasCircularReturn
    ? Array.from(new Set([...(entry.txHashes || []), ...(entry.returnEntry?.txHashes || [])]))
    : entry.txHashes || [];
  txListEl.innerHTML = combinedHashes
    .map(
      (hash, idx) => `
      <a class="drawer-tx-item" href="https://tzkt.io/${encodeURIComponent(hash)}" target="_blank" rel="noopener">
        <span>#${idx + 1} • ${escapeHtml(hash.slice(0, 14))}…${escapeHtml(hash.slice(-8))}</span>
        <i class="fa-solid fa-arrow-up-right-from-square"></i>
      </a>
    `
    )
    .join('');

  inspectorDrawer.classList.add('open');
}

document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
  inspectorDrawer?.classList.remove('open');
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

document.getElementById('drawer-copy-btn')?.addEventListener('click', () => {
  if (!inspectedEntry) return;
  const combinedHashes = inspectedEntry.hasCircularReturn
    ? Array.from(new Set([...(inspectedEntry.txHashes || []), ...(inspectedEntry.returnEntry?.txHashes || [])]))
    : inspectedEntry.txHashes || [];
  const txText = combinedHashes.map((h) => `https://tzkt.io/${h}`).join('\n');
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
