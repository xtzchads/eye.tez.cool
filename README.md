# The Eye of Chad — Interactive Tezos On-Chain Flow Explorer

**The Eye of Chad** is a fast, zero-dependency, client-side web application that visualizes Tezos (`XTZ`) blockchain value flows using a custom high-readability interactive SVG Sankey diagram.

Built with pure **HTML + CSS + Vanilla JavaScript**, it runs 100% in the browser using the public [TzKT API](https://api.tzkt.io/) and can be deployed directly to **GitHub Pages** or any static file host with zero build steps.

---

## How to Use

1. **Search an Address or Alias**:
   - Paste any Tezos wallet or smart contract address (`tz1`, `tz2`, `tz3`, `KT1`) into the top search bar, or type a known account name (e.g., `objkt`, `Burn`, bakers, exchanges) to pick from the live TzKT autocomplete dropdown with account avatars.
   - Or click one of the **Try** preset chips (`Burn`, `objkt.com`) in the top-right header.
2. **Adjust Analysis Scope & Dust Filtering**:
   - **Depth (`1,000` – `100,000` txes, default `10,000`)**: Controls how many of the latest applied non-zero XTZ transfers are fetched and analyzed.
   - **Min Flow (`0 ꜩ` – `10,000 ꜩ`) & Quick Dust Chips (`0`, `≥10`, `≥100`, `≥1K`)**: Instantly filters out low-volume counterparties in memory without re-fetching from the network.
3. **Explore & Pivot Through the Flow Graph**:
   - **Left Column (`Inflows / Senders`)**: Accounts that sent XTZ to the target hub.
   - **Center Card (`Target Hub`)**: The analyzed account, displaying its TzKT avatar, alias/address, total inflows, and total outflows.
   - **Right Column (`Outflows / Receivers`)**: Accounts that received XTZ from the target hub.
   - **Click any counterparty node or ribbon**: Automatically copies the counterparty's address and all related `tzkt.io/{opHash}` transaction links to your clipboard (and prints them to the browser console), then **pivots** the explorer into that counterparty's flow graph.
   - **Click the `⋯` button (or right-click any node/ribbon)**: Opens the slide-over **Transaction Inspector Drawer** to browse individual operation links, copy data, or open the account on TzKT without leaving the current graph.
   - **Back / Forward buttons**: Navigate seamlessly through your session's exploration history.

---

## Key Features

- **Zero-Dependency Custom SVG Sankey Engine**:
  - Replaces legacy charting libraries with a purpose-built 3-column SVG layout featuring guaranteed non-overlapping node cards, full-bleed readable labels, volume share bars, and animated flow highlights on hover.
- **Circular Flows (`↺`) & Self-Transfer Loops**:
  - **Circular (`↺`, default)**: Automatically detects bidirectional counterparties (senders that also received return funds from the Hub) and loops their return outflows smoothly back to the left sender card, plus renders a dedicated **Crown Loop (`↺ Self`)** above the Hub when an account transfers XTZ to itself (`0 ꜩ` net flow impact).
  - **Split (`⇄`)**: Standard 3-column Sankey view with inflows on the left and all outflows on the right.
- **Readability & Scaling Controls**:
  - **Scale (`√ Bal` / `Log` / `Linear`)**: Square-root (`√`) balanced scaling prevents massive whale transfers from crushing smaller counterparties into unreadable 1px lines.
  - **Smart Top-N Grouping (`25` / `50` / `100` / `All`)**: Groups long-tail counterparties into an interactive `+ N smaller senders/receivers` node (click it to expand).
  - **Sort (`Vol` / `Tx` / `New`)**: Order counterparties by total XTZ volume, transaction count, or most recent activity.
  - **Live Node Filter**: Instant `requestAnimationFrame`-throttled text search across visible counterparty aliases and addresses.
- **High-Throughput TzKT API Integration & Smart Caching**:
  - Streams non-zero transfers via `GET /v1/operations/transactions` (`amount.gt=0`, up to `10,000` operations per batch with field projection `select=id,hash,timestamp,amount,sender,target` and cursor pagination `offset.cr`), plus parallel support for genesis `activation`, `migration` (`~Bootstrap~` / `~Subsidy~`), and funded contract `origination` flows.
  - Smart in-memory session cache reuses previously fetched batches when revisiting addresses or adjusting filters.
- **URL Hash State Sharing**:
  - Every search encodes `#address,depthLimit,minTezLimit` in the URL hash so exact views can be bookmarked or shared via link.
- **High-Resolution PNG Export**:
  - Download a crisp `2×` retina PNG snapshot of the current Sankey diagram with one click (`PNG` button).

---

## Directory Structure

```text
.
├── index.html      # Main application entry point (Compact Unified Header + Workspace)
├── frame.html      # Embeddable iframe-ready entry point
├── css/
│   └── main.css    # Dark-mode glassmorphism theme, compact toolbar, & SVG Sankey styles
├── js/
│   └── main.js     # TzKT API client, transaction parser, custom SVG Sankey engine, & UI logic
├── icons/          # Application & social icons
└── README.md       # Project documentation
```

---

## FAQ

**How do I copy an address and its transactions?**
- Click any node card or flow ribbon. The counterparty address and all associated `https://tzkt.io/{hash}` links are automatically copied to your clipboard and logged to the browser console. You can also click the `⋯` icon on any node (or right-click it) to inspect and copy individual transactions in the side drawer.

**How are self-transfers (`Hub → Hub`) handled?**
- When an account sends XTZ to itself, it is rendered as a top crown loop (`↺ Self`) on the Target Hub and noted in the **Analyzed Scope** summary card, while **Total Inflows**, **Total Outflows**, and **Net Flow** exclude self-transfers (`0 ꜩ` net impact).

**How do I deploy this to GitHub Pages?**
- Fork or push this repository to GitHub, go to **Settings → Pages**, and select your branch root (`/`). No bundler or build step is required.

---

## License

This project is open-source and available under the [MIT License](LICENSE).
