// Element references
const input = document.getElementById('target-address');
const cache = new Map(); // Cache to store fetched data
let offset = 0; // Offset for pagination
let history = []; // History of visited addresses
let historyIndex = -1; // Index in the history array

/// Add CSS for the dropdown that matches the page style
// Add CSS for the dropdown that matches the page style
const style = document.createElement('style');
style.textContent = `
    .address-dropdown {
        position: absolute;
        top: 100%;
        left: 0;
        width: 100%;
        max-height: 300px;
        overflow-y: auto;
        background-color: rgba(249, 249, 249, 0.95);
        border: 1px solid rgba(77, 77, 77, 0.3);
        border-radius: 5px;
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
        z-index: 1000;
        display: none;
        backdrop-filter: blur(5px);
        margin-top: 5px;
        scrollbar-width: thin;
        scrollbar-color: rgba(77, 77, 77, 0.5) transparent;
    }
    
    .address-dropdown::-webkit-scrollbar {
        width: 6px;
    }
    
    .address-dropdown::-webkit-scrollbar-track {
        background: transparent;
    }
    
    .address-dropdown::-webkit-scrollbar-thumb {
        background-color: rgba(77, 77, 77, 0.5);
        border-radius: 3px;
    }
    
    .address-item {
        display: flex;
        align-items: center;
        padding: 10px 15px;
        cursor: pointer;
        border-bottom: 1px solid rgba(77, 77, 77, 0.1);
        transition: all 0.2s ease;
    }
    
    .address-item:last-child {
        border-bottom: none;
    }
    
    .address-item:hover, .address-item.focused {
        background-color: rgba(77, 77, 77, 0.1);
    }
    
    .address-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        margin-right: 12px;
        background-color: rgba(77, 77, 77, 0.1);
        object-fit: cover;
        border: 1px solid rgba(77, 77, 77, 0.2);
    }
    
    .address-info {
        flex-grow: 1;
        overflow: hidden;
    }
    
    .address-alias {
        font-weight: 600;
        margin-bottom: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #333;
    }
    
    .address-value {
        font-size: 0.85em;
        color: #666;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: monospace;
    }
    
    .no-results {
        padding: 12px 15px;
        color: #666;
        text-align: center;
        font-style: italic;
    }
`;
document.head.appendChild(style);

const dropdown = document.createElement('div');
dropdown.className = 'address-dropdown';

// Position the dropdown correctly
const inputField = document.getElementById('target-address');
const inputContainer = inputField.parentElement;
inputContainer.style.position = 'relative';
inputContainer.appendChild(dropdown);

// Set up the input event listener for address suggestions
const addressInput = document.getElementById('target-address');
let timeout = null;

addressInput.addEventListener('input', function() {
    const query = this.value.trim();
    
    // Clear any existing timeout
    if (timeout) {
        clearTimeout(timeout);
    }
    
    // Close dropdown if query is empty
    if (!query || query.length>30) {
        dropdown.style.display = 'none';
	if (query.length==36)
		go();
        return;
    }
    
    // Set a timeout to prevent too many API calls
    timeout = setTimeout(() => {
        fetchAddressSuggestions(query);
    }, 300);
});

// Close dropdown when clicking outside
document.addEventListener('click', function(event) {
    if (!addressInput.contains(event.target) && !dropdown.contains(event.target)) {
        dropdown.style.display = 'none';
    }
});

// Prevent form submission when selecting from dropdown
addressInput.addEventListener('keydown', function(event) {
    if (event.key === 'ArrowDown' && dropdown.style.display !== 'none') {
        event.preventDefault();
        focusNextItem();
    } else if (event.key === 'ArrowUp' && dropdown.style.display !== 'none') {
        event.preventDefault();
        focusPreviousItem();
    } else if (event.key === 'Enter' && dropdown.style.display !== 'none') {
        const focused = dropdown.querySelector('.address-item.focused');
        if (focused) {
            event.preventDefault();
            selectAddress(focused.dataset.address, focused.dataset.alias);
        }
    } else if (event.key === 'Escape') {
        dropdown.style.display = 'none';
    }
});

