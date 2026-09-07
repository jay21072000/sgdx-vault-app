/**
 * SgdxVaultOracle.js
 * ──────────────────────────────────────────────────────────────────────────
 * Fetch live USD/SGD price feed from Pyth Network.
 * Feed ID: 0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918
 *
 * Phase 1.5:
 *   Admin fetches live Pyth price and pushes to on-chain vault_state via
 *   update_mock_price instruction.
 */

export const PYTH_USD_SGD_FEED_ID = "0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918";

/**
 * Fetch live Pyth USD/SGD price with staleness check.
 * @param {number} maxAgeSeconds - Max allowed staleness in seconds (default: 60s)
 * @returns {Promise<{ price: number, publishTime: number, ageSec: number, source: string, feedId: string }>}
 */
export async function fetchPythUsdSgdPrice(maxAgeSeconds = 60) {
  const cleanFeedId = PYTH_USD_SGD_FEED_ID.replace(/^0x/, "");
  const endpoints = [
    `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_USD_SGD_FEED_ID}`,
    `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${cleanFeedId}`,
    `https://open.er-api.com/v6/latest/USD`
  ];

  let lastError = null;

  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();

      // 1. Pyth Hermes REST response
      if (data && Array.isArray(data.parsed) && data.parsed.length > 0) {
        const item = data.parsed[0];
        const priceObj = item.price;
        const rawPrice = Number(priceObj.price) * Math.pow(10, priceObj.expo);
        const publishTime = priceObj.publish_time; // unix timestamp in seconds
        const nowSec = Math.floor(Date.now() / 1000);
        const ageSec = Math.max(0, nowSec - publishTime);

        if (ageSec > maxAgeSeconds) {
          throw new Error(`Pyth price is stale (published ${ageSec}s ago, max allowed staleness is ${maxAgeSeconds}s).`);
        }

        return {
          price: rawPrice,
          publishTime,
          ageSec,
          source: "Pyth Hermes Live Oracle",
          feedId: PYTH_USD_SGD_FEED_ID,
        };
      }

      // 2. ER-API Live Exchange Rate fallback if Pyth 401 rate-limited
      if (data && data.result === "success" && data.rates && data.rates.SGD) {
        const rawPrice = Number(data.rates.SGD);
        const publishTime = data.time_last_update_unix || Math.floor(Date.now() / 1000);
        const nowSec = Math.floor(Date.now() / 1000);
        const ageSec = Math.max(0, nowSec - publishTime);

        return {
          price: rawPrice,
          publishTime,
          ageSec,
          source: "FX Fallback (NOT Pyth)",
          feedId: PYTH_USD_SGD_FEED_ID,
        };
      }
    } catch (err) {
      lastError = err;
      console.warn(`Oracle endpoint fetch failed on ${url}:`, err.message);
    }
  }

  throw new Error(
    `Live Pyth Oracle fetch failed: ${lastError?.message || "Unable to retrieve live Pyth price"}. Please verify internet connection or API availability.`
  );
}

/**
 * Convert a float price (e.g. 1.345678) into (priceNumerator, priceDenominator) BigInt pair
 * with 1e6 precision for on-chain storage.
 */
export function convertPriceToNumeratorDenominator(priceFloat, precision = 1_000_000) {
  const num = BigInt(Math.round(priceFloat * precision));
  const den = BigInt(precision);
  return { priceNumerator: num, priceDenominator: den };
}
