// server.js
// Coin Maker backend (Express + Firebase Realtime DB + TonCenter verification)
//
// Required env vars:
//  - FIREBASE_SERVICE_ACCOUNT    (stringified JSON of service account)
//  - FIREBASE_DB_URL            (Realtime DB URL, e.g. https://project-default-rtdb.firebaseio.com)
//  - TON_API_KEY                (TonCenter API key)
//  - OWNER_TON_WALLET           (your platform TON address)
//
// This server:
//  - stores tokens (user/listing), sales, balances, history in Realtime DB
//  - creates sale records and verifies transactions (by txHash or scanning inbound txs)
//  - applies token supply changes and dynamic price adjustments
//  - exposes endpoints used by frontend

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');

// --- ENV checks
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT env required (stringified JSON).');
  process.exit(1);
}
if (!process.env.FIREBASE_DB_URL) {
  console.error('FIREBASE_DB_URL env required.');
  process.exit(1);
}
if (!process.env.TON_API_KEY) {
  console.error('TON_API_KEY env required.');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const rdb = admin.database();

const TON_API_KEY = process.env.TON_API_KEY;
const OWNER_TON_WALLET = process.env.OWNER_TON_WALLET || 'UQAmTM_EE8D6seecLKf-h8aXVQasliniDDQ52EvBj7PqExNr';

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.resolve(__dirname))); // serve index.html from root

