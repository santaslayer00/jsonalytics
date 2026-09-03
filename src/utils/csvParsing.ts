import type { Region } from './constants.ts';

export interface CSVParseResult {
  grossRevenue: number;
  totalOrders: number;
  codOrders: number;
  rtoOrders: number;
  newCustomers: number;
  avgOrderValue: number;
  detectedRegion: Region | null;
  /**
   * NOT authoritative RTO — a suggestion only, from orders whose Fulfillment
   * Status is "restocked" (Shopify's own signal for inventory returned to
   * origin). Surfaced to pre-fill the confirm-before-scan RTO input as a
   * starting point; the operator still has to confirm or correct it, same
   * as the rest of this app's evidence-over-inference discipline.
   */
  suggestedRtoOrders: number;
}

/**
 * Standard CSV row parser that handles quotes and commas correctly.
 */
export function parseCSVRows(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        cell += '"';
        i++;
      } else {
        // Toggle quote block
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      row.push(cell);
      result.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    result.push(row);
  }

  return result;
}

/**
 * Pure parsing/aggregation logic, split out of useCSVParser so it can be
 * unit-tested directly without a DOM/FileReader. Throws on malformed input —
 * callers (the hook) are responsible for catching and surfacing errors.
 */
export function parseShopifyOrdersCsv(text: string): CSVParseResult {
  if (!text) {
    throw new Error('Empty CSV file.');
  }

  const lines = parseCSVRows(text);
  if (lines.length < 2) {
    throw new Error('CSV does not contain enough data (missing header or rows).');
  }

  const headers = lines[0].map((h) => h.trim().toLowerCase());

  const idxName = headers.indexOf('name');
  const idxTotal = headers.indexOf('total');
  const idxSubtotal = headers.indexOf('subtotal');
  const idxGateway = headers.indexOf('gateway');
  const idxFinancial = headers.indexOf('financial status');
  const idxFulfillment = headers.indexOf('fulfillment status');
  const idxEmail = headers.indexOf('email');
  const idxCountry = headers.indexOf('billing country');

  if (idxName === -1) {
    throw new Error('Invalid Shopify Orders CSV: Missing "Name" column.');
  }

  const uniqueOrders = new Map<string, {
    total: number;
    subtotal: number;
    gateway: string;
    financial: string;
    fulfillment: string;
    email: string;
    country: string;
  }>();

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.length < headers.length || !row[idxName]) continue;

    const name = row[idxName].trim();
    const total = parseFloat(row[idxTotal]) || 0;
    const subtotal = idxSubtotal !== -1 ? parseFloat(row[idxSubtotal]) || 0 : total;
    const gateway = idxGateway !== -1 ? row[idxGateway].toLowerCase() : '';
    const financial = idxFinancial !== -1 ? row[idxFinancial].toLowerCase() : '';
    const fulfillment = idxFulfillment !== -1 ? row[idxFulfillment].toLowerCase() : '';
    const email = idxEmail !== -1 ? row[idxEmail].trim().toLowerCase() : '';
    const country = idxCountry !== -1 ? row[idxCountry].trim().toUpperCase() : '';

    // Shopify CSV can have multiple rows per order (for different line items).
    // We only count unique order details.
    if (!uniqueOrders.has(name)) {
      uniqueOrders.set(name, { total, subtotal, gateway, financial, fulfillment, email, country });
    }
  }

  let grossRevenue = 0;
  let codOrdersCount = 0;
  let suggestedRtoOrdersCount = 0;
  const customerOrderCounts = new Map<string, number>();
  const regionCounts = new Map<Region, number>();

  uniqueOrders.forEach((order) => {
    grossRevenue += order.total;

    // COD detection: gateway contains "cash", "delivery", "cod", or "manual"
    if (order.gateway.includes('cash') || order.gateway.includes('delivery') || order.gateway.includes('cod')) {
      codOrdersCount++;
    }

    // Not RTO itself (see below) — but "restocked" is Shopify's own
    // fulfillment-status signal for inventory that came back to origin,
    // which is what an RTO order looks like. Kept separate from
    // rtoOrdersCount, which stays honestly 0.
    if (order.fulfillment.includes('restocked')) {
      suggestedRtoOrdersCount++;
    }

    if (order.email) {
      customerOrderCounts.set(order.email, (customerOrderCounts.get(order.email) || 0) + 1);
    }

    if (order.country) {
      let detectedReg: Region | null = null;
      if (order.country === 'IN') detectedReg = 'IN';
      else if (order.country === 'US') detectedReg = 'US';
      else if (order.country === 'GB') detectedReg = 'UK';
      else if (order.country === 'AU') detectedReg = 'AU';
      else if (order.country === 'CA') detectedReg = 'CA';
      else if (order.country === 'NZ') detectedReg = 'NZ';

      if (detectedReg) {
        regionCounts.set(detectedReg, (regionCounts.get(detectedReg) || 0) + 1);
      }
    }
  });

  // A CSV slice cannot identify first-ever customers or RTOs reliably:
  // refunds, voids, and restocks are not synonymous with confirmed RTO.
  // Both need verified operational data from the merchant.
  const newCustomersCount = 0;
  const rtoOrdersCount = 0;

  let detectedRegion: Region | null = null;
  let maxCount = 0;
  regionCounts.forEach((count, reg) => {
    if (count > maxCount) {
      maxCount = count;
      detectedRegion = reg;
    }
  });

  const totalOrdersCount = uniqueOrders.size;
  const avgOrderValue = totalOrdersCount > 0 ? grossRevenue / totalOrdersCount : 0;

  return {
    grossRevenue,
    totalOrders: totalOrdersCount,
    codOrders: codOrdersCount,
    rtoOrders: rtoOrdersCount,
    newCustomers: newCustomersCount,
    avgOrderValue,
    detectedRegion,
    suggestedRtoOrders: suggestedRtoOrdersCount,
  };
}
