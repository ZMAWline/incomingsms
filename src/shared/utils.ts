
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeToE164(to: string): string {
    const s = String(to || "");
    const digits = s.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (s.startsWith("+")) return s;
    return s;
}

// Extract "value" from lines like: Sender: 12345  OR  Receiver: "61.01"
export function extractLineValue(label: string, text: string): string {
    const t = String(text || "");
    const re = new RegExp(`${label}:\\s*"?([^"\\r\\n]+)"?`, "i");
    const m = t.match(re);
    return m ? m[1].trim() : "";
}

// IMPORTANT: actual SMS content is after the first blank line
export function extractSmsBody(text: string): string {
    const t = String(text || "").replace(/\r\n/g, "\n");
    // Split on first empty line
    const parts = t.split(/\n\s*\n/);
    if (parts.length >= 2) {
        return parts.slice(1).join("\n\n").trim();
    }
    // Fallback: last non-empty line
    const lines = t.split("\n").map(s => s.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : "";
}

export async function generateMessageIdAsync(components: {
    eventType: string;
    simId?: string | number | null;
    iccid?: string | null;
    number?: string | null;
    from?: string | null;
    body?: string | null;
    timestamp?: string | null;
}): Promise<string> {
    const { eventType, simId, iccid, number, from, body, timestamp } = components;

    const roundedTs = timestamp
        ? new Date(Math.floor(new Date(timestamp).getTime() / 60000) * 60000).toISOString()
        : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();

    const str = [eventType, simId, iccid, number, from, (body || '').slice(0, 100), roundedTs].join('|');

    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

    return `${eventType}_${hashHex}`;
}

export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: { attempts: number; label?: string; initialDelayMs?: number }
): Promise<T> {
    const { attempts, label = 'operation', initialDelayMs = 1000 } = options;
    let lastError: any;

    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            console.warn(`[Retry] ${label} attempt ${i}/${attempts} failed: ${err}`);
            if (i < attempts) {
                await sleep(initialDelayMs * Math.pow(2, i - 1));
            }
        }
    }
    throw lastError;
}
