export type Region = 'US' | 'UK' | 'CA' | 'AU' | 'IN' | 'NZ';

export interface RegionConfig {
  code: Region;
  label: string;
  currency: string;
  locale: string;
  tlds: string[];
  /** Short privacy-law reference used in report/compliance language for this market. */
  privacyTerm: string;
}

export const REGIONS: Record<Region, RegionConfig> = {
  US: {
    code: 'US',
    label: 'United States',
    currency: 'USD',
    locale: 'en-US',
    tlds: ['.com', '.us', '.net', '.org'],
    privacyTerm: 'CCPA/CPRA-aligned',
  },
  UK: {
    code: 'UK',
    label: 'United Kingdom',
    currency: 'GBP',
    locale: 'en-GB',
    tlds: ['.co.uk', '.uk', '.org.uk'],
    privacyTerm: 'UK GDPR-aligned',
  },
  CA: {
    code: 'CA',
    label: 'Canada',
    currency: 'CAD',
    locale: 'en-CA',
    tlds: ['.ca'],
    privacyTerm: 'PIPEDA-aligned',
  },
  AU: {
    code: 'AU',
    label: 'Australia',
    currency: 'AUD',
    locale: 'en-AU',
    tlds: ['.com.au', '.au', '.net.au'],
    privacyTerm: 'Australian Privacy Act-aligned',
  },
  IN: {
    code: 'IN',
    label: 'India',
    currency: 'INR',
    locale: 'en-IN',
    tlds: ['.in', '.co.in', '.net.in'],
    privacyTerm: 'DPDP-aligned',
  },
  NZ: {
    code: 'NZ',
    label: 'New Zealand',
    currency: 'NZD',
    locale: 'en-NZ',
    tlds: ['.co.nz', '.nz', '.org.nz'],
    privacyTerm: 'Privacy Act 2020-aligned',
  },
};
