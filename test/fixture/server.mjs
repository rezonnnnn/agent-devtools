// Serves the fixture page; prints its URL on stdout once listening. Runs as
// its own process because the tests drive the CLI synchronously.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'));
// A content-heavy page of the kind agents actually meet: navigation, a search
// form, 40 product cards, a table, a link-dense footer. Deterministic, so
// benchmark numbers are reproducible.
function shop() {
  const nav = ['Home', 'New in', 'Laptops', 'Phones', 'Audio', 'Gaming', 'Deals', 'Support']
    .map(n => `<a href="/shop?c=${n}">${n}</a>`)
    .join(' ');
  const cards = Array.from({length: 40}, (_, i) => {
    const n = i + 1;
    return `<article><h3><a href="/shop/p/${n}">Product ${n} with a descriptive name</a></h3>
<img src="data:," alt="Photo of product ${n}"><p>Rated ${(3 + (n % 20) / 10).toFixed(1)} out of 5 by ${n * 13} buyers. Ships in ${1 + (n % 4)} days.</p>
<p><strong>$${(n * 17.5).toFixed(2)}</strong> <del>$${(n * 21).toFixed(2)}</del></p>
<button>Add product ${n} to cart</button> <button aria-label="Save product ${n}">Save</button></article>`;
  }).join('');
  const rows = Array.from({length: 15}, (_, i) =>
    `<tr><td>Order ${1000 + i}</td><td>2026-0${1 + (i % 9)}-1${i % 10}</td><td>${i % 3 ? 'Delivered' : 'In transit'}</td><td>$${(i * 31.4).toFixed(2)}</td></tr>`,
  ).join('');
  const footer = Array.from({length: 24}, (_, i) => `<a href="/info/${i}">Footer link ${i + 1}</a>`).join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body>
<header><nav>${nav}</nav>
<form role="search"><label>Search <input name="q" placeholder="Search products"></label>
<label>Sort <select name="sort"><option>Relevance</option><option>Price</option><option>Rating</option></select></label>
<button>Search</button></form></header>
<main><h1>All products</h1><section>${cards}</section>
<h2>Recent orders</h2><table><thead><tr><th>Order</th><th>Date</th><th>Status</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></main>
<footer>${footer}<p>Copyright 2026 Example Shop. All rights reserved.</p></footer></body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/shop')) {
    res.setHeader('content-type', 'text/html');
    res.end(shop());
  } else if (req.url === '/api/data') {
    res.setHeader('content-type', 'application/json');
    res.end('{"v":42}');
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  }
});
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/`);
});
