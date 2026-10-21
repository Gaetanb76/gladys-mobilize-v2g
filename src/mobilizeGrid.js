// Reads the current tariff grid published on mobilize-v2g.fr.
//
// The page links the grid as a PDF whose name changes with each new grid
// ("grille tarifaire (aout 2026)_<hash>.pdf"), next to a "petit pro" grid we
// must not take. The text is extracted with pdf.js (unpdf) and parsed by
// parseTariffGrid. Any failure resolves to null: the caller keeps the last
// good grid. Only https links of the two known hosts are ever downloaded.

import { extractText, getDocumentProxy } from "unpdf";
import { parseTariffGrid } from "./tariffs.js";

export const OFFER_PAGE_URL = "https://www.mobilize-v2g.fr/fr_fr";
const ALLOWED_HOSTS = new Set(["cdn-website.mobilityhouse.com", "www.mobilize-v2g.fr"]);
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The URL of the consumer ("particuliers") tariff grid linked by the offer page, or null. */
export function findGridPdfUrl(html, baseUrl = OFFER_PAGE_URL) {
  for (const [, href] of String(html).matchAll(/href\s*=\s*"([^"]+?\.pdf)"/gi)) {
    let url;
    try {
      url = new URL(decodeEntities(href), baseUrl); // the URL parser encodes the spaces of the file name
    } catch {
      continue;
    }
    const name = safeDecode(url.pathname.split("/").pop()).toLowerCase().replace(/[\s_-]+/g, "");
    if (!name.includes("grilletarifaire") || /petitpro|professionnel/.test(name)) continue;
    if (url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname)) return url.href;
  }
  return null;
}

export async function pdfToText(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function get(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
  return res;
}

/**
 * @returns {Promise<{grid: object, pdfUrl: string} | null>}
 */
export async function fetchMobilizeGrid({ fetchImpl = fetch, logger } = {}) {
  try {
    const html = await (await get(OFFER_PAGE_URL, fetchImpl)).text();
    const pdfUrl = findGridPdfUrl(html);
    if (!pdfUrl) {
      logger?.warn("Mobilize tariff grid: no grid link found on the offer page");
      return null;
    }
    const res = await get(pdfUrl, fetchImpl);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      logger?.warn("Mobilize tariff grid: the link is not a PDF of a sensible size");
      return null;
    }
    const grid = parseTariffGrid(await pdfToText(bytes));
    if (!grid) {
      logger?.warn("Mobilize tariff grid: the PDF layout was not understood, keeping the previous tariffs");
      return null;
    }
    return { grid, pdfUrl };
  } catch (err) {
    logger?.warn(`Mobilize tariff grid unavailable: ${err.message}`);
    return null;
  }
}
