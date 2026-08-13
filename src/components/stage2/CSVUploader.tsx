import React, { useRef } from 'react';
import { useCSVParser } from '../../hooks/useCSVParser';
import type { CSVParseResult } from '../../hooks/useCSVParser';

interface CSVUploaderProps {
  onDataParsed: (data: CSVParseResult) => void;
}

export const CSVUploader: React.FC<CSVUploaderProps> = ({ onDataParsed }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isParsing, error, parseShopifyCSV } = useCSVParser();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const parsedData = await parseShopifyCSV(file);
        onDataParsed(parsedData);
      } catch {
        // Error is captured in useCSVParser
      }
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  return (
    <div
      style={{
        border: '1px dashed var(--border)',
        borderRadius: '6px',
        padding: '14px 18px',
        backgroundColor: 'var(--panel-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600 }}>Shopify Orders CSV Sync</div>
        <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
          Aggregates Sales, Orders, COD Share, RTOs, and region data automatically.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".csv"
          style={{ display: 'none' }}
        />

        <button
          onClick={triggerFileSelect}
          disabled={isParsing}
          style={{
            backgroundColor: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            padding: '7px 14px',
            fontSize: '12px',
            fontWeight: 600,
          }}
        >
          {isParsing ? 'Processing...' : 'Upload Shopify Orders CSV'}
        </button>

        {isParsing && (
          <span style={{ fontSize: '11px', color: 'var(--accent)', animation: 'pulse 1.5s infinite' }}>
            Parsing large transaction logs...
          </span>
        )}
      </div>

      {error && (
        <div style={{ width: '100%', fontSize: '11px', color: 'var(--danger)', marginTop: '4px' }}>
          ❌ {error}
        </div>
      )}
    </div>
  );
};