// Function to fetch address suggestions from TzKT API
async function fetchAddressSuggestions(query) {
    try {
        showLoadingInDropdown();
        
        const response = await fetch(`https://back.tzkt.io/v1/suggest/accounts/${query}`);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        
        const suggestions = await response.json();
        
        if (suggestions && suggestions.length > 0) {
            renderDropdown(suggestions);
        } else {
            showNoResultsMessage();
        }
    } catch (error) {
        console.error('Error fetching address suggestions:', error);
        showErrorMessage();
    }
}

// Show loading state in dropdown
function showLoadingInDropdown() {
    dropdown.innerHTML = '<div class="no-results">Loading suggestions...</div>';
    dropdown.style.display = 'block';
}

// Show no results message
function showNoResultsMessage() {
    dropdown.innerHTML = '<div class="no-results">No matching addresses found</div>';
    dropdown.style.display = 'block';
    
    // Hide after a delay
    setTimeout(() => {
        dropdown.style.display = 'none';
    }, 2000);
}

// Show error message
function showErrorMessage() {
    dropdown.innerHTML = '<div class="no-results">Error fetching suggestions</div>';
    dropdown.style.display = 'block';
    
    // Hide after a delay
    setTimeout(() => {
        dropdown.style.display = 'none';
    }, 2000);
}

window.addEventListener('resize', updateDropdownPosition);

function updateDropdownPosition() {
    const inputRect = inputField.getBoundingClientRect();
    dropdown.style.width = `${inputRect.width}px`;
    dropdown.style.left = `${inputField.offsetLeft}px`;
    dropdown.style.top = `${inputField.offsetTop + inputRect.height + 5}px`;
}

