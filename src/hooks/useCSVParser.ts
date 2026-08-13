import { useState, useCallback } from 'react';
import type { Region } from '../utils/constants';

export interface CSVParseResult {
  grossRevenue: number;
  totalOrders: number;
  codOrders: number;
  rtoOrders: number;
  newCustomers: number;
  avgOrderValue: number;
  detectedRegion: Region | null;
}

export const useCSVParser = () => {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseShopifyCSV = useCallback((file: File): Promise<CSVParseResult> => {
    return new Promise((resolve, reject) => {
      setIsParsing(true);
      setError(null);

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const text = event.target?.result as string;
          if (!text) {
            throw new Error('Empty CSV file.');
          }

          const lines = parseCSVRows(text);
          if (lines.length < 2) {
            throw new Error('CSV does not contain enough data (missing header or rows).');
          }

          const headers = lines[0].map(h => h.trim().toLowerCase());
          
          // Index mapping
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

          // Process rows (skip header)
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
              uniqueOrders.set(name, {
                total,
                subtotal,
                gateway,
                financial,
                fulfillment,
                email,
                country,
              });
            }
          }

          let grossRevenue = 0;
          let codOrdersCount = 0;
          let rtoOrdersCount = 0;
          const customerOrderCounts = new Map<string, number>();
          const regionCounts = new Map<Region, number>();

          uniqueOrders.forEach((order) => {
            grossRevenue += order.total;

            // COD detection: gateway contains "cash", "delivery", "cod", or "manual"
            if (order.gateway.includes('cash') || order.gateway.includes('delivery') || order.gateway.includes('cod')) {
              codOrdersCount++;
            }

            // Customer customer counts
            if (order.email) {
              customerOrderCounts.set(order.email, (customerOrderCounts.get(order.email) || 0) + 1);
            }

            // Region counts
            if (order.country) {
              let detectedReg: Region | null = null;
              if (order.country === 'IN') detectedReg = 'IN';
              else if (order.country === 'US') detectedReg = 'US';
              else if (order.country === 'GB') detectedReg = 'UK';
              else if (order.country === 'AU') detectedReg = 'AU';
              else if (order.country === 'CA') detectedReg = 'CA';

              if (detectedReg) {
                regionCounts.set(detectedReg, (regionCounts.get(detectedReg) || 0) + 1);
              }
            }
          });

          // A CSV slice cannot identify first-ever customers or RTOs reliably:
          // refunds, voids, and restocks are not synonymous with RTO. Both need
          // verified operational data from the merchant.
          const newCustomersCount = 0;

          // Detect predominant region
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

          const result: CSVParseResult = {
            grossRevenue,
            totalOrders: totalOrdersCount,
            codOrders: codOrdersCount,
            rtoOrders: rtoOrdersCount,
            newCustomers: newCustomersCount,
            avgOrderValue,
            detectedRegion,
          };

          setIsParsing(false);
          resolve(result);
        } catch (err: any) {
          setIsParsing(false);
          setError(err.message || 'Failed to parse CSV.');
          reject(err);
        }
      };

      reader.onerror = () => {
        setIsParsing(false);
        setError('Error reading file.');
        reject(new Error('Error reading file.'));
      };

      reader.readAsText(file);
    });
  }, []);

  return {
    isParsing,
    error,
    parseShopifyCSV,
  };
};

/**
 * Standard CSV row parser that handles quotes and commas correctly.
 */
function parseCSVRows(text: string): string[][] {
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
