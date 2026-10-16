// Per-host policy for outbound HTTP requests.
//
// Two decisions live here, because both depend only on the target URL and both
// were previously wrong in a way that made a single unreachable host stall the
// whole panel.
//
// 1. Proxy routing. The request library silently falls back to HTTP_PROXY /
//    HTTPS_PROXY / NO_PROXY from the process environment whenever the `proxy`
//    option is left undefined. Those variables are usually set for image pulls
//    or an interactive shell, and they also capture LAN traffic such as the
//    downloader WebAPI, which produces multi-minute hangs followed by
//    "socket hang up" (ECONNRESET). Every request is routed explicitly here.
//
// 2. Timeout budget. A dead site used to occupy one of the four per-origin
//    slots for 120 seconds, so RSS scans and retries queued up behind it. LAN
//    downloaders answer in milliseconds and deserve a much tighter budget.

function parseDomains (raw) {
  return String(raw || '')
    .split('\n')
    .map(item => item.trim().toLowerCase())
    .filter(item => item !== '')
    .map(item => item
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^\*\./, ''))
    .filter(item => item !== '');
}

function isLanHost (host) {
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // A single-label hostname such as "nas" or "qbittorrent" is never public.
  if (!host.includes('.')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ip) return false;
  const a = +ip[1];
  const b = +ip[2];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function hostnameOf (target) {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch (ignored) {
    return '';
  }
}

// Returns the proxy URL to use, or false to force a direct connection.
function resolve (target, proxy, domains) {
  if (!proxy) return false;
  const host = hostnameOf(target);
  if (!host) return false;
  const list = parseDomains(domains);
  if (!list.length) return false;
  if (list.includes('*')) return isLanHost(host) ? false : proxy;
  const matched = list.some(domain => host === domain || host.endsWith('.' + domain));
  return matched ? proxy : false;
}

function positiveNumber (value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutFor (target, lanTimeout, wanTimeout) {
  const host = hostnameOf(target);
  return host && isLanHost(host) ? lanTimeout : wanTimeout;
}

module.exports = { resolve, parseDomains, isLanHost, timeoutFor, positiveNumber };
