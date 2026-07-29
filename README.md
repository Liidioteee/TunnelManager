# TunnelManager

**TunnelManager** is a user-friendly GUI application for instant local port forwarding to the internet. Powered by LocalTunnel and Cloudflare Quick Tunnels, it allows you to manage an unlimited number of tunnels simultaneously.

## ✨ Key Features

- Support for **LocalTunnel** to reserve custom subdomains, and **Cloudflare Quick Tunnels** for highly stable connections.
- Automatic pinging of forwarded ports to monitor server status.
- Uptime tracking for each individual tunnel.
- Autostart with the operating system and minimize-to-tray on close.

## 🛠 Tech Stack

* **Frontend**: Vanilla HTML / CSS (Custom Variables) / JS.
* **Backend**: Node.js + [Electron](https://www.electronjs.org/).
* **Communication**: Fully isolated IPC bridge (`contextBridge` / `preload.cjs`).
* **Data Storage**: `electron-store`.
* **Tunnels**:
  * Integration with the native `cloudflared` library (forcing the HTTP/2 protocol).
  * Custom implementation on top of the `localtunnel` API.

## 🚀 Installation

### OS Compatibility
Currently optimized and compiled for **Windows x64**.

### Option A: Direct Download (Recommended)
Download the latest pre-compiled `.exe` file from the [Releases](https://github.com/Liidioteee/TunnelManager/releases) tab on GitHub and run it.

### Option B: Manual Build (From Source)

1. Ensure you have [Node.js](https://nodejs.org/) (version 18 or higher) and `npm` installed.
2. Clone the repository:
   ```bash
   git clone https://github.com/Liidioteee/TunnelManager.git
   cd TunnelManager
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run locally (in development mode):
   ```bash
   npm start
   ```
5. Build the executable:
   ```bash
   npm run build
   ```

## 💡 Usage

1. Click the **"+"** button in the top right corner.
2. Enter a name for the tunnel and your local port (e.g., `3000`).
3. Select a provider:
   - **LocalTunnel** — if you need a persistent short URL (you can specify your own subdomain).
   - **Cloudflare** — if maximum speed and stability are required (generates a random `*.trycloudflare.com` link).
4. Click **"Create Tunnel"**.
5. Enable the created tunnel using the toggle switch.

## 📄 License

Distributed under the MIT License. See the [LICENSE](LICENSE) file for details.