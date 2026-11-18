// Gera public/src/view/platformIcons.js a partir do pacote simple-icons (CC0). Rode: node tools/gen-icons.mjs
import * as si from 'simple-icons';
import fs from 'node:fs';
const want = { instagram: 'siInstagram', tiktok: 'siTiktok', youtube: 'siYoutube', facebook: 'siFacebook', x: 'siX', threads: 'siThreads',
  kwai: 'siKuaishou', pinterest: 'siPinterest', twitch: 'siTwitch', snapchat: 'siSnapchat', telegram: 'siTelegram', whatsapp: 'siWhatsapp', vimeo: 'siVimeo', bluesky: 'siBluesky' };
const out = {};
for (const [id, key] of Object.entries(want)) if (si[key]) out[id] = { hex: si[key].hex, path: si[key].path };
fs.writeFileSync('public/src/view/platformIcons.js',
  `// GERADO por tools/gen-icons.mjs (simple-icons, CC0). Logos são marcas de seus donos.\nexport const ICONS = ${JSON.stringify(out)};\n`);
console.log(Object.keys(out).join(' '));
