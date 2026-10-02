# TunnelManager

**TunnelManager** is a modern, lightweight, and user-friendly GUI application for exposing local servers to the internet instantly. Powered by **LocalTunnel** and **Cloudflare Quick Tunnels**, it allows you to easily create, configure, and monitor multiple tunnels simultaneously.

---

## ✨ Key Features

- 🌐 **Dual Tunnel Providers**:
  - **LocalTunnel (LT)** — custom persistent subdomains (`https://my-app.loca.lt`).
  - **Cloudflare Quick Tunnels (CF)** — ultra-fast, stable connections via Cloudflare Edge (`*.trycloudflare.com`).
- 📱 **QR Code Generator**: One-click QR code display to test web applications and APIs on mobile devices instantly.
- 🚀 **Quick Open & Copy**: 1-click button to open public URLs in your default browser or copy links to clipboard.
- 📊 **Real-Time Traffic & Request Inspector**: Live HTTP request counter and last-called path tracking (`GET /api/v1/...`).
- ⏱ **Uptime & Health Monitoring**: Tracks tunnel uptime and performs non-blocking parallel checks for local port availability.
- 💻 **Custom Local Hosts & HTTPS**: Support for custom local host targets (e.g. `docker.local`, `192.168.1.50`, `localhost`) and local HTTPS services with self-signed SSL certificates.
- 🔍 **Search, Filter & Sorting**:
  - Instant search across tunnel names, ports, subdomains, and hosts.
  - Filter by status (*Active*, *Port Closed*, *Inactive*) and provider (*LocalTunnel*, *Cloudflare*).
  - Multi-criteria sorting (Newest, Name A-Z, Port number, Active first).
- ⚡ **Batch Operations**: Bulk selection, bulk start, bulk stop, and bulk deletion of tunnels.
- 📋 **Built-in Live Log Viewer**: Real-time log inspector with search, log level filtering (*INFO*, *WARN*, *ERROR*), and one-click log copying.
- 💾 **Backup & Restore**: Export and import tunnel configurations via JSON files.
- ⚙️ **Customizable Settings**:
  - Configure autostart on Windows boot (with optional start minimized to tray).
  - Minimize-to-tray on close.
  - Default tunnel provider selection.
  - Native system notifications.
- 🌓 **Theme Support**: Seamless Dark and Light theme modes.

---

## 🛠 Tech Stack

* **Frontend**: Vanilla HTML5 / Modern CSS (Design Tokens & CSS Variables) / Vanilla JavaScript.
* **Backend**: Node.js + [Electron](https://www.electronjs.org/) (v43+).
* **Security & Architecture**: Context-isolated IPC bridge (`contextBridge` / `preload.cjs`) with XSS sanitization.
* **Storage**: `electron-store`.
* **Network & Tunnels**:
  - Embedded `cloudflared` Quick Tunnel integration with clean child process lifecycle management.
  - Robust `localtunnel` client with automatic reconnection, jitter backoff, and keep-alive socket clusters.

---

## 🚀 Installation & Getting Started

### Windows Installer (Recommended)
Download the latest `Tunnel Manager Setup x.x.x.exe` from the [Releases](https://github.com/Liidioteee/TunnelManager/releases) page and run the installer.

### Building from Source

1. **Prerequisites**: Ensure you have [Node.js](https://nodejs.org/) (version 18 or higher) and `npm` installed.
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
5. **Compile Windows Installer / Portable App**:
   ```bash
   npm run build
   ```
   *The compiled installer will be located in the `dist/` directory.*

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

## 🧪 Development & Tests

Development requires Node.js 22 or newer.

```bash
npm run lint       # ESLint
npm test           # unit tests (node:test), a few seconds, no network needed
npm run test:e2e   # end-to-end tests: launch the real app and drive its UI
```

- `npm install` enables a git pre-commit hook that runs `lint` and `test`; a commit is rejected if either fails.
- End-to-end tests start Electron with a temporary data folder and use fake LocalTunnel/Cloudflare servers, so they need no network and never touch your real tunnels. On Linux without a display, run them under Xvfb: `xvfb-run -a npm run test:e2e`.
- CI (GitHub Actions) runs lint, unit tests and `npm audit` on Ubuntu and Windows, and the end-to-end tests on Ubuntu.
- `TUNNEL_MANAGER_LT_SERVER=https://your-server` points LocalTunnel tunnels to a self-hosted localtunnel server instead of `https://loca.lt`.

---

## 📄 License

Distributed under the MIT License. See the [LICENSE](LICENSE) file for details.