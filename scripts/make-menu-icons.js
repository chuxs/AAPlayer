'use strict';
// Renders the menu icons to src/main/menu-icons/{dark,light}/<name>.png (16px) and <name>@2x.png (32px).
// Run: npm run menu-icons
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ACCENT = '#ff7a3d';
const RED = '#ff4d4d';
const BLUE = '#4da3ff';
// 24x24 viewBox; "C" = theme color, "A" = accent, "R" = red, "B" = blue.
const S = (d, c = 'C', w = 2) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const F = (d, c = 'C') => `<path d="${d}" fill="${c}"/>`;
const ICONS = {
  'open-file': S('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5') + F('M10 11.5v6l5-3Z', 'A'),
  'open-multi': S('M9 3h7l4 4v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM4 7v12a2 2 0 0 0 2 2h9') + F('M11 9.5v5l4-2.5Z', 'A'),
  'open-folder': S('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'),
  'open-network': S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z'),
  'disc': S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z') + S('M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z', 'A') + S('M6.5 12a5.5 5.5 0 0 1 5.5-5.5', 'C', 1.4),
  'capture': S('M4 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM16 10.5l5-3v9l-5-3') + `<circle cx="7" cy="10.5" r="1.6" fill="${RED}"/>`,
  'clipboard': S('M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2') + F('M10 11v6l5-3Z', 'A'),
  'convert': S('M4 8h13l-3-3M20 16H7l3 3') + S('M17 8l-3 3M7 16l3-3', 'A'),
  'recent': S('M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6L3 9M3 4v5h5'),
  'save': S('M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Zm3 0v5h7V4M8 20v-6h8v6'),
  'quit': S('M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9'),
  'play': F('M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z', 'A'),
  'pause': F('M6.5 5h4v14h-4zM13.5 5h4v14h-4z', 'A'),
  'stop': F('M6.5 6.5h11v11h-11z'),
  'prev': F('M18 6.5v11L9.5 12ZM6 6h2v12H6z'),
  'next': F('M6 6.5v11l8.5-5.5ZM16 6h2v12h-2z'),
  'record': `<circle cx="12" cy="12" r="6.5" fill="${RED}"/>`,
  'speed': S('M4 18a8 8 0 1 1 16 0M12 18l4-6'),
  'forward': S('M4 7v10l7-5ZM13 7v10l7-5Z'),
  'backward': S('M20 7v10l-7-5ZM11 7v10l-7-5Z'),
  'goto': S('M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z'),
  'frame': F('M5 6v12l8-6Z') + S('M17 6v12', 'C', 2.4),
  'chapter': S('M6 4h9l3 3v13H6zM9 9h6M9 13h6M9 17h3'),
  'renderer': S('M3 7V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-6M3 11a9 9 0 0 1 9 9M3 15a5 5 0 0 1 5 5') + F('M3 19h1.5v1.5H3z'),
  'loop': S('M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1'),
  'ab': S('M3 18 6.5 7h1L11 18M4.2 14.5h5.6M14 7h3.5a2.5 2.5 0 0 1 0 5H14Zm0 5h4a3 3 0 0 1 0 6h-4Z'),
  'random': S('M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5'),
  'audio-track': S('M9 18V6l11-2v12') + F('M6.5 15.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM17.5 13.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z'),
  'audio-device': S('M7 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z') + F('M12 6.2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'),
  'stereo': S('M3 9v6h3l4 3V6L6 9ZM21 9v6h-3l-4 3V6l4 3Z'),
  'visualization': S('M4 20V12M8 20V6M12 20v-9M16 20V8M20 20v-5', 'A', 2.2),
  'volume-up': F('M4 9.5v5h3.5L12 19V5L7.5 9.5Z') + S('M15 12h6M18 9v6'),
  'volume-down': F('M4 9.5v5h3.5L12 19V5L7.5 9.5Z') + S('M15 12h6'),
  'mute': F('M4 9.5v5h3.5L12 19V5L7.5 9.5Z') + S('m16 9.5 5 5m0-5-5 5', 'R'),
  'video-track': S('M4 6h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM17 10l4-2.5v9L17 14'),
  'fullscreen': S('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'),
  'fit-window': S('M4 5h16v14H4zM8 9h8v6H8z'),
  'wallpaper': S('M4 5h16v12H4zM9 21h6M12 17v4') + S('m6 15 4-4 3 3 2-2 3 3', 'A'),
  'zoom': S('M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM20 20l-4.8-4.8M8 10.5h5M10.5 8v5'),
  'aspect': S('M3 6h18v12H3zM7 10V9h2M17 14v1h-2'),
  'crop': S('M6 2v16h16M2 6h16v16'),
  'deinterlace': S('M4 6h16M4 10h16M4 14h16M4 18h16', 'C', 1.6),
  'snapshot': S('M4 8h3l2-2.5h6L17 8h3v11H4ZM12 9.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z'),
  'decode': S('M5 4h14v16H5zM9 9h6M9 12h6M9 15h3'),
  'subtitle-add': S('M3 5h18v14H3zM7 14h4M14 14h3M7 10h10'),
  'subtitle-track': S('M3 5h18v14H3z') + S('M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6', 'C', 1.6),
  'effects': S('M6 4v16M12 4v16M18 4v16', 'C', 1.6) + F('M3.5 13h5v3h-5zM9.5 7h5v3h-5zM15.5 15h5v3h-5z', 'A'),
  'sync': S('M20 12a8 8 0 0 1-14 5.3M4 12A8 8 0 0 1 18 6.7M18 3v4h-4M6 21v-4h4'),
  'info': `<circle cx="12" cy="12" r="9" fill="${ACCENT}"/><path d="M12 11v6M12 7.5v.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
  'codec': `<circle cx="12" cy="12" r="9" fill="${ACCENT}"/><path d="M9.5 9 7 12l2.5 3M14.5 9l2.5 3-2.5 3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  'messages': S('M3 5h18v14H3zM7 10l3 2-3 2M12 15h5'),
  'vlm': S('M12 12a2 2 0 1 0 0 .01M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14', 'A'),
  'privacy': S('M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z') + S('m9 12 2 2 4-4', 'A'),
  'clear': S('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'),
  'preferences': S('M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z'),
  'customize': S('M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1') + F('M13 4h4v4h-4zM7 10h4v4H7zM15 16h4v4h-4z', 'A'),
  'plugins': S('M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0ZM12 16v5'),
  'remote': S('M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM12 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM10 15h.01M14 15h.01M10 18h.01M14 18h.01'),
  'vlsub': S('M3 5h18v10H3zM7 10h4M14 10h3') + S('M12 15v6M9 18l3 3 3-3', 'B'),
  'playlist': S('M4 6h12M4 12h12M4 18h8') + F('M18 15v6l4-3Z', 'A'),
  'dock': S('M3 5h18v14H3zM15 5v14'),
  'ontop': S('M4 9h10v11H4zM10 4h10v11') + S('M10 4h10v11h-6', 'A'),
  'minimal': S('M3 5h18v14H3zM3 15h18'),
  'advanced': S('M3 7h18M3 12h18M3 17h18') + F('M6 5.5h3v3H6zM14 10.5h3v3h-3zM9 15.5h3v3H9z', 'A'),
  'statusbar': S('M3 5h18v14H3zM3 16h18') + F('M5 17h5v1H5z', 'A'),
  'devtools': S('M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14'),
  'help': `<circle cx="12" cy="12" r="9" fill="${ACCENT}"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.5M12 17v.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
  'keyboard': S('M3 7h18v10H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10'),
  'update': S('M12 3v12M8 11l4 4 4-4M4 17v3h16v-3', 'A'),
  'about': `<circle cx="12" cy="12" r="9" fill="${ACCENT}"/><path d="M12 11v6M12 7.5v.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
};

const THEMES = { dark: '#d6d6de', light: '#3c3c46' };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const outRoot = path.join(__dirname, '..', 'src', 'main', 'menu-icons');
  for (const [theme, color] of Object.entries(THEMES)) {
    const dir = path.join(outRoot, theme);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(ICONS)) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body
        .replace(/"C"/g, `"${color}"`).replace(/"A"/g, `"${ACCENT}"`).replace(/"R"/g, `"${RED}"`).replace(/"B"/g, `"${BLUE}"`)}</svg>`;
      for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
        const dataUrl = await win.webContents.executeJavaScript(`new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size};
            c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size}); res(c.toDataURL('image/png')); };
          img.onerror = () => rej(new Error('bad svg ${name}'));
          img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
        })`);
        fs.writeFileSync(path.join(dir, `${name}${suffix}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
      }
    }
  }
  console.log(`wrote ${Object.keys(ICONS).length} icons x 2 themes to ${outRoot}`);
  app.quit();
});