// Function to render the dropdown with suggestions
function renderDropdown(suggestions) {
    // Clear existing dropdown content
    dropdown.innerHTML = '';
    
    // Limit to 10 suggestions for better UX
    const limitedSuggestions = suggestions.slice(0, 10);
    
    limitedSuggestions.forEach(suggestion => {
        // Create elements properly instead of using innerHTML
        const item = document.createElement('div');
        item.className = 'address-item';
        item.dataset.address = suggestion.address;
        item.dataset.alias = suggestion.alias || '';
        const avatar = document.createElement('img');
        avatar.className = 'address-avatar';
        avatar.src = `https://services.tzkt.io/v1/avatars/${encodeURIComponent(suggestion.address)}`;
        
        avatar.onerror = function() {
            const initial = suggestion.address.charAt(2);
            const encodedInitial = encodeURIComponent(initial);
            this.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Crect width='28' height='28' fill='%23e0e0e0'/%3E%3Ctext x='50%' y='50%' font-size='14' text-anchor='middle' dominant-baseline='middle' fill='%23666'%3E${encodedInitial}%3C/text%3E%3C/svg%3E`;
        };
        
        const addressInfo = document.createElement('div');
        addressInfo.className = 'address-info';
        if (suggestion.alias) {
            const aliasDiv = document.createElement('div');
            aliasDiv.className = 'address-alias';
            aliasDiv.textContent = suggestion.alias;
            addressInfo.appendChild(aliasDiv);
        }
        const addressDiv = document.createElement('div');
        addressDiv.className = 'address-value';
        addressDiv.textContent = suggestion.address;
        addressInfo.appendChild(addressDiv);
        item.appendChild(avatar);
        item.appendChild(addressInfo);
        item.addEventListener('click', function() {
            selectAddress(suggestion.address, suggestion.alias);
        });
        dropdown.appendChild(item);
    });
    
    // Show dropdown
    dropdown.style.display = 'block';
    
    // Update dropdown position
    updateDropdownPosition();
}

// Function to select an address from the dropdown
function selectAddress(address, alias) {
    addressInput.value = address;
    dropdown.style.display = 'none';
    
    // Focus the input field
    addressInput.focus();
    
    // Use the existing notification system
    const notification = document.getElementById('notification');
    if (notification) {
        notification.textContent = `Selected: ${alias || address}`;
        notification.style.display = 'block';
        setTimeout(() => {
            notification.style.opacity = 1;
        }, 10);

        setTimeout(() => {
            notification.style.opacity = 0;
            setTimeout(() => {
                notification.style.display = 'none';
                notification.textContent = 'Address and transactions copied to clipboard/console';
            }, 500);
        }, 2000);
    }
    go();
}

// Navigation within the dropdown using arrow keys
function focusNextItem() {
    const items = dropdown.querySelectorAll('.address-item');
    const focused = dropdown.querySelector('.address-item.focused');
    
    if (!focused && items.length > 0) {
        items[0].classList.add('focused');
    } else if (focused) {
        const currentIndex = Array.from(items).indexOf(focused);
        if (currentIndex < items.length - 1) {
            focused.classList.remove('focused');
            items[currentIndex + 1].classList.add('focused');
            items[currentIndex + 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

function focusPreviousItem() {
    const items = dropdown.querySelectorAll('.address-item');
    const focused = dropdown.querySelector('.address-item.focused');
    
    if (focused) {
        const currentIndex = Array.from(items).indexOf(focused);
        if (currentIndex > 0) {
            focused.classList.remove('focused');
            items[currentIndex - 1].classList.add('focused');
            items[currentIndex - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

// On page load, check the location hash for saved values and populate inputs
document.addEventListener('DOMContentLoaded', function() {
    const hash = location.hash.slice(1); // Get the hash without the leading #
    if (hash) {
        const [address, resultLimitValue, tezLimitValue] = hash.split(','); // Parse the hash
        if (address) {
            document.getElementById('target-address').value = address;
        }
        if (resultLimitValue) {
            document.getElementById('result-limit').value = resultLimitValue;
            document.getElementById('limit-value').textContent = resultLimitValue + ' txes';
        }
        if (tezLimitValue) {
            document.getElementById('tez-limit').value = tezLimitValue;
            document.getElementById('limit-tez').textContent = tezLimitValue + ' tez';
        }
        go(); // Trigger data fetch and diagram generation
    }
});

// Trigger data fetch on Enter key press in the address input field
input.addEventListener('keydown', function(event) {
    if (event.keyCode === 13) {
        go();
    }
});

// Handle confirm button click to fetch and display data
function go() {
    const targetAddress = document.getElementById('target-address').value.trim();
    const limit = document.getElementById('result-limit').value;
    updateLocationHash(); // Update location hash
    generateDataAndDrawDiagram(targetAddress, limit); // Fetch data and draw diagram
}

// Update limit display and location hash on input change
document.getElementById('result-limit').addEventListener('input', function() {
    const limitValue = document.getElementById('result-limit').value;
    document.getElementById('limit-value').textContent = limitValue + ' txes';
    updateLocationHash();
});

// Update tez limit display and location hash on input change
document.getElementById('tez-limit').addEventListener('input', function() {
    const limitValue = document.getElementById('tez-limit').value;
    document.getElementById('limit-tez').textContent = limitValue + ' tez';
    updateLocationHash();
	go();
});

// Update the location hash with current input values
function updateLocationHash() {
    const tezosAddress = document.getElementById('target-address').value.trim();
    const resultLimitValue = document.getElementById('result-limit').value;
    const tezLimitValue = document.getElementById('tez-limit').value;
    location.hash = `${tezosAddress},${resultLimitValue},${tezLimitValue}`;
}

// Fetch data from API with pagination and cache check
async function fetchData(tezosAddress) {
    try {
        let str;
        if (offset === 0) {
            str = `https://api.tzkt.io/v1/accounts/${tezosAddress}/operations?sort.desc=level&type=activation,transaction,origination,migration&limit=1000&status=applied`;
        } else {
            str = `https://api.tzkt.io/v1/accounts/${tezosAddress}/operations?sort.desc=level&type=activation,transaction,origination,migration&limit=1000&status=applied&lastId=${offset}`;
        }
        const response = await fetch(str);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const data = await response.json();
        offset = data[data.length - 1].id;
        return data;
    } catch (error) {
        return null;
    }
}

// Fetch all data, respecting cache and limit
async function fetchAllData(tezosAddress, limit) {
    if (cache.has(tezosAddress)) {
        const cached = cache.get(tezosAddress);
        if (cached.limit === limit) {
            return cached.data;
        }
    }

    let allData = [];
    let counter = 0;
    document.getElementById('sankey-diagram').style.display = 'none';
    document.getElementById('loader').style.display = 'block';
    while (offset >= 0 && counter < limit) {
        const data = await fetchData(tezosAddress);
        if (!data || !Array.isArray(data) || data.length === 0) {
            break;
        }
        allData.push(...data);
        counter += 1000;
    }

    cache.set(tezosAddress, { data: allData, limit: limit });
    return allData;
}

// Parse transaction data into inflows, outflows, and aliases
function parseTransactions(data, tezosAddress) {
    const inflowsMap = new Map();
    const outflowsMap = new Map();
    const addressToAliasMap = new Map();
    const addressTxCount = new Map();
    const addressDateRange = new Map();
    const txHashesMap = new Map();

    if (!data || !Array.isArray(data)) {
        console.error('Invalid data format');
        return { inflows: [], outflows: [], addressToAliasMap: new Map(), txHashesMap: new Map() };
    }

    data.forEach(operation => {
        let senderAlias = operation.sender?.address || '';
        let targetAlias = operation.target?.address || '';

        if (operation.sender?.alias) {
            senderAlias = operation.sender.alias;
        }
        if (operation.target?.alias) {
            targetAlias = operation.target.alias;
        }

        if (operation.type === 'activation') {
            if (operation.account?.alias) {
                targetAlias = operation.account.alias;
            }
            addressToAliasMap.set(operation.account.address, targetAlias);
            const address = "~Activation~";
            const amount = parseFloat(operation.balance / 1000000);  // Use operation.balance instead of operation.account.balance
            inflowsMap.set(address, amount);
            addressTxCount.set(address, 1);
            const dateRange = { start: new Date(operation.timestamp), end: new Date(operation.timestamp) };
            addressDateRange.set(address, dateRange);
            txHashesMap.set(address, (txHashesMap.get(address) || []).concat(operation.hash));
        } else if (operation.type === 'migration' && operation.kind === 'bootstrap') {
            if (operation.account?.alias) {
                targetAlias = operation.account.alias;
            }
            addressToAliasMap.set(operation.account.address, targetAlias);
            const address = "~Bootstrap~";
            const amount = parseFloat(operation.balanceChange / 1000000);  // Use operation.balance instead of operation.account.balance
            inflowsMap.set(address, amount);
            addressTxCount.set(address, 1);
            const dateRange = { start: new Date(operation.timestamp), end: new Date(operation.timestamp) };
            addressDateRange.set(address, dateRange);
            txHashesMap.set(address, (txHashesMap.get(address) || []).concat(operation.hash));
	} else if (operation.type === 'migration' && operation.kind === 'subsidy') {
            if (operation.account?.alias) {
                targetAlias = operation.account.alias;
            }
            addressToAliasMap.set(operation.account.address, targetAlias);
            const address = "~Subsidy~";
            const amount = parseFloat(operation.balanceChange / 1000000);  // Use operation.balance instead of operation.account.balance
	    if (inflowsMap.has(address))
                inflowsMap.set(address, inflowsMap.get(address) + amount);
	    else
                inflowsMap.set(address, amount);
            addressTxCount.set(address, 1);
            const dateRange = { start: new Date(operation.timestamp), end: new Date(operation.timestamp) };
            addressDateRange.set(address, dateRange);
            txHashesMap.set(address, (txHashesMap.get(address) || []).concat(operation.hash));
        } else if (operation.type === 'origination') {
            const timestamp = new Date(operation.timestamp);
            if (operation.contractBalance > 0)
                if (operation.sender.address == tezosAddress) {
                    if (operation.originatedContract?.alias) {
                        targetAlias = operation.originatedContract.alias;
                    }
                    else
                        targetAlias = operation.originatedContract.address;
                    addressToAliasMap.set(operation.sender.address, senderAlias);
                    addressToAliasMap.set(operation.originatedContract.address, targetAlias);
                    const targetAddress = targetAlias;
                    const amount = parseFloat(operation.contractBalance / 1000000);
                    if (outflowsMap.has(targetAddress)) {
                        outflowsMap.set(targetAddress, outflowsMap.get(targetAddress) + amount);
                        addressTxCount.set(targetAddress, addressTxCount.get(targetAddress) + 1);
                        const dateRange = addressDateRange.get(targetAddress);
                        addressDateRange.set(targetAddress, {
                            start: new Date(timestamp),
                            end: dateRange.end
                        });
                        txHashesMap.get(targetAddress).push(operation.hash);
                    } else {
                        outflowsMap.set(targetAddress, amount);
                        addressTxCount.set(targetAddress, 1);
                        addressDateRange.set(targetAddress, { start: timestamp, end: timestamp });
                        txHashesMap.set(targetAddress, [operation.hash]);
                    }
					
                } 
                else if (operation.originatedContract.address==tezosAddress) {
                    if (operation.originatedContract?.alias) {
                        targetAlias = operation.originatedContract.alias;
                    }
                    else
                        targetAlias = operation.originatedContract.address;
                    addressToAliasMap.set(operation.sender.address, senderAlias);
                    addressToAliasMap.set(operation.originatedContract.address, targetAlias);
                    const senderAddress = senderAlias;
                    const amount = parseFloat(operation.contractBalance / 1000000);
                    if (inflowsMap.has(senderAddress)) {
                        inflowsMap.set(senderAddress, inflowsMap.get(senderAddress) + amount);
                        addressTxCount.set(senderAddress, addressTxCount.get(senderAddress) + 1);
                        const dateRange = addressDateRange.get(senderAddress);
                        addressDateRange.set(senderAddress, {
                            start: new Date(timestamp),
                            end: dateRange.end
                        });
                        txHashesMap.get(senderAddress).push(operation.hash);
                    } else {
                        inflowsMap.set(senderAddress, amount);
                        addressTxCount.set(senderAddress, 1);
                        addressDateRange.set(senderAddress, { start: timestamp, end: timestamp });
                        txHashesMap.set(senderAddress, [operation.hash]);
                    }
                }
        } else if (operation.type === 'transaction'){
            addressToAliasMap.set(operation.sender.address, senderAlias);
            addressToAliasMap.set(operation.target.address, targetAlias);

            const timestamp = new Date(operation.timestamp);

            if (operation.sender && operation.target && operation.sender.address === tezosAddress && operation.amount != 0) {
                const targetAddress = targetAlias;
                const amount = parseFloat(operation.amount / 1000000);

                if (outflowsMap.has(targetAddress)) {
                    outflowsMap.set(targetAddress, outflowsMap.get(targetAddress) + amount);
                    addressTxCount.set(targetAddress, addressTxCount.get(targetAddress) + 1);
                    const dateRange = addressDateRange.get(targetAddress);
                    addressDateRange.set(targetAddress, {
                        start: new Date(timestamp),
                        end: dateRange.end
                    });
                    txHashesMap.get(targetAddress).push(operation.hash);
                } else {
                    outflowsMap.set(targetAddress, amount);
                    addressTxCount.set(targetAddress, 1);
                    addressDateRange.set(targetAddress, { start: timestamp, end: timestamp });
                    txHashesMap.set(targetAddress, [operation.hash]);
                }
            }
            if (operation.target && operation.target.address === tezosAddress && operation.sender.address !== tezosAddress && operation.amount != 0) {
                const senderAddress = senderAlias;
                const amount = parseFloat(operation.amount / 1000000);

                if (inflowsMap.has(senderAddress)) {
                    inflowsMap.set(senderAddress, inflowsMap.get(senderAddress) + amount);
                    addressTxCount.set(senderAddress, addressTxCount.get(senderAddress) + 1);
                    const dateRange = addressDateRange.get(senderAddress);
                    addressDateRange.set(senderAddress, {
                        start: new Date(timestamp),
                        end: dateRange.end
                    });
                    txHashesMap.get(senderAddress).push(operation.hash);
                } else {
                    inflowsMap.set(senderAddress, amount);
                    addressTxCount.set(senderAddress, 1);
                    addressDateRange.set(senderAddress, { start: timestamp, end: timestamp });
                    txHashesMap.set(senderAddress, [operation.hash]);
                }
            }
        }
    });

    const tezLimit = document.getElementById('tez-limit').value;
    const inflows = [...inflowsMap.entries()].map(([address, amount]) => ({
        address,
        amount,
        count: addressTxCount.get(address),
        dateRange: addressDateRange.get(address),
        txHashes: txHashesMap.get(address)
    })).filter(entry => entry.amount >= tezLimit);
    const outflows = [...outflowsMap.entries()].map(([address, amount]) => ({
        address,
        amount,
        count: addressTxCount.get(address),
        dateRange: addressDateRange.get(address),
        txHashes: txHashesMap.get(address)
    })).filter(entry => entry.amount >= tezLimit);

    return { inflows, outflows, addressToAliasMap, txHashesMap };
}

// Generate data, draw diagram, and manage history
async function generateDataAndDrawDiagram(tezosAddress, limit) {
    const data = await fetchAllData(tezosAddress, limit);
    if (!data || data.length == 0) {
        hideLoader();
        return;
    }
    offset = 0;
    const { inflows, outflows, addressToAliasMap, txHashesMap } = parseTransactions(data, tezosAddress);
    hideLoaderAndDrawDiagram();
    drawSankeyDiagram(tezosAddress, inflows, outflows, addressToAliasMap, txHashesMap);

    if (historyIndex === -1 || history[historyIndex] !== tezosAddress) {
        updateHistory(tezosAddress);
    }
}

// Hide loader and show diagram
function hideLoaderAndDrawDiagram() {
    document.getElementById('sankey-diagram').style.display = 'block';
    document.getElementById('loader').style.display = 'none';
}

// Hide loader
function hideLoader() {
    document.getElementById('loader').style.display = 'none';
}

function drawSankeyDiagram(targetAddress, inflows, outflows, addressToAliasMap, txHashesMap) {
    const numInflows = inflows.length;
    const amInflows = [...inflows.values()].reduce((sum, { amount = 0 }) => sum + amount, 0);
    const numOutflows = outflows.length;
    const amOutflows = [...outflows.values()].reduce((sum, { amount = 0 }) => sum + amount, 0);
    console.log("inputs:" + numInflows + "; outputs:" + numOutflows + "\r\nin:" + amInflows.toFixed(2) + "; out:" + amOutflows.toFixed(2))
    const nodes = [
        {
            label: `${addressToAliasMap.get(targetAddress) || targetAddress}`,
            hoverText: `${addressToAliasMap.get(targetAddress) || targetAddress}<br>Inputs: ${numInflows}<br>Outputs: ${numOutflows}<br>Total in: ${amInflows.toFixed(2)} tez<br>Total out: ${amOutflows.toFixed(2)} tez`
        },
        ...inflows.map(entry => ({
            label: `${entry.address}`,
            hoverText: `${entry.address}<br>${entry.count} txes<br>${entry.dateRange.start.toISOString().split('T')[0]} - ${entry.dateRange.end.toISOString().split('T')[0]}`
        })),
        ...outflows.map(entry => ({
            label: `${entry.address}`,
            hoverText: `${entry.address}<br>${entry.count} txes<br>${entry.dateRange.start.toISOString().split('T')[0]} - ${entry.dateRange.end.toISOString().split('T')[0]}`
        }))
    ];

    const links = [
        ...inflows.map(entry => ({
            source: nodes.findIndex(node => node.label === entry.address),
            target: 0,
            value: entry.amount,
            color: (entry.address === "~Activation~" || entry.address === "~Bootstrap~" || entry.address === "~Subsidy~") ? 'rgba(255, 255, 153, 0.6)' : 'rgba(144, 238, 144, 0.6)' // Light yellow for activation
        })),
        ...outflows.map(entry => ({
            source: 0,
            target: nodes.findIndex(node => node.label === entry.address),
            value: entry.amount,
            color: 'rgba(255, 99, 71, 0.6)'
        }))
    ];

    const sankeyData = {
        type: "sankey",
        orientation: "h",
        node: {
            pad: 15,
            thickness: 20,
            line: {
                color: "black",
                width: 0.5
            },
            label: nodes.map(node => node.label),
            customdata: nodes.map(node => node.hoverText),
            hovertemplate: '%{customdata}<extra></extra>'
        },
        link: {
            source: links.map(link => link.source),
            target: links.map(link => link.target),
            value: links.map(link => link.value),
            color: links.map(link => link.color)
        }
    };

    const optimalHeight = Math.max(600, nodes.length * 18);

    Plotly.newPlot('sankey-diagram', [sankeyData], {
        margin: { t: 30, r: 10, b: 10, l: 10 },
paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
	hoverlabel: {
    bgcolor: "rgba(0, 0, 0, 0.8)",  // Dark background for tooltip
    bordercolor: "white",
    font: {
      color: "white",
      family: "Monda, Helvetica, sans-serif",
      size: 12
    }
  },
	font: {
        color: 'white',
        family: 'Monda,Helvetica'
    },
        autosize: true,
        height: optimalHeight
    }, { responsive: true, suppressWarnings: true,
    displayModeBar: false});

    // Handle node click in the Sankey diagram
    const sankeyContainer = document.getElementById('sankey-diagram');
    sankeyContainer.on('plotly_click', function(event) {
        if (event && event.points && event.points.length > 0) {
            const clickedNodeLabel = event.points[0].source.pointNumber !== 0 ? event.points[0].source.label : event.points[0].target.label;
            const relatedAddress = Array.from(addressToAliasMap).find(([address, alias]) => alias === clickedNodeLabel)?.[0] || clickedNodeLabel;
            const txHashes = txHashesMap.get(clickedNodeLabel) || [];
            const txHashesText = txHashes.map(hash => `https://tzkt.io/${hash}`).join('\n');
            const clipboardText = `${relatedAddress}\n\n${txHashesText}`;
            navigator.clipboard.writeText(clipboardText).then(function() {
                console.log(clipboardText);
            }).catch(function(err) {
                console.error('Could not copy text:', err);
            });
            showNotification();
            if (relatedAddress !== "~Activation~" && relatedAddress !== "~Bootstrap~" && relatedAddress !== "~Subsidy~") {
                document.getElementById('target-address').value = relatedAddress.trim();
                go();
            }
        }
    });
}

function showNotification() {
    const notification = document.getElementById('notification');
    notification.style.display = 'block';
    setTimeout(() => {
        notification.style.opacity = 1;
    }, 10); // Short delay to trigger CSS transition

    setTimeout(() => {
        notification.style.opacity = 0;
        setTimeout(() => {
            notification.style.display = 'none';
        }, 500); // Wait for the fade-out transition to complete
    }, 3000); // Show notification for 3 seconds
}


// Handle back button click to navigate to previous address
document.getElementById('back-button').addEventListener('click', function() {
    if (historyIndex > 0) {
        historyIndex--;
        const previousAddress = history[historyIndex];
        document.getElementById('target-address').value = previousAddress;
        const limit = document.getElementById('result-limit').value;
        updateLocationHash();
        generateDataAndDrawDiagram(previousAddress, limit);
        updateNavigationButtons();
    }
});

// Handle forward button click to navigate to next address
document.getElementById('forward-button').addEventListener('click', function() {
    if (historyIndex < history.length - 1) {
        historyIndex++;
        const nextAddress = history[historyIndex];
        document.getElementById('target-address').value = nextAddress;
        const limit = document.getElementById('result-limit').value;
        updateLocationHash();
        generateDataAndDrawDiagram(nextAddress, limit);
        updateNavigationButtons();
    }
});

// Update navigation button states
function updateNavigationButtons() {
    document.getElementById('back-button').disabled = historyIndex <= 0;
    document.getElementById('forward-button').disabled = historyIndex >= history.length - 1;
}

// Tooltips for input fields
const resultLimit = document.getElementById('result-limit');
const tezLimit = document.getElementById('tez-limit');
const resultLimitTooltip = document.getElementById('result-limit-tooltip');
const tezLimitTooltip = document.getElementById('tez-limit-tooltip');

resultLimit.addEventListener('mouseenter', function() {
    resultLimitTooltip.style.display = 'block';
});

resultLimit.addEventListener('mouseleave', function() {
    resultLimitTooltip.style.display = 'none';
});

tezLimit.addEventListener('mouseenter', function() {
    tezLimitTooltip.style.display = 'block';
});

tezLimit.addEventListener('mouseleave', function() {
    tezLimitTooltip.style.display = 'none';
});

// Update history with the new address
function updateHistory(tezosAddress) {
    if (historyIndex < history.length - 1) {
        history = history.slice(0, historyIndex + 1);
    }
    history.push(tezosAddress);
    historyIndex = history.length - 1;
    updateNavigationButtons();
}

updateNavigationButtons(); // Initial call to set the state of navigation buttons
