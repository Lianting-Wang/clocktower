/* Local transport/clipboard adapters. Original application behavior stays in its captured bundle. */
(() => {
  'use strict';
  const NativeWebSocket = window.WebSocket;
  const newSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
  window.WebSocket = class LocalWebSocket extends NativeWebSocket {
    constructor(address, protocols) {
      const url = new URL(address, location.href);
      if (url.host === location.host && url.pathname.startsWith('/ws/')) {
        const [, , room, peer] = url.pathname.split('/');
        const key = `clocktower.local.token.${room}.${peer}`;
        let token = localStorage.getItem(key);
        if (!token) {
          token = newSecret();
          localStorage.setItem(key, token);
        }
        url.searchParams.set('token', token);
      }
      if (protocols === undefined) super(url.href);
      else super(url.href, protocols);
    }
  };
  const nativeCopy = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  const copy = async value => {
    if (nativeCopy) {
      try { return await nativeCopy(value); } catch { /* HTTP LAN and restricted clipboard permissions */ }
    }
    const field = document.createElement('textarea');
    field.value = String(value);
    field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
    field.setAttribute('readonly', '');
    document.body.append(field);
    field.select();
    field.setSelectionRange(0, field.value.length);
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) window.prompt('请复制以下内容：', String(value));
  };
  if (navigator.clipboard) {
    try { navigator.clipboard.writeText = copy; } catch { /* browsers with read-only clipboard objects */ }
  } else {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy } });
  }
})();
