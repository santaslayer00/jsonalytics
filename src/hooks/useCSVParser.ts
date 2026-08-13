import { useState, useCallback } from 'react';
import { parseShopifyOrdersCsv } from '../utils/csvParsing';
import type { CSVParseResult } from '../utils/csvParsing';

export type { CSVParseResult };

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
          const result = parseShopifyOrdersCsv(text);
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
