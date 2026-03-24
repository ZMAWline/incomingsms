
export interface Env {
    // Supabase
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;

    // SMS Ingest
    GATEWAY_SECRET?: string;
    RESELLER_WEBHOOK_URL?: string;

    // MDN Rotator
    ADMIN_RUN_SECRET?: string;
    HX_API_BASE?: string;
    HX_CLIENT_ID?: string;
    HX_AUDIENCE?: string;
    HX_GRANT_USERNAME?: string;
    HX_GRANT_PASSWORD?: string;
    HX_TOKEN_URL?: string;
    SLACK_WEBHOOK_URL?: string;

    // IP Relay
    RELAY_URL?: string;
    RELAY_KEY?: string;

    // Bindings
    TOKEN_CACHE?: KVNamespace;
    MDN_QUEUE?: Queue<any>;
    SKYLINE_GATEWAY?: Fetcher;
    MDN_ROTATOR?: Fetcher;
}

export interface WebhookDelivery {
    messageId: string;
    eventType: string;
    resellerId: string | null;
    webhookUrl: string;
    payload: any;
    status: 'delivered' | 'failed';
    attempts: number;
}
