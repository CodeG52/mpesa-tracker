'use strict';

// Amount: handles "Ksh1,000.00", "KES 1,000", "Ksh500"
const AMOUNT_RE = /(?:KES|Ksh)\s*([\d,]+(?:\.\d+)?)/i;
// Balance: "New M-PESA balance is Ksh5,000.00"
const BALANCE_RE = /(?:New\s+)?M-PESA balance is\s+(?:KES|Ksh)\s*([\d,]+(?:\.\d+)?)/i;
// Date/time: "on 10/4/24 at 2:30 PM"
const DATE_TIME_RE = /on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i;
// Transaction code: 8-12 uppercase alphanumeric at start
const TX_CODE_RE = /^([A-Z0-9]{8,12})\s+(?:Confirmed|confirmed)/;
// Phone number: 07XX or 2547XX or +2547XX
const PHONE_RE = /(\+?254\d{9}|0[17]\d{8})/;

function parseAmount(str) {
  if (!str) return null;
  return parseFloat(str.replace(/,/g, ''));
}

function parseMpesaDate(dateStr, timeStr) {
  if (!dateStr) return new Date().toISOString();
  try {
    const parts = dateStr.split('/');
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    let year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;

    let hours = 0, minutes = 0;
    if (timeStr) {
      const m = timeStr.match(/(\d+):(\d+)\s*([AP]M)/i);
      if (m) {
        hours = parseInt(m[1], 10);
        minutes = parseInt(m[2], 10);
        const period = m[3].toUpperCase();
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
      }
    }
    return new Date(year, month, day, hours, minutes).toISOString();
  } catch (e) {
    return new Date().toISOString();
  }
}

function extractBalance(sms) {
  const m = sms.match(BALANCE_RE);
  return m ? parseAmount(m[1]) : null;
}

function extractTxCode(sms) {
  const m = sms.match(TX_CODE_RE);
  return m ? m[1] : null;
}

function extractDateTime(sms) {
  const m = sms.match(DATE_TIME_RE);
  if (!m) return new Date().toISOString();
  return parseMpesaDate(m[1], m[2]);
}

/**
 * Parse a raw M-Pesa SMS string.
 * Returns a transaction object or { parse_failed: 1, sms_raw: sms }
 */
