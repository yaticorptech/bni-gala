// Address of the backend (API + live updates), with no trailing slash.
// Local/laptop mode — the backend's `npm start` serving these files on the venue Wi-Fi,
// or the dev server proxying /api — talks to the same origin (''). Hosted anywhere else
// (e.g. the Vercel frontend), it talks to the deployed backend below.
const BACKEND = 'https://bni-gala-production.up.railway.app';
const local =
  typeof location !== 'undefined' &&
  (/^(localhost$|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) || location.hostname.endsWith('.local'));
export const API_URL = local ? '' : BACKEND;
