// Outbound webhooks through Svix (https://docs.svix.com/quickstart): each key project event becomes one
// Standard Webhooks-compliant, signed message. Svix owns delivery — retries, replay protection and the
// per-endpoint delivery log live in the Svix dashboard, not here. Undelivered endpoints are added there.
import { Svix } from 'svix';
import { redact, log as slog } from './logger.mjs';

/** One Svix application owns this studio's endpoints; its uid doubles as the app id for every message. */
export const SVIX_APP_UID = 'reel-studio';
const APP_NAME = 'Reel Studio';
let client = null;

export function webhooksEnabled() { return !!process.env.SVIX_API_KEY; }

/** Built on first use, so the app (and the tests) start without SVIX_API_KEY. */
export function svixClient() {
  if (!webhooksEnabled()) return null;
  client ||= new Svix(process.env.SVIX_API_KEY, process.env.SVIX_BASE_URL ? { serverUrl: process.env.SVIX_BASE_URL } : {});
  return client;
}

/** One message body. eventId is Svix's idempotency key and must be unique per application. */
export function webhookMessage(eventType, eventId, payload) {
  return { eventType, eventId, application: { name: APP_NAME, uid: SVIX_APP_UID }, payload };
}

/**
 * Sends one event and resolves { sent: true, id } or { sent: false, error }. It never throws: a webhook
 * outage must not fail a render or a publish.
 */
export async function sendWebhook(eventType, payload, { eventId = `${eventType}-${Date.now()}` } = {}) {
  const svix = svixClient();
  if (!svix) return { sent: false, error: 'SVIX_API_KEY is not set' };
  try {
    const msg = await svix.message.create(SVIX_APP_UID, webhookMessage(eventType, eventId, payload));
    slog('info', 'webhook sent', { eventType, message: msg.id });
    return { sent: true, id: msg.id };
  } catch (e) {
    const error = redact(e?.message || String(e));
    slog('warn', 'webhook not sent', { eventType, err: error });
    return { sent: false, error };
  }
}

/** Fire-and-forget project event. Without a key no Svix call is made at all. */
export function notifyProject(p, eventType, data = {}) {
  if (!webhooksEnabled()) return;
  sendWebhook(eventType, {
    project: {
      id: p.id, topic: p.topic, title: p.script?.title || p.topic, seconds: p.seconds,
      chapters: p.chapters?.length || null,
    },
    ...data,
    at: new Date().toISOString(),
  }, { eventId: `${p.id}-${eventType}-${Date.now()}` }).catch(() => {});
}