// Helpers
function uid() {
  return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function toNano(ton) {
  // convert TON decimal to nanotons string
  const nano = BigInt(Math.round(Number(ton) * 1e9));
  return nano.toString();
}
function parseTonValue(v) {
  // accepts numbers or strings; if value is large -> treat as nanotons
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (isNaN(n)) return 0;
  if (n > 1e12) return n / 1e9; // nanotons -> TON
  return n;
}
function normalizeAddr(a) {
  if (!a) return '';
  return String(a).replace(/[^0-9A-Za-z]/g, '').toLowerCase();
}

// --- API: health
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- API: get all tokens
app.get('/api/tokens', async (req, res) => {
  try {
    const snap = await rdb.ref('tokens').once('value');
    const data = snap.val() || {};
    // convert map to array
    const arr = Object.keys(data).map(k => ({ id: k, ...data[k] }));
    // sort by createdAt desc
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(arr);
  } catch (e) {
    console.error('get tokens error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Create token (user or listing)
app.post('/api/tokens/create', async (req, res) => {
  try {
    const { type, name, ticker, owner, totalSupply, pricePerToken } = req.body;
    if (!type || !name || !ticker) return res.status(400).json({ error: 'missing_fields' });
    const id = uid();
    const token = {
      name,
      ticker,
      type,
      owner: owner || OWNER_TON_WALLET,
      createdAt: Date.now()
    };
    if (type === 'listing') {
      if (!totalSupply || !pricePerToken) return res.status(400).json({ error: 'listing_missing' });
      token.totalSupply = Number(totalSupply);
      token.remainingSupply = Number(totalSupply);
      token.pricePerToken = Number(pricePerToken);
    } else {
      // user-token
      token.dynamicPrice = Number(req.body.dynamicPrice || 0.1);
      token.supplyIssued = 0;
    }
    await rdb.ref(`tokens/${id}`).set(token);
    return res.json({ ok: true, id, token });
  } catch (e) {
    console.error('create token error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Buy token (create sale)
app.post('/api/tokens/:id/buy', async (req, res) => {
  try {
    const tokenId = req.params.id;
    const { buyer, amountTokens } = req.body;
    if (!buyer || !amountTokens) return res.status(400).json({ error: 'missing' });
    const tSnap = await rdb.ref(`tokens/${tokenId}`).once('value');
    if (!tSnap.exists()) return res.status(404).json({ error: 'token_not_found' });
    const token = tSnap.val();

    const amount = Number(amountTokens);
    if (amount <= 0) return res.status(400).json({ error: 'bad_amount' });

    let cost = 0;
    const receiver = token.owner || OWNER_TON_WALLET;

    if (token.type === 'listing') {
      const remaining = Number(token.remainingSupply || 0);
      if (amount > remaining) return res.status(400).json({ error: 'not_enough_supply' });
      cost = Number((amount * Number(token.pricePerToken)).toFixed(9));
    } else {
      const priceNow = Number(token.dynamicPrice || 0.1);
      cost = Number((amount * priceNow).toFixed(9));
    }

    const saleId = uid();
    const sale = {
      id: saleId,
      tokenId,
      tokenTicker: token.ticker || '',
      buyer,
      seller: receiver,
      amountTokens: amount,
      cost,
      status: 'pending',
      createdAt: Date.now()
    };
    await rdb.ref(`sales/${saleId}`).set(sale);
    // add to buyer history (shallow)
    await rdb.ref(`history/${buyer}/${saleId}`).set({ ...sale, role: 'buyer', note: 'pending' });
    await rdb.ref(`history/${receiver}/${saleId}`).set({ ...sale, role: 'seller', note: 'pending' });

    res.json({ ok: true, saleId, cost, receiver });
  } catch (e) {
    console.error('buy create error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Confirm sale by txHash (or server scan)
app.post('/api/sales/:saleId/confirm', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { txHash } = req.body;
    const saleSnap = await rdb.ref(`sales/${saleId}`).once('value');
    if (!saleSnap.exists()) return res.status(404).json({ error: 'sale_not_found' });
    const sale = saleSnap.val();
    if (sale.status === 'confirmed') return res.json({ ok: true, message: 'already_confirmed' });

    // Helper: confirm sale
    async function finalizeSale(foundHash) {
      // mark confirmed
      await rdb.ref(`sales/${saleId}/status`).set('confirmed');
      await rdb.ref(`sales/${saleId}/txHash`).set(foundHash || null);
      await rdb.ref(`sales/${saleId}/confirmedAt`).set(Date.now());

      // apply token changes
      const tokenSnap = await rdb.ref(`tokens/${sale.tokenId}`).once('value');
      if (!tokenSnap.exists()) {
        console.warn('token missing while finalizing', sale.tokenId);
      } else {
        const token = tokenSnap.val();
        if (token.type === 'listing') {
          const rem = Number(token.remainingSupply || 0) - Number(sale.amountTokens || 0);
          await rdb.ref(`tokens/${sale.tokenId}/remainingSupply`).set(Math.max(0, rem));
        } else {
          // user token dynamic adjust
          const issued = Number(token.supplyIssued || 0) + Number(sale.amountTokens || 0);
          // simple dynamic price rule: increase by 0.5% per token (tuneable)
          const oldPrice = Number(token.dynamicPrice || 0.1);
          const alpha = 0.005;
          const factor = 1 + alpha * Number(sale.amountTokens || 0);
          const newPrice = Number((oldPrice * factor).toFixed(9));
          await rdb.ref(`tokens/${sale.tokenId}/supplyIssued`).set(issued);
          await rdb.ref(`tokens/${sale.tokenId}/dynamicPrice`).set(newPrice);
        }
      }

      // credit buyer balance
      const balRef = rdb.ref(`balances/${sale.tokenId}/${sale.buyer}`);
      const bSnap = await balRef.once('value');
      const prev = Number(bSnap.val() || 0);
      await balRef.set(prev + Number(sale.amountTokens || 0));

      // add history confirmed
      const note = { when: Date.now(), type: 'buy_confirmed', saleId, tokenId: sale.tokenId, buyer: sale.buyer, seller: sale.seller, amountTokens: sale.amountTokens, cost: sale.cost };
      await rdb.ref(`history/${sale.buyer}/${uid()}`).set({ ...note, role: 'buyer' });
      await rdb.ref(`history/${sale.seller}/${uid()}`).set({ ...note, role: 'seller' });

      return { ok: true, message: 'sale_confirmed' };
    }

    // If txHash provided — verify directly
    if (txHash) {
      try {
        const url = `https://toncenter.com/api/v2/getTransaction?hash=${encodeURIComponent(txHash)}&api_key=${encodeURIComponent(TON_API_KEY)}`;
        const r = await axios.get(url, { timeout: 10000 }).catch(e => ({ data: null }));
        if (r.data && r.data.ok && r.data.result) {
          const tx = r.data.result;
          // try extract value and sender
          let val = 0;
          let sender = null;
          // try in_msg
          const in_msg = tx.in_msg || tx.in_message || null;
          if (in_msg && in_msg.value) val = parseTonValue(in_msg.value);
          else if (tx.value) val = parseTonValue(tx.value);

          if (in_msg && (in_msg.source || in_msg.source_address)) sender = in_msg.source || in_msg.source_address;

          // basic checks: amount >= sale.cost and sender equals buyer (best effort)
          const okAmount = val >= (Number(sale.cost) - 0.0000001);
          const okSender = sender ? (normalizeAddr(sender) === normalizeAddr(sale.buyer)) : true;

          if (okAmount && okSender) {
            return res.json(await finalizeSale(txHash));
          } else {
            // tx found but doesn't match — return info
            return res.status(400).json({ ok: false, reason: 'tx_mismatch', foundAmount: val, sender, sale });
          }
        }
      } catch (e) {
        console.warn('getTransaction error', e.message || e);
      }
    }

    // If no txHash or direct verify failed -> scan recent txs for seller (receiver)
    // We'll fetch latest transactions on seller address and try find inbound with value >= cost
    const txsUrl = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(sale.seller)}&limit=50&api_key=${encodeURIComponent(TON_API_KEY)}`;
    const resTx = await axios.get(txsUrl, { timeout: 10000 }).catch(e => ({ data: null }));
    if (!resTx.data || !resTx.data.ok) {
      // Can't verify right now — mark pending for manual check
      await rdb.ref(`sales/${saleId}/status`).set('pending_check');
      return res.json({ ok: false, reason: 'txs_unavailable' });
    }
    const txs = resTx.data.result || [];

    // find candidate tx
    let matched = null;
    for (const tx of txs) {
      // check time recent (last 24h)
      const utime = tx.utime || tx.time || 0;
      const nowSec = Math.floor(Date.now()/1000);
      if (utime && (nowSec - utime > 60 * 60 * 24)) continue;

      let val = 0;
      const in_msg = tx.in_msg || tx.in_message || null;
      if (in_msg && in_msg.value) val = parseTonValue(in_msg.value);
      else if (tx.value) val = parseTonValue(tx.value);

      if (val >= (Number(sale.cost) - 0.0000001)) {
        // optional: check sender field matches buyer
        const sender = in_msg && (in_msg.source || in_msg.source_address || in_msg.source) || tx.source || null;
        if (!sender || normalizeAddr(sender) === normalizeAddr(sale.buyer)) {
          matched = tx;
          break;
        } else {
          // still accept if amounts match — sometimes txs have masked senders
          matched = tx;
          break;
        }
      }
    }

    if (!matched) {
      // not found — leave pending for later manual/cron verification
      await rdb.ref(`sales/${saleId}/status`).set('pending_check');
      return res.json({ ok: false, reason: 'not_found' });
    }

    const foundHash = matched.id || matched.hash || (matched.in_msg && matched.in_msg.hash) || null;
    return res.json(await finalizeSale(foundHash));
  } catch (e) {
    console.error('confirm sale error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- P2P transfer (token internal transfer)
app.post('/api/transfer', async (req, res) => {
  try {
    const { tokenId, from, to, amount } = req.body;
    if (!tokenId || !from || !to || !amount) return res.status(400).json({ error: 'missing' });
    const amt = Number(amount);
    if (amt <= 0) return res.status(400).json({ error: 'bad_amount' });

    const fromRef = rdb.ref(`balances/${tokenId}/${from}`);
    const toRef = rdb.ref(`balances/${tokenId}/${to}`);

    const fSnap = await fromRef.once('value');
    const have = Number(fSnap.val() || 0);
    if (have < amt) return res.status(400).json({ error: 'insufficient_balance' });

    await fromRef.set(have - amt);
    const tSnap = await toRef.once('value');
    const prev = Number(tSnap.val() || 0);
    await toRef.set(prev + amt);

    const tx = { when: Date.now(), type: 'transfer', tokenId, from, to, amount: amt };
    await rdb.ref(`history/${from}/${uid()}`).set({ ...tx, role: 'sender' });
    await rdb.ref(`history/${to}/${uid()}`).set({ ...tx, role: 'receiver' });

    res.json({ ok: true });
  } catch (e) {
    console.error('transfer error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Get balances for an address (scan tokens)
app.get('/api/balances/:address', async (req, res) => {
  try {
    const addr = req.params.address;
    if (!addr) return res.status(400).json({ error: 'missing' });
    const tokensSnap = await rdb.ref('tokens').once('value');
    const tokens = tokensSnap.val() || {};
    const out = [];
    for (const id of Object.keys(tokens)) {
      const bSnap = await rdb.ref(`balances/${id}/${addr}`).once('value');
      const amount = Number(bSnap.val() || 0);
      if (amount > 0) out.push({ tokenId: id, amount });
    }
    res.json(out);
  } catch (e) {
    console.error('balances error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Get history for address
app.get('/api/history/:address', async (req, res) => {
  try {
    const addr = req.params.address;
    if (!addr) return res.status(400).json({ error: 'missing' });
    const snap = await rdb.ref(`history/${addr}`).once('value');
    const data = snap.val() || {};
    const arr = Object.keys(data).map(k => data[k]).sort((a,b)=> (b.when||0) - (a.when||0));
    res.json(arr);
  } catch (e) {
    console.error('history error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Coin Maker server running on port ${PORT}`)); 