function parseTransaction(sms) {
  const raw = sms.trim();
  const base = {
    sms_raw: raw,
    transaction_code: extractTxCode(raw),
    mpesa_balance: extractBalance(raw),
    transaction_date: extractDateTime(raw),
    category: 'uncategorized',
    note: null,
    is_pending: 1,
    parse_failed: 0,
    created_at: new Date().toISOString(),
  };

  // 1. RECEIVED MONEY
  // "Confirmed. You have received Ksh1,000.00 from JOHN DOE 0712345678 on ..."
  let m = raw.match(
    /you have received\s+((?:KES|Ksh)\s*[\d,]+(?:\.\d+)?)\s+from\s+([A-Z][A-Z\s]+?)\s+(\+?254\d{9}|0[17]\d{8})\s+on/i
  );
  if (m) {
    const phoneMatch = raw.match(PHONE_RE);
    return {
      ...base,
      direction: 'in',
      amount: parseAmount(m[1].replace(/[^\d.,]/g, '')),
      counterparty_name: m[2].trim(),
      counterparty_number: phoneMatch ? phoneMatch[1] : null,
    };
  }

  // 2. SENT TO PERSON
  // "Confirmed. Ksh500.00 sent to JOHN DOE 0712345678 on ..."
  m = raw.match(
    /confirmed[.\s]+((?:KES|Ksh)\s*[\d,]+(?:\.\d+)?)\s+sent to\s+([A-Z][A-Z\s]+?)\s+(\+?254\d{9}|0[17]\d{8})\s+on/i
  );
  if (m) {
    return {
      ...base,
      direction: 'out',
      amount: parseAmount(m[1].replace(/[^\d.,]/g, '')),
      counterparty_name: m[2].trim(),
      counterparty_number: m[3],
    };
  }

  // 3. PAID TO BUSINESS / PAYBILL / TILL
  // "Confirmed. Ksh200.00 paid to NAIROBI WATER 123456 on ..."
  // "Confirmed. Ksh200.00 paid to BUSINESS NAME. on ..."
  m = raw.match(
    /confirmed[.\s]+((?:KES|Ksh)\s*[\d,]+(?:\.\d+)?)\s+paid to\s+([A-Z0-9][A-Z0-9\s&\-'.,]+?)\s*(?:\d{4,})?[.\s]+on/i
  );
  if (m) {
    // Extract business account number if present
    const bizNumMatch = m[2].match(/\s+(\d{4,})$/);
    const bizName = bizNumMatch ? m[2].slice(0, -bizNumMatch[0].length).trim() : m[2].replace(/\.$/, '').trim();
    const bizNum = bizNumMatch ? bizNumMatch[1] : null;
    return {
      ...base,
      direction: 'out',
      amount: parseAmount(m[1].replace(/[^\d.,]/g, '')),
      counterparty_name: bizName,
      counterparty_number: bizNum,
    };
  }

  // 4. WITHDRAWAL
  // "Ksh1,000.00 withdrawn from M-PESA on ..." or "Confirmed. Ksh..."
  m = raw.match(
    /((?:KES|Ksh)\s*[\d,]+(?:\.\d+)?)\s+withdrawn from\s+(?:your\s+)?M-PESA\s+on/i
  );
  if (m) {
    return {
      ...base,
      direction: 'out',
      amount: parseAmount(m[1].replace(/[^\d.,]/g, '')),
      counterparty_name: 'ATM Withdrawal',
      counterparty_number: null,
    };
  }

  // 5. AIRTIME
  // "You bought Ksh50.00 airtime for 0712345678 on ..."
  // "You bought Ksh50.00 of airtime on ..."
  m = raw.match(
    /you bought\s+((?:KES|Ksh)\s*[\d,]+(?:\.\d+)?)\s+(?:of\s+)?airtime(?:\s+for\s+(\+?254\d{9}|0[17]\d{8}))?\s+on/i
  );
  if (m) {
    return {
      ...base,
      direction: 'out',
      amount: parseAmount(m[1].replace(/[^\d.,]/g, '')),
      counterparty_name: 'Airtime',
      counterparty_number: m[2] || null,
    };
  }

  // 6. REVERSAL
  // "Your M-PESA reversal of KES X..."
  m = raw.match(
    /M-PESA reversal of\s+((?:KES|Ksh)\s*[\d,]+(?:\.\d+)?)/i
  );
  if (m) {
    const amountMatch = raw.match(AMOUNT_RE);
    return {
      ...base,
      direction: 'in',
      amount: parseAmount(m[1].replace(/[^\d.,]/g, '')),
      counterparty_name: 'M-Pesa Reversal',
      counterparty_number: null,
    };
  }

  // 7. GENERIC CONFIRMED (catch-all for known Confirmed pattern)
  // Try to at least extract amount and direction hint
  m = raw.match(/confirmed[.\s]+((?:KES|Ksh)\s*[\d,]+(?:\.\d+)?)/i);
  if (m) {
    const amount = parseAmount(m[1].replace(/[^\d.,]/g, ''));
    const phoneMatch = raw.match(PHONE_RE);
    // Guess direction from keywords
    const isIn = /received|reversal|refund/i.test(raw);
    return {
      ...base,
      direction: isIn ? 'in' : 'out',
      amount,
      counterparty_name: null,
      counterparty_number: phoneMatch ? phoneMatch[1] : null,
      parse_failed: 0,
    };
  }

  // FALLBACK: unparseable — flag for manual review
  return {
    sms_raw: raw,
    transaction_code: extractTxCode(raw),
    direction: null,
    amount: null,
    counterparty_name: null,
    counterparty_number: null,
    transaction_date: new Date().toISOString(),
    mpesa_balance: extractBalance(raw),
    category: 'uncategorized',
    note: null,
    is_pending: 1,
    parse_failed: 1,
    created_at: new Date().toISOString(),
  };
}

module.exports = { parseTransaction };
