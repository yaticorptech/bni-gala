# 🏆 BNI Game Arena

Multi-chapter games platform for BNI events: members pick their **chapter** from a
dropdown (the organiser sets the list in `/admin`; registration waits until it's filled in), register with
**name + mobile number** (the number is their login — no passwords, no OTP), then play
**solo games** for the individual leaderboard and **team games** for the team leaderboard.
Anyone can **create a team** and share its 5-letter code; friends join with the code.
A live **big screen** shows it all, and an **admin panel** runs the night.

Built like `~/bni-games` (plain Node + Socket.IO, no build step), but a different model:
open registration by phone, chapters first-class, and player-made teams instead of
admin-dealt ones.

## Pages

| Page | Who | What |
| --- | --- | --- |
| `/` | players (phones) | login/register, game hub, team hub |
| `/screen` | projector | live board, team leaderboard, chapter standings, feed, overlays |
| `/admin` | organiser | settings, chapters, teams, Tap Battle, Live Quiz, lucky draw, reveal, CSV |

## Run it

```bash
cd backend
npm install        # first time only
npm start          # http://localhost:8150 — serves the frontend too
```

Players on the same Wi-Fi open the **Network** URL the server prints (QR code in `/admin`).
Admin password is `bni-admin` until you set `ADMIN_PASSWORD` in `backend/.env`
(copy `backend/.env.example`).

Optional separate frontend dev server (proxies the API):

```bash
cd frontend && npm run dev    # http://localhost:5160
```

Rehearsal bots (register, form teams, play everything — they also join any Tap Battle
round or Live Quiz you start):

```bash
cd backend && npm run simulate -- --players 20
# afterwards: /admin → "Remove everyone too" (the bots are fake players)
```

## How scoring works

- **Welcome spin**: every player gets one free **Spin & Win** 🎡 right after registering
  (or on first login) — the wheel pays 50–300 points onto their solo score. The prize is
  picked server-side; a score reset gives everyone their spin back.
- **Solo**: every finished try adds to the player's total (default 3 tries per game,
  settable in `/admin`). All scoring is server-side in `backend/server/games.js`.
- **Team games** (default: Tap Frenzy, Referral Rush, Colour Clash, Odd One Out —
  settable): played "for the team" from the hub's team section, with a separate pool of
  tries (default 2 per member per game). Every team try adds to the **team's** total —
  full-squad participation wins. Team scores never mix with solo scores.
- **Teams**: created by players (max size settable, default 5). Captain = creator; if the
  captain leaves, the longest-standing member takes over; an empty team dissolves. The
  join code is only visible to members and the admin.
- **Chapter standings**: solo totals summed per chapter, on the big screen.
- **Power Connections** 🔗 — the networking game: every member has a personal QR (and a
  short code) in the app. Meet someone, scan their QR — with the in-app scanner, or any
  phone camera app (the QR is a link that opens the game and connects by itself) — or type
  their code, and you **both** get 50 points. Each pair counts once; up to 1,000 points
  (20 real connections). Pairings are validated server-side and show on the big-screen feed.
  Once connected, either member can **save the other's number to their phone**: they type
  the name (prefilled) and it's saved as **"BNI \<chapter\> \<name\>"** — a vCard with the
  number, business, and the real name + chapter in the notes. The number is only ever
  shared with members you've actually connected with.
- **Hosted moments** (from `/admin`): **Team Tap Battle** rounds (taps are their own
  score, shown as the battle overlay), **Live Quiz** (counts on the individual board),
  **lucky draw**, and the **grand reveal** of the top solo players.

## Deploys

Pushing to `main` deploys automatically: **Railway** rebuilds the backend (repo root's
npm workspace delegates to `backend/`; live at bni-gala-production.up.railway.app) and
**Vercel** republishes the frontend (project root `frontend/`; live at bni-gala.vercel.app).

## Storage & hosting

State lives in memory and persists to `backend/data/db.json`. Set `MONGODB_URI` (e.g.
Atlas) for a durable copy — required on hosts that wipe the disk per deploy (Railway).
To split hosting (frontend on Vercel, backend elsewhere): deploy `backend/`, set
`PUBLIC_URL` to the frontend URL, and point `frontend/js/config.js` `API_URL` at the
backend.

## Layout

```
backend/
  server/index.js     express + socket.io bootstrap, serves frontend/
  server/state.js     all game/team/player state + rules (single source of truth)
  server/games.js     the games' server-side scoring
  server/routes.js    REST API (public, player, team, admin)
  server/realtime.js  socket rooms: players / screen / admin
  server/store/       JSON file or MongoDB persistence
  scripts/simulate.js rehearsal bots
frontend/
  index.html + js/app.js       player app (login, hub, games, team hub, tap battle, quiz)
  screen.html + js/screen.js   big screen
  admin.html + js/admin.js     admin panel
  js/games/*.js                the 8 solo game modules (shared with bni-games)
```
