/**
 * Netlify Function: /api/inventory
 *
 * Queries Turso for public-safe inventory data and returns the same JSON
 * shape the static inventory_data.json used. Sensitive columns (cost,
 * market_price, list_price, pct_market, acquisition_*, assigned_basis,
 * trade_value_in, source_url, alt_url, cl_url, id, _client_id) are
 * NEVER selected or returned.
 *
 * Required environment variables (set in Netlify UI, never in code):
 *   TURSO_URL    e.g. https://your-db-name-yourorg.turso.io
 *   TURSO_TOKEN  your Turso auth token
 */

// ── Price band tables (must match _export_inventory_preview.py) ───────────────
const BANDS_SINGLES = [
  [    10, 'Under $10'],
  [    20, '$10\u201320'],
  [    50, '$20\u201350'],
  [   100, '$50\u2013$100'],
  [   250, '$100\u2013$250'],
  [  null, '$250+'],
];

const BANDS_GRADED = [
  [   100, 'Under $100'],
  [   250, '$100\u2013$250'],
  [   500, '$250\u2013$500'],
  [  1000, '$500\u20131,000'],
  [  null, '$1,000+'],
];

const BANDS_SEALED = [
  [    50, 'Under $50'],
  [   150, '$50\u2013$150'],
  [   500, '$150\u2013$500'],
  [  null, '$500+'],
];

function priceBand(price, cls) {
  if (!price || price <= 0) return null;
  const table = cls === 'Graded' ? BANDS_GRADED : cls === 'Sealed' ? BANDS_SEALED : BANDS_SINGLES;
  for (const [ceiling, label] of table) {
    if (ceiling === null || price < ceiling) return label;
  }
  return table[table.length - 1][1];
}

// ── Turso HTTP query helper ───────────────────────────────────────────────────
async function queryTurso(sql) {
  let url = (process.env.TURSO_URL || '').trim();
  const token = process.env.TURSO_TOKEN;

  if (!url || !token) {
    throw new Error('TURSO_URL and TURSO_TOKEN environment variables are required');
  }

  // Accept libsql:// or https:// — the HTTP pipeline API always needs https://
  if (url.startsWith('libsql://')) url = 'https://' + url.slice('libsql://'.length);
  else if (!url.startsWith('https://') && !url.startsWith('http://')) url = 'https://' + url;

  const endpoint = url.replace(/\/$/, '') + '/v2/pipeline';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql } },
        { type: 'close' },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Turso HTTP ${res.status}: ${text}`);
  }

  const body = await res.json();
  const result = body.results?.[0];
  if (result?.type !== 'ok') {
    throw new Error(`Turso error: ${JSON.stringify(result)}`);
  }

  // Convert columnar response to array of plain objects
  const cols = result.response.result.cols.map(c => c.name);
  return result.response.result.rows.map(row =>
    Object.fromEntries(cols.map((col, i) => [col, row[i]?.value ?? null]))
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(event) {
  // Only allow GET
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // SELECT only the columns that are safe to expose publicly.
    // cost, market_price, list_price, pct_market, acquisition_*, assigned_basis,
    // trade_value_in, id, _client_id are intentionally excluded.
    const rows = await queryTurso(`
      SELECT
        item_class,
        name,
        set_name,
        number,
        variant,
        grading_company,
        grade,
        quantity,
        list_price,
        market_price,
        data
      FROM items
      WHERE item_class IN ('Singles', 'Graded', 'Sealed')
    `);

    const singles = [];
    const graded  = [];
    const sealed  = [];

    for (const row of rows) {
      const cls = row.item_class;

      // Parse the JSON blob for fields not in top-level columns
      let blob = {};
      try { blob = JSON.parse(row.data || '{}'); } catch { /* ignore */ }

      // Skip items marked as sold/internal
      if (blob.skip_value_in_total) continue;

      // Skip items the owner has flagged as hidden from the website
      if (blob.hide_from_website) continue;

      // Price band — prefer list_price, fall back to market_price
      const rawPrice = parseFloat(row.list_price || row.market_price || 0);
      const band = priceBand(rawPrice, cls);

      const name    = (row.name     || '').trim();
      const set     = (row.set_name || '').trim();
      const number  = (row.number   || '').trim();
      const variant = (row.variant  || '').trim();

      if (cls === 'Singles') {
        singles.push({
          name,
          set,
          number,
          variant,
          condition:  (row.grade || 'NM').trim(),
          price_band: band,
        });
      } else if (cls === 'Graded') {
        graded.push({
          name,
          set,
          number,
          variant,
          language:        blob.language || 'English',
          grading_company: (row.grading_company || '').trim().toUpperCase(),
          grade:           (row.grade || '').trim(),
          price_band:      band,
        });
      } else if (cls === 'Sealed') {
        const qty = parseInt(row.quantity ?? 1, 10);
        if (qty <= 0) continue; // sold out
        sealed.push({
          name,
          language:   blob.language || 'English',
          quantity:   qty,
          price_band: band,
        });
      }
    }

    // Sort alphabetically by name
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
    singles.sort(byName);
    graded.sort(byName);
    sealed.sort(byName);

    const generated = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });

    const payload = { generated, singles, graded, sealed };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Cache on Netlify's CDN for 60 s; client may use stale for up to 30 s more
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
      },
      body: JSON.stringify(payload),
    };

  } catch (err) {
    console.error('inventory function error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load inventory' }),
    };
  }
}
