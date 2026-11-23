// Offscreen helper: service workers can't call URL.createObjectURL(), so the
// background script hands us a Blob (by reference, via BroadcastChannel) and
// we return a small blob: URL string that chrome.downloads can save directly.
const channel = new BroadcastChannel('blob-downloader-offscreen');

channel.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === 'create-blob-url') {
    try {
      const url = URL.createObjectURL(msg.blob);
      channel.postMessage({ type: 'blob-url-result', requestId: msg.requestId, url });
    } catch (e) {
      channel.postMessage({ type: 'blob-url-result', requestId: msg.requestId, error: String(e && e.message || e) });
    }
  } else if (msg.type === 'revoke-blob-url') {
    try { URL.revokeObjectURL(msg.url); } catch (e) { /* ignore */ }
  }
};
