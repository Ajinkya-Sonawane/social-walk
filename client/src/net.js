// Thin WebSocket client with auto-reconnect.
export function connectRealtime(handlers) {
  let ws, closedByUs = false, retry = 0, timer;
  function open() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 0; handlers.open?.(); };
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); handlers[m.t]?.(m); } catch (err) { console.error(err); } };
    ws.onclose = (e) => {
      handlers.close?.(e);
      if (closedByUs || e.code === 4001) return;
      timer = setTimeout(open, Math.min(8000, 500 * 2 ** retry++));
    };
  }
  open();
  return {
    send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); },
    close() { closedByUs = true; clearTimeout(timer); ws?.close(); },
  };
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
