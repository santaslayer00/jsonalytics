export type AdapterState = 'ready' | 'waiting' | 'not-configured' | 'connected';

export interface SourceAdapterStatus {
  shopify: AdapterState;
  ga4: AdapterState;
  gtm: AdapterState;
  sgTM: AdapterState;
  stape: AdapterState;
  consent: AdapterState;
}

export const defaultSourceAdapterStatus: SourceAdapterStatus = {
  shopify: 'waiting',
  ga4: 'waiting',
  gtm: 'waiting',
  sgTM: 'waiting',
  stape: 'waiting',
  consent: 'waiting',
};

export const getAdapterStateLabel = (state: AdapterState): string => {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'connected':
      return 'Connected';
    case 'not-configured':
      return 'Not configured';
    case 'waiting':
    default:
      return 'Waiting for source';
  }
};
