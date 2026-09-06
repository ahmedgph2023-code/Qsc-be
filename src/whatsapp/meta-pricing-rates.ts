/**
 * Approximate Meta Cloud API per-message rates (USD), effective ~July 2025+.
 * Source: Meta published rate cards / public BSP summaries.
 * Final invoice may differ (taxes, volume tiers, partner markups, credits).
 */
export type MetaPricingCategory =
	| 'MARKETING'
	| 'UTILITY'
	| 'AUTHENTICATION'
	| 'SERVICE'
	| 'UNKNOWN';

export type MetaRateRow = {
	country: string; // ISO-ish market key
	label: string;
	marketing: number;
	utility: number;
	authentication: number;
	service: number; // usually 0
};

/** Calling-code prefix → market key used in RATE_CARD */
export const CALLING_CODE_TO_MARKET: Array<{ prefix: string; market: string }> = [
	{ prefix: '1', market: 'NORTH_AMERICA' },
	{ prefix: '44', market: 'UK' },
	{ prefix: '49', market: 'GERMANY' },
	{ prefix: '55', market: 'BRAZIL' },
	{ prefix: '62', market: 'INDONESIA' },
	{ prefix: '91', market: 'INDIA' },
	{ prefix: '971', market: 'UAE' },
	{ prefix: '966', market: 'SAUDI' },
	{ prefix: '974', market: 'QATAR' },
	{ prefix: '965', market: 'KUWAIT' },
	{ prefix: '973', market: 'BAHRAIN' },
	{ prefix: '968', market: 'OMAN' },
	{ prefix: '20', market: 'EGYPT' },
	{ prefix: '212', market: 'OTHER' },
	{ prefix: '213', market: 'OTHER' },
	{ prefix: '216', market: 'OTHER' },
	{ prefix: '961', market: 'OTHER' },
	{ prefix: '962', market: 'OTHER' },
	{ prefix: '964', market: 'OTHER' },
];

export const RATE_CARD_USD: Record<string, MetaRateRow> = {
	NORTH_AMERICA: {
		country: 'NORTH_AMERICA',
		label: 'USA & Canada',
		marketing: 0.025,
		utility: 0.0034,
		authentication: 0.0034,
		service: 0,
	},
	UK: {
		country: 'UK',
		label: 'United Kingdom',
		marketing: 0.0635,
		utility: 0.022,
		authentication: 0.022,
		service: 0,
	},
	GERMANY: {
		country: 'GERMANY',
		label: 'Germany',
		marketing: 0.1365,
		utility: 0.055,
		authentication: 0.055,
		service: 0,
	},
	BRAZIL: {
		country: 'BRAZIL',
		label: 'Brazil',
		marketing: 0.0625,
		utility: 0.0068,
		authentication: 0.0068,
		service: 0,
	},
	INDONESIA: {
		country: 'INDONESIA',
		label: 'Indonesia',
		marketing: 0.0411,
		utility: 0.025,
		authentication: 0.025,
		service: 0,
	},
	INDIA: {
		country: 'INDIA',
		label: 'India',
		marketing: 0.0118,
		utility: 0.0014,
		authentication: 0.0014,
		service: 0,
	},
	UAE: {
		country: 'UAE',
		label: 'United Arab Emirates',
		marketing: 0.0499,
		utility: 0.0157,
		authentication: 0.0157,
		service: 0,
	},
	SAUDI: {
		country: 'SAUDI',
		label: 'Saudi Arabia',
		marketing: 0.0456,
		utility: 0.0116,
		authentication: 0.0116,
		service: 0,
	},
	QATAR: {
		country: 'QATAR',
		label: 'Qatar',
		marketing: 0.0472,
		utility: 0.0157,
		authentication: 0.0157,
		service: 0,
	},
	KUWAIT: {
		country: 'KUWAIT',
		label: 'Kuwait',
		marketing: 0.0472,
		utility: 0.0157,
		authentication: 0.0157,
		service: 0,
	},
	BAHRAIN: {
		country: 'BAHRAIN',
		label: 'Bahrain',
		marketing: 0.048,
		utility: 0.0157,
		authentication: 0.0157,
		service: 0,
	},
	OMAN: {
		country: 'OMAN',
		label: 'Oman',
		marketing: 0.0521,
		utility: 0.0157,
		authentication: 0.0157,
		service: 0,
	},
	EGYPT: {
		country: 'EGYPT',
		label: 'Egypt',
		// Often priced under broader “Other” / regional cards — treat as estimate.
		marketing: 0.0604,
		utility: 0.0077,
		authentication: 0.0077,
		service: 0,
	},
	OTHER: {
		country: 'OTHER',
		label: 'Rest of World',
		marketing: 0.0604,
		utility: 0.0077,
		authentication: 0.0077,
		service: 0,
	},
};

export function marketFromWaId(waId: string | null | undefined): string {
	const digits = String(waId || '').replace(/\D/g, '');
	if (!digits) return 'OTHER';
	const sorted = [...CALLING_CODE_TO_MARKET].sort((a, b) => b.prefix.length - a.prefix.length);
	for (const row of sorted) {
		if (digits.startsWith(row.prefix)) return row.market;
	}
	return 'OTHER';
}

export function countryCodeFromMarket(market: string): string {
	const map: Record<string, string> = {
		NORTH_AMERICA: 'US',
		UK: 'GB',
		GERMANY: 'DE',
		BRAZIL: 'BR',
		INDONESIA: 'ID',
		INDIA: 'IN',
		UAE: 'AE',
		SAUDI: 'SA',
		QATAR: 'QA',
		KUWAIT: 'KW',
		BAHRAIN: 'BH',
		OMAN: 'OM',
		EGYPT: 'EG',
		OTHER: 'XX',
	};
	return map[market] || 'XX';
}

export function rateFor(
	market: string,
	category: MetaPricingCategory,
): { rate: number; market: string; label: string } {
	const row = RATE_CARD_USD[market] || RATE_CARD_USD.OTHER;
	const cat = String(category || 'UNKNOWN').toUpperCase() as MetaPricingCategory;
	let rate = 0;
	if (cat === 'MARKETING') rate = row.marketing;
	else if (cat === 'UTILITY') rate = row.utility;
	else if (cat === 'AUTHENTICATION') rate = row.authentication;
	else if (cat === 'SERVICE') rate = row.service;
	else rate = 0;
	return { rate, market: row.country, label: row.label };
}

export const BILLING_DISCLAIMER =
	'Estimated Meta cost — final amount may differ from the Meta invoice (taxes, volume tiers, partner billing, credits).';
