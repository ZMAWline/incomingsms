// Apply the five audit checks to one parsed row. Returns { discrepancyType, discrepancyDetail, expectedPrice }.
// ratesByVendor: { vendor: { rate, plan_name } } — from loadActiveRates()
function auditOneLine({ row, sim, history, fromDate, vendor, ratesByVendor }) {
    const price = parseFloat(row['Price'] || '0');
    const planId = (row['Bypassed Plan ID'] || '').trim() || null;
    const rateEntry = (ratesByVendor && vendor) ? ratesByVendor[vendor] : null;
    const knownRate = rateEntry ? rateEntry.rate : null;

    if (!sim) {
        return { discrepancyType: 'unknown_iccid', discrepancyDetail: `ICCID ${row['Subscription Iccid'] || '(blank)'} not found in our system`, expectedPrice: 0 };
    }

    if (NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) {
        const canceledAt = findCancelTimestamp(history);
        if (canceledAt && fromDate && new Date(canceledAt) < fromDate) {
            const dt = new Date(canceledAt).toISOString().split('T')[0];
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: `SIM was ${sim.status} as of ${dt}, before bill period start`, expectedPrice: 0 };
        }
        // No history record but currently canceled — assume canceled before period (safe flag)
        if (!canceledAt) {
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: `SIM is ${sim.status} (no cancel-date record); flag for review`, expectedPrice: 0 };
        }
    }

    if (knownRate != null && Math.abs(price - knownRate) > 0.01) {
        const planLabel = rateEntry.plan_name || planId || vendor;
        return { discrepancyType: 'rate_mismatch', discrepancyDetail: `${planLabel}: expected $${knownRate.toFixed(2)} but charged $${price.toFixed(2)}`, expectedPrice: knownRate };
    }

    return { discrepancyType: null, discrepancyDetail: null, expectedPrice: knownRate != null ? knownRate : price };
}