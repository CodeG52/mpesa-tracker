'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildAdvisorSnapshot } = require('./db');

const SYSTEM_PROMPT = `You are an elite private wealth advisor retained by high-growth founders and entrepreneurs. You speak with authority, precision, and zero filler. Every recommendation is specific, grounded in the actual numbers, and calibrated to the Kenyan market and economic context.

The user is a Nairobi-based entrepreneur with active income streams across freelance/dev contracts, a livestock GPS SaaS called Smart Shamba, and a music career in active development. They operate across agritech and creative sectors and are building aggressively on limited capital. Every shilling is a decision.

You are reviewing their M-Pesa transaction data like a CFO preparing a founder for a board meeting. Be direct. Be strategic. Treat their financial behavior as signal — not just numbers.

Structure your response exactly as follows:

**CASH FLOW VERDICT**
One sharp paragraph. What does this period's money movement say about their true financial position? No softening. Name the real story.

**WHERE MONEY IS LEAKING**
Specific expenses to cut or renegotiate. Reference actual counterparty names and KES amounts from the data. Tell them exactly what to do and why.

**INCOME OPTIMIZATION**
Which income streams are underperforming relative to their potential? What specific moves — executable this week or this month — could increase inflows across their ventures?

**CAPITAL DEPLOYMENT**
If net is positive: where should surplus go first? Give a prioritized allocation specific to their stage and Kenyan context (MMFs, T-bills, M-Shwari lock savings, SACCO, reinvestment into Smart Shamba growth, music production budget, etc.)

**DEFICIT TRIAGE** (only if net is negative)
No-nonsense. What to stop immediately, what to defer, what to activate to close the gap before next month.

**THE ONE MOVE**
The single highest-leverage financial action they should take in the next 30 days. Be specific. Be bold. Make it something they can act on today.

Under 600 words total. Precision over length. No generic advice.`;

function formatSnapshotForPrompt(snapshot) {
  const fmt = n => `KES ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

  const lines = [
    `PERIOD: ${snapshot.period} (${snapshot.dateRange.from} → ${snapshot.dateRange.to})`,
    '',
    '── SUMMARY ──',
    `Total Income:     ${fmt(snapshot.summary.totalIn)}`,
    `Total Expenses:   ${fmt(snapshot.summary.totalOut)}`,
    `Net Position:     ${fmt(snapshot.summary.net)}`,
    `Transactions:     ${snapshot.summary.txCount}`,
    `Daily Burn Rate:  ${fmt(snapshot.summary.dailyBurnRate)}/day`,
    `Savings Rate:     ${snapshot.summary.savingsRate}%`,
    '',
    '── INCOME BY CATEGORY ──',
    ...snapshot.incomeByCategory.map(r => `  ${r.category}: ${fmt(r.total)} (${r.count} txns)`),
    '',
    '── EXPENSES BY CATEGORY ──',
    ...snapshot.expenseByCategory.map(r => `  ${r.category}: ${fmt(r.total)} (${r.count} txns)`),
    '',
    '── TOP 5 SPEND COUNTERPARTIES ──',
    ...snapshot.topSpend.map(r => `  ${r.counterparty_name}: ${fmt(r.total)} (${r.txCount} txns)`),
    '',
    '── TOP 5 INCOME SOURCES ──',
    ...snapshot.topIncome.map(r => `  ${r.counterparty_name}: ${fmt(r.total)} (${r.txCount} txns)`),
    '',
    '── LARGEST INFLOWS ──',
    ...snapshot.largestInflows.map(r => `  ${fmt(r.amount)} from ${r.counterparty_name || 'Unknown'} on ${r.transaction_date?.slice(0, 10)}`),
    '',
    '── LARGEST OUTFLOWS ──',
    ...snapshot.largestOutflows.map(r => `  ${fmt(r.amount)} to ${r.counterparty_name || 'Unknown'} on ${r.transaction_date?.slice(0, 10)}`),
    '',
    '── RECURRING PAYMENTS (3+ transactions) ──',
    ...snapshot.recurring.map(r => `  ${r.counterparty_name}: ${fmt(r.total)} total, avg ${fmt(r.avgAmount)}/txn, ${r.txCount} payments`),
    '',
    '── WEEKLY TREND ──',
    ...snapshot.weeklyTrend.map(r => `  ${r.week}: out ${fmt(r.outflow)}, in ${fmt(r.inflow)}`),
  ];

  return lines.join('\n');
}

/**
 * Stream advisor analysis over SSE.
 * Writes `data: {...}\n\n` events, then `data: [DONE]\n\n`.
 */
async function streamAdvisor(period, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set. See /setup for instructions.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const snapshot = buildAdvisorSnapshot(period || 'this_month');

  if (snapshot.summary.txCount === 0) {
    res.write(`data: ${JSON.stringify({ error: 'No transactions found for this period. Add transactions first via your iOS Shortcut.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Analyse my M-Pesa financial data:\n\n${formatSnapshotForPrompt(snapshot)}`,
        },
      ],
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message || 'Claude API error' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

module.exports = { streamAdvisor, buildAdvisorSnapshot };
