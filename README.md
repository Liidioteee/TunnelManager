# TunnelManager

**TunnelManager** is a modern, lightweight, and user-friendly GUI application for exposing local servers to the internet instantly. Powered by **LocalTunnel** and **Cloudflare Quick Tunnels**, it allows you to easily create, configure, and monitor multiple tunnels simultaneously.

The interface is in Russian. See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

---

## ✨ Key Features

- 🌐 **Dual Tunnel Providers**:
  - **LocalTunnel (LT)** — custom persistent subdomains (`https://my-app.loca.lt`).
  - **Cloudflare Quick Tunnels (CF)** — ultra-fast, stable connections via Cloudflare Edge (`*.trycloudflare.com`).
- 📱 **QR Code Generator**: One-click QR code display to test web applications and APIs on mobile devices instantly.
- 🚀 **Quick Open & Copy**: 1-click button to open public URLs in your default browser or copy links to clipboard.
- 📊 **Request Counter**: Live HTTP request counter on every active tunnel. LocalTunnel also shows the last request (`GET /api/v1/...`, without the query string); for Cloudflare the count comes from `cloudflared`'s own metrics.
- ⏱ **Uptime & Health Monitoring**: Tracks tunnel uptime and checks local port availability (IPv4 and IPv6 for `localhost`), with clear warnings when the local app is down.
- 🔁 **Self-Healing Tunnels**:
  - Enabled tunnels are restored when the app starts again.
  - A tunnel whose process exits unexpectedly is restarted automatically with a growing pause (2–60 s) and a notification.
  - Connection retries are shown as warnings while the tunnel keeps trying; a definite failure (e.g. the server rejects the subdomain) is shown on the card with its reason.
- 💻 **Custom Local Hosts & HTTPS**: Custom local host targets (e.g. `docker.local`, `192.168.1.50`, `localhost`, `::1`) and local HTTPS services. Certificate verification is skipped by default only for loopback hosts (self-signed dev certificates); for hosts on your network it stays on unless you turn it off.
- 🔍 **Search, Filter & Sorting**:
  - Instant search across tunnel names, ports, subdomains, and hosts.
  - Filter by status (*Active*, *With problems*, *Inactive*) and provider (*LocalTunnel*, *Cloudflare*).
  - Multi-criteria sorting (Newest, Name A-Z, Port number, Active first).
- ⚡ **Batch Operations**: Bulk selection, bulk start, bulk stop, and bulk deletion of tunnels.
- 📋 **Built-in Live Log Viewer**: Real-time log inspector with search, log level filtering (*INFO*, *WARN*, *ERROR*), and one-click log copying.
- 💾 **Backup & Restore**: Export and import tunnel configurations via JSON files.
- ⚙️ **Customizable Settings**:
  - Launch at login (with optional start minimized to tray).
  - Minimize-to-tray on close.
  - Default tunnel provider selection.
  - Native system notifications.
- 🌓 **Theme Support**: Dark and Light themes; follows the system theme until you pick one.

---

## 🛠 Tech Stack

* **Frontend**: Vanilla HTML5 / Modern CSS (Design Tokens & CSS Variables) / Vanilla JavaScript.
* **Backend**: Node.js + [Electron](https://www.electronjs.org/) (v43+).
* **Security & Architecture**: Sandboxed, context-isolated renderer with a strict Content-Security-Policy; a narrow IPC bridge (`contextBridge` / `preload.cjs`) that accepts requests only from the app's own page; all input from the window, imported files and tunnel servers is validated; HTML output is escaped.
* **Storage**: `electron-store`.
* **Network & Tunnels**:
  - `cloudflared` is downloaded on first use from the official GitHub release, verified against the release's SHA-256, re-verified before the first Cloudflare tunnel of each session and updated weekly. It runs under a small supervisor that stops it when the app exits or crashes, so a tunnel never outlives the app.
  - Built-in `localtunnel` client with reconnection, backoff, keep-alive connection pools and correct `Host` rewriting for custom local hosts.

---

## 🚀 Installation & Getting Started

### Windows Installer (Recommended)
Download the latest `Tunnel Manager Setup x.x.x.exe` from the [Releases](https://github.com/Liidioteee/TunnelManager/releases) page and run the installer.

### Building from Source

1. **Prerequisites**: Ensure you have [Node.js](https://nodejs.org/) (version 22 or higher) and `npm` installed.
2. **Clone the repository**:
   ```bash
   git clone https://github.com/Liidioteee/TunnelManager.git
   cd TunnelManager
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Run in development mode**:
   ```bash
   npm start
   ```
5. **Build an installer** (NSIS on Windows, DMG on macOS):
   ```bash
   npm run build
   ```
   *The result is placed in the `dist/` directory.*

---

## 💡 How to Use

1. **Add a Tunnel**:
   - Click the **"+"** button in the header.
   - Enter your project name (e.g. `My Backend API`) and local port (e.g. `3000` or `8080`).
   - Select your preferred provider (**LocalTunnel** or **Cloudflare**).
   - *(Optional)* Expand **Advanced Network Parameters** to specify a custom host (like `192.168.1.100`) or select `HTTPS`.
   - Click **"Create Tunnel"**.
2. **Start / Stop**:
   - Toggle the switch on any card to start or stop the tunnel.
   - When active, the generated public URL will appear with buttons to **Open in Browser**, **Copy Link**, and **Show QR Code**.
3. **Inspect Logs & Traffic**:
   - View the real-time request counter badge on active cards.
   - Click the **Logs** button in the header to view live console logs.
4. **Backup Configurations**:
   - Click the **Backup** button to export all tunnels into a JSON file or import previously saved configurations.

---

## ⚙️ Configuration & Data

- Tunnels and settings are stored with `electron-store` in the app's user data folder. The same folder contains the `logs/` directory (up to 5 files of 5 MB each; open it with **Открыть папку** in the log viewer) and the downloaded `cloudflared` binary with its checksum file.
- `TUNNEL_MANAGER_LT_SERVER=https://your-server` points LocalTunnel tunnels to a self-hosted [localtunnel server](https://github.com/localtunnel/server) instead of `https://loca.lt`.

---

## 🧪 Development & Tests

Development requires Node.js 22 or newer.

```bash
npm run lint       # ESLint
npm test           # unit tests (node:test), a few seconds, no network needed
npm run test:e2e   # end-to-end tests: launch the real app and drive its UI
```

- `npm install` enables a git pre-commit hook that runs `lint` and `test`; a commit is rejected if either fails.
- End-to-end tests start Electron with a temporary data folder and use fake LocalTunnel/Cloudflare servers, so they need no network and never touch your real tunnels. On Linux without a display, run them under Xvfb: `xvfb-run -a npm run test:e2e`. Cloudflare scenarios use a shell-script stand-in for `cloudflared` and are skipped on Windows.
- `E2E_APP_EXECUTABLE=<path to the built app>` runs the same end-to-end tests against a packaged build (code inside `app.asar`), e.g. `dist/linux-unpacked/tunnel-manager` after `npx electron-builder --linux dir`.
- CI (GitHub Actions) runs lint, unit tests and `npm audit` on Ubuntu and Windows, and the end-to-end tests on Ubuntu and Windows.

---

## 📄 License

Distributed under the MIT License. See the [LICENSE](LICENSE) file for details.