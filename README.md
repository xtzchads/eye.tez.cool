# The Eye of Chad

The Eye of Chad is a small web application that visualizes Tezos blockchain transaction flows with non-zero amounts of tez.

## How to use
There are two sliders - transaction depth slider and a dust filter slider (for the case when there are too many dust inputs or outputs)
To start, set the parameters (default are 1000 tx depth and no filtering by amount), input the address. This will draw a diagram visualizing tez flow in and out of address.

To explore the particular connection, click anywhere on a green or red node. It will trigger a new search (or load the data from cache if already searched) with new address in connection (address and all related transactions are also copied into clipboard for quicker work with it elsewhere). Tool can remember searches and move back and forward between them. Searches can be shared via url.

## Features
 - No need of backend, purely clientside app using TZKT API (awesome, isn't it?)
 - Visualization of tez flows using sankey diagrams (inflows, outflows, dates, tx count, inputs/outputs count on mouse hover).
 - Caching of searches inside of single session so you don't need to wait for a data load when you visit same connection multiple times
 - Back/forward navigation between searches inside of single session so you won't lose your previous/current searches
 - Automatic copying of all necessary data to clipboard once you click a connection (address, transactions in descending order from most fresh ones as tzkt links)
 - URL sharing (share your searches with friends just by giving them url of your search)
 - Save your searches as PNG using Plotly built-in functionality
 - Mobile friendly, but best to use on big screens due potentially large amounts of data
 - Super easy to deploy. Just fork the repo and publish it as your own Github Pages site

## Directory Structure

- `index.html` : Main HTML file
- `css/main.css` : Main CSS file
- `js/main.js` : Main JS file
- `js/background.js` : Animated background
- `js/plotly.min.js` : Plotly charting library
- `icons/` : Directory containing the icon images

## Questions & Answers
How to copy address/transactions?
- Just click on connection area. Address and all transactions will get copied into clipboard and also printed into browser console automatically

Can I select text in chart area?
- No, it's a limitation of charting library. However we tried to build it in the way that you don't have to. Click on connection copies all needed info and you can instantly return back via Back button

What tx range slider does?
- It's a transaction depth. If you choose 10000, latest 10000 transactions will be analyzed.

What tez slider does?
- It hides the connections with amount less than specified with slider. Useful to filter dust connections and free some chart space or targeting specific ammounts of tez flows

## License
This project is open-source and available under the MIT License.
