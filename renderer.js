// DOM Elements
const addBtn = document.getElementById('add-btn');
const addForm = document.getElementById('add-form');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const formCloseX = document.getElementById('form-close-x');
const tunnelsList = document.getElementById('tunnels-list');
const logsBtn = document.getElementById('logs-btn');
const themeBtn = document.getElementById('theme-btn');
const settingsBtn = document.getElementById('settings-btn');
const importExportBtn = document.getElementById('import-export-btn');
const providerSelect = document.getElementById('provider-select');
const subdomainGroup = document.getElementById('subdomain-group');
const portInput = document.getElementById('port-input');
const nameInput = document.getElementById('name-input');
const subdomainInput = document.getElementById('subdomain-input');
const hostInput = document.getElementById('host-input');
const protocolSelect = document.getElementById('protocol-select');
const skipTlsVerifyCheckbox = document.getElementById('skip-tls-verify-checkbox');
const toggleAdvancedBtn = document.getElementById('toggle-advanced-btn');
const advancedSection = document.getElementById('advanced-settings-section');
const advancedArrow = document.getElementById('advanced-arrow');

// Stats strip
const statActiveEl = document.getElementById('stat-active');
const statTotalEl = document.getElementById('stat-total');
const statIssuesEl = document.getElementById('stat-issues');
const statIssuesPill = document.getElementById('stat-issues-pill');

// Filters & Search & Sort
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
const filterStatus = document.getElementById('filter-status');
const filterProvider = document.getElementById('filter-provider');
const sortSelect = document.getElementById('sort-select');
const resetFiltersBtn = document.getElementById('reset-filters');

// Batch Bar
const batchBar = document.getElementById('batch-bar');
const selectedCountText = document.getElementById('selected-count');
const batchSelectAllBtn = document.getElementById('batch-select-all');
const batchCancelBtn = document.getElementById('batch-cancel-btn');
const batchStartBtn = document.getElementById('batch-start-btn');
const batchStopBtn = document.getElementById('batch-stop-btn');
const batchDeleteBtn = document.getElementById('batch-delete-btn');

// Modals
const qrModal = document.getElementById('qr-modal');
const qrModalTitle = document.getElementById('qr-modal-title');
const qrCodeContainer = document.getElementById('qr-code-container');
const qrModalUrl = document.getElementById('qr-modal-url');
const qrCopyBtn = document.getElementById('qr-copy-btn');

const logsModal = document.getElementById('logs-modal');
const logsConsole = document.getElementById('logs-console');
const logsSearchInput = document.getElementById('logs-search-input');
const logsLevelFilter = document.getElementById('logs-level-filter');
const logsClearBtn = document.getElementById('logs-clear-btn');
const logsOpenFolderBtn = document.getElementById('logs-open-folder-btn');
const logsCopyBtn = document.getElementById('logs-copy-btn');
const logsStatusCount = document.getElementById('logs-status-count');

const settingsModal = document.getElementById('settings-modal');
const settingAutoLaunch = document.getElementById('setting-autolaunch');
const settingStartMinimized = document.getElementById('setting-startminimized');
const settingCloseToTray = document.getElementById('setting-closetotray');
const settingNotifications = document.getElementById('setting-notifications');
const settingDefaultProvider = document.getElementById('setting-defaultprovider');
const settingsSaveBtn = document.getElementById('settings-save-btn');

const backupModal = document.getElementById('backup-modal');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');

const confirmModal = document.getElementById('confirm-modal');
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const confirmOkBtn = document.getElementById('confirm-ok-btn');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');

const toastContainer = document.getElementById('toast-container');

// State
let currentConfigs = [];
let editingId = null;
const latestStatuses = {};
const latestUptimes = {};
const latestRequestStats = {};
const selectedIds = new Set();
let confirmResolver = null;
let rawLogsCache = [];

// --- XSS ESCAPING ---
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- TOAST NOTIFICATIONS ---
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- CUSTOM CONFIRM DIALOG ---
function customConfirm(message, title = 'Подтверждение', btnText = 'Удалить') {
  return new Promise((resolve) => {
    confirmModalTitle.innerText = title;
    confirmModalMessage.innerText = message;
    confirmOkBtn.innerText = btnText;
    confirmModal.classList.remove('hidden');
    confirmResolver = resolve;
  });
}

confirmOkBtn.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
  if (confirmResolver) confirmResolver(true);
  confirmResolver = null;
});

confirmCancelBtn.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
  if (confirmResolver) confirmResolver(false);
  confirmResolver = null;
});

// --- UNIVERSAL MODAL CLOSING (button / backdrop click / Esc) ---
// CSP запрещает инлайновые onclick, поэтому закрытие модалок централизовано здесь
const allModals = [qrModal, logsModal, settingsModal, backupModal, confirmModal];

function closeModal(modal) {
  if (modal.classList.contains('hidden')) return;
  if (modal === confirmModal) {
    confirmModal.classList.add('hidden');
    if (confirmResolver) confirmResolver(false);
    confirmResolver = null;
    return;
  }
  modal.classList.add('hidden');
}

document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const modal = document.getElementById(btn.getAttribute('data-close-modal'));
    if (modal) closeModal(modal);
  });
});

allModals.forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    allModals.forEach((modal) => closeModal(modal));
  }
});

// --- REQUEST STATS ---
// Для LocalTunnel известен последний запрос; Cloudflare сообщает только число
function requestStatsTitle(stats) {
  return stats.lastPath
    ? `Последний запрос: ${stats.lastMethod} ${stats.lastPath}`
    : `Запросов через туннель: ${stats.count}`;
}

// --- TIME FORMATTING ---
function formatUptime(secs) {
  const h = Math.floor(secs / 3600).toString().padStart(2, '0');
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// --- THEME SWITCHER ---
const savedTheme = localStorage.getItem('theme') || 'light';
if (savedTheme === 'dark') {
  document.body.classList.add('dark-theme');
  document.getElementById('theme-icon-sun').classList.remove('hidden');
  document.getElementById('theme-icon-moon').classList.add('hidden');
}

themeBtn.addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark-theme');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  if (isDark) {
    document.getElementById('theme-icon-sun').classList.remove('hidden');
    document.getElementById('theme-icon-moon').classList.add('hidden');
  } else {
    document.getElementById('theme-icon-sun').classList.add('hidden');
    document.getElementById('theme-icon-moon').classList.remove('hidden');
  }
});

// --- ADVANCED FORM TOGGLE ---
toggleAdvancedBtn.addEventListener('click', () => {
  const isHidden = advancedSection.classList.toggle('hidden');
  advancedArrow.innerText = isHidden ? '▶' : '▼';
});

// --- PROVIDER SELECTION ---
providerSelect.addEventListener('change', () => {
  if (providerSelect.value === 'cf') {
    subdomainGroup.classList.add('hidden');
    subdomainInput.value = '';
  } else {
    subdomainGroup.classList.remove('hidden');
  }
});

// --- PORT INPUT VALIDATION ---
portInput.addEventListener('keydown', (e) => {
  if (['e', 'E', '+', '-', '.', ','].includes(e.key)) {
    e.preventDefault();
  }
});

portInput.addEventListener('input', () => {
  let raw = portInput.value.trim().replace(/^[-+]+/, '');
  let match = raw.match(/^\d+/);
  let cleaned = match ? match[0] : '';

  if (cleaned.length > 0) {
    let value = parseInt(cleaned, 10);
    if (value > 65535) {
      portInput.value = 65535;
    } else if (value === 0) {
      portInput.value = '';
    } else {
      portInput.value = value;
    }
  } else {
    portInput.value = '';
  }
});

portInput.addEventListener('blur', () => {
  let value = parseInt(portInput.value, 10);
  if (isNaN(value) || value < 1 || value > 65535) {
    portInput.value = '';
  } else {
    portInput.value = value;
  }
});

// --- SUBDOMAIN INPUT SANITIZATION ---
subdomainInput.addEventListener('input', () => {
  subdomainInput.value = subdomainInput.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
});

// --- ADD FORM SHOW / HIDE ---
addBtn.addEventListener('click', async () => {
  editingId = null;
  document.getElementById('form-title').innerText = 'Новый туннель';
  saveBtn.innerText = 'Создать туннель';

  nameInput.value = '';
  portInput.value = '';
  subdomainInput.value = '';
  hostInput.value = 'localhost';
  protocolSelect.value = 'http';
  skipTlsVerifyCheckbox.checked = true;

  const settings = await window.api.getSettings();
  providerSelect.value = (settings && settings.defaultProvider) || 'lt';
  if (providerSelect.value === 'cf') {
    subdomainGroup.classList.add('hidden');
  } else {
    subdomainGroup.classList.remove('hidden');
  }

  advancedSection.classList.add('hidden');
  advancedArrow.innerText = '▶';
  addForm.classList.remove('hidden');
  nameInput.focus();
});

cancelBtn.addEventListener('click', () => addForm.classList.add('hidden'));
formCloseX.addEventListener('click', () => addForm.classList.add('hidden'));

// --- SAVE CONFIGURATION ---
saveBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  const port = portInput.value.trim();
  const subdomain = subdomainInput.value.trim();
  const provider = providerSelect.value;
  const localHost = hostInput.value.trim() || 'localhost';
  const localProtocol = protocolSelect.value || 'http';

  const portVal = parseInt(port, 10);
  if (!port || isNaN(portVal) || portVal < 1 || portVal > 65535) {
    showToast('Пожалуйста, укажите корректный порт (1 - 65535)', 'error');
    portInput.focus();
    return;
  }

  const sanitizedPort = portVal.toString();
  const skipTlsVerify = skipTlsVerifyCheckbox.checked;

  let configs;
  try {
    if (editingId) {
      configs = await window.api.updateConfig({
        id: editingId,
        name,
        port: sanitizedPort,
        subdomain,
        provider,
        localHost,
        localProtocol,
        skipTlsVerify
      });
      showToast('Конфигурация обновлена', 'success');
    } else {
      configs = await window.api.addConfig({
        name,
        port: sanitizedPort,
        subdomain,
        provider,
        localHost,
        localProtocol,
        skipTlsVerify
      });
      showToast('Туннель успешно создан', 'success');
    }
  } catch (err) {
    showToast(err.message || 'Некорректные параметры конфигурации', 'error');
    return;
  }

  renderTunnels(configs);
  addForm.classList.add('hidden');
  editingId = null;
});

// --- LOAD TUNNELS ---
async function loadTunnels() {
  try {
    const configs = await window.api.getConfigs();
    renderTunnels(configs);
  } catch (err) {
    console.error('Ошибка загрузки конфигураций:', err);
  }
}

// --- SEARCH, FILTER & SORT ---
function getFilteredAndSortedConfigs() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const statusFilter = filterStatus.value;
  const providerFilter = filterProvider.value;
  const sortMode = sortSelect.value;

  let filtered = currentConfigs.filter(config => {
    const configProvider = config.provider || 'lt';
    if (providerFilter !== 'all' && configProvider !== providerFilter) {
      return false;
    }

    const status = latestStatuses[config.id] || config.status || { type: 'info', message: 'Не активен' };
    if (statusFilter !== 'all') {
      if (statusFilter === 'active' && (!config.active || status.type !== 'success')) {
        return false;
      }
      if (statusFilter === 'warning' && status.type !== 'warning') {
        return false;
      }
      if (statusFilter === 'inactive' && config.active) {
        return false;
      }
    }

    if (searchTerm) {
      const matchName = (config.name || '').toLowerCase().includes(searchTerm);
      const matchPort = (config.port || '').toString().includes(searchTerm);
      const matchSubdomain = (config.subdomain || '').toLowerCase().includes(searchTerm);
      const matchUrl = (config.url || '').toLowerCase().includes(searchTerm);
      const matchHost = (config.localHost || '').toLowerCase().includes(searchTerm);
      if (!matchName && !matchPort && !matchSubdomain && !matchUrl && !matchHost) {
        return false;
      }
    }

    return true;
  });

  filtered.sort((a, b) => {
    if (sortMode === 'name_asc') {
      return (a.name || '').localeCompare(b.name || '', 'ru');
    }
    if (sortMode === 'port_asc') {
      return parseInt(a.port, 10) - parseInt(b.port, 10);
    }
    if (sortMode === 'active_first') {
      if (a.active === b.active) return 0;
      return a.active ? -1 : 1;
    }
    // created_desc (default)
    const timeA = a.createdAt || (a.id ? parseInt(a.id, 10) : 0);
    const timeB = b.createdAt || (b.id ? parseInt(b.id, 10) : 0);
    return timeB - timeA;
  });

  return filtered;
}

// --- QUICK STATS STRIP ---
function updateStatsStrip() {
  const total = currentConfigs.length;
  let active = 0;
  let issues = 0;

  currentConfigs.forEach((config) => {
    const status = latestStatuses[config.id] || config.status || { type: 'info' };
    if (config.active && status.type === 'success') active++;
    if (status.type === 'warning' || status.type === 'error') issues++;
  });

  statActiveEl.textContent = active;
  statTotalEl.textContent = total;
  statIssuesEl.textContent = issues;
  statIssuesPill.hidden = issues === 0;
}

// --- RENDER TUNNELS ---
function renderTunnels(configs) {
  if (configs) currentConfigs = configs;
  updateStatsStrip();

  const filtered = getFilteredAndSortedConfigs();
  tunnelsList.innerHTML = '';

  if (filtered.length === 0) {
    const noConfigsYet = currentConfigs.length === 0;
    tunnelsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon-wrap">
          <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
        </div>
        <p>${noConfigsYet
          ? 'Пока нет ни одного туннеля. Нажмите «+» вверху, чтобы создать первый.'
          : 'Нет туннелей, соответствующих выбранным параметрам фильтрации.'}</p>
      </div>
    `;
    updateBatchUI();
    return;
  }

  filtered.forEach(config => {
    const card = document.createElement('div');
    card.className = 'tunnel-card';
    card.setAttribute('data-id', config.id);

    if (selectedIds.has(config.id)) {
      card.classList.add('selected');
    }

    let urlBlockHtml = '';
    if (config.active && config.url) {
      const escapedUrl = escapeHtml(config.url);
      urlBlockHtml = `
        <div class="tunnel-url-container">
          <a href="${escapedUrl}" class="tunnel-url-link" title="${escapedUrl}" target="_blank">${escapedUrl}</a>
          <button class="url-action-btn" data-action="open-url" data-url="${escapedUrl}" title="Открыть в браузере">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            Открыть
          </button>
          <button class="url-action-btn" data-action="copy-url" data-url="${escapedUrl}" title="Скопировать ссылку">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Копировать
          </button>
          <button class="url-action-btn" data-action="qr-url" data-url="${escapedUrl}" data-name="${escapeHtml(config.name)}" title="Показать QR-код">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            QR-код
          </button>
        </div>
      `;
    }

    const configProvider = config.provider || 'lt';
    const providerBadgeHtml = `<span class="provider-badge ${configProvider}">${configProvider.toUpperCase()}</span>`;

    const metaSubdomain = (configProvider === 'lt' && config.subdomain)
      ? `<span class="meta-separator">•</span><span>Домен: <strong>${escapeHtml(config.subdomain)}</strong></span>`
      : '';

    const customHostMeta = (config.localHost && config.localHost !== 'localhost' && config.localHost !== '127.0.0.1')
      ? `<span class="meta-separator">•</span><span>Хост: <strong>${escapeHtml(config.localHost)}</strong></span>`
      : '';

    const httpsMeta = (config.localProtocol === 'https')
      ? `<span class="meta-separator">•</span><span><strong>HTTPS</strong></span>`
      : '';

    const status = latestStatuses[config.id] || config.status || { type: 'info', message: 'Не активен' };
    card.classList.add(`status-${status.type}`);

    const uptimeVal = latestUptimes[config.id];
    const uptimeBadgeHtml = uptimeVal
      ? `<span id="uptime-${config.id}" class="uptime-badge">${formatUptime(uptimeVal)}</span>`
      : `<span id="uptime-${config.id}" class="uptime-badge hidden"></span>`;

    const statsVal = latestRequestStats[config.id] || (config.stats && config.stats.count > 0 ? config.stats : null);
    const statsBadgeHtml = (statsVal && statsVal.count > 0)
      ? `<span id="stats-${config.id}" class="stats-badge" title="${escapeHtml(requestStatsTitle(statsVal))}">${statsVal.count} req</span>`
      : `<span id="stats-${config.id}" class="stats-badge hidden"></span>`;

    card.innerHTML = `
      <div class="card-left-section">
        <div class="tunnel-info">
          <h3 class="card-title">
            <span id="status-dot-${config.id}" class="status-dot ${status.type}"></span>
            <span class="tunnel-name-text" title="${escapeHtml(config.name)}">${escapeHtml(config.name)}</span>
            ${providerBadgeHtml}
            ${uptimeBadgeHtml}
            ${statsBadgeHtml}
          </h3>
          <div class="card-meta">
            <span>Порт: <strong>${parseInt(config.port, 10)}</strong></span>
            ${customHostMeta}
            ${httpsMeta}
            ${metaSubdomain}
            <span class="meta-separator">•</span>
            <span id="status-text-${config.id}" class="status-message">${escapeHtml(status.message)}</span>
          </div>
          ${urlBlockHtml}
        </div>
      </div>
      <div class="right-actions">
        <button class="btn-action" data-action="edit" title="Редактировать конфигурацию" aria-label="Редактировать">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
        </button>
        <label class="switch" title="Включить/Выключить туннель">
          <input type="checkbox" id="switch-${config.id}" ${config.active ? 'checked' : ''} aria-label="Включить/выключить туннель ${escapeHtml(config.name)}">
          <span class="slider"></span>
        </label>
        <button class="btn-action btn-delete" data-action="delete" title="Удалить туннель" aria-label="Удалить">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </div>
    `;

    // Event Delegations for this card
    const switchEl = card.querySelector(`#switch-${config.id}`);
    switchEl.addEventListener('change', (e) => {
      toggleTunnel(config.id, e.target.checked);
    });

    card.addEventListener('click', async (e) => {
      const btn = e.target.closest('button, a, input, label');
      if (btn) {
        const action = btn.getAttribute('data-action');
        if (action === 'open-url') {
          const url = btn.getAttribute('data-url');
          window.api.openExternal(url);
          return;
        }
        if (action === 'copy-url') {
          const url = btn.getAttribute('data-url');
          copyLink(url);
          return;
        }
        if (action === 'qr-url') {
          const url = btn.getAttribute('data-url');
          const name = btn.getAttribute('data-name');
          openQrModal(url, name);
          return;
        }
        if (action === 'edit') {
          openEditForm(config.id);
          return;
        }
        if (action === 'delete') {
          deleteTunnel(config.id, config.name);
          return;
        }
        return;
      }

      // Card Selection for Batch actions
      const isSelected = card.classList.toggle('selected');
      if (isSelected) {
        selectedIds.add(config.id);
      } else {
        selectedIds.delete(config.id);
      }
      updateBatchUI();
    });

    tunnelsList.appendChild(card);
  });

  updateBatchUI();
}

// --- EDIT FORM ---
function openEditForm(id) {
  const config = currentConfigs.find(c => c.id === id);
  if (!config) return;

  editingId = config.id;
  nameInput.value = config.name || '';
  portInput.value = config.port ? parseInt(config.port, 10) : '';
  subdomainInput.value = config.subdomain || '';
  hostInput.value = config.localHost || 'localhost';
  protocolSelect.value = config.localProtocol || 'http';
  skipTlsVerifyCheckbox.checked = config.skipTlsVerify !== false;

  const provider = config.provider || 'lt';
  providerSelect.value = provider;
  if (provider === 'cf') {
    subdomainGroup.classList.add('hidden');
  } else {
    subdomainGroup.classList.remove('hidden');
  }

  if (config.localHost && config.localHost !== 'localhost' || config.localProtocol === 'https') {
    advancedSection.classList.remove('hidden');
    advancedArrow.innerText = '▼';
  } else {
    advancedSection.classList.add('hidden');
    advancedArrow.innerText = '▶';
  }

  document.getElementById('form-title').innerText = 'Редактировать туннель';
  saveBtn.innerText = 'Сохранить изменения';

  addForm.classList.remove('hidden');
  nameInput.focus();
}

// --- COPY TO CLIPBOARD ---
function copyLink(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('Ссылка скопирована в буфер обмена', 'success');
    }).catch(() => {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
    showToast('Ссылка скопирована в буфер обмена', 'success');
  } catch (err) {
    showToast('Не удалось скопировать ссылку', 'error');
  }
  document.body.removeChild(textArea);
}

// --- TOGGLE & DELETE TUNNEL ---
async function toggleTunnel(id, state) {
  try {
    const configs = await window.api.toggleTunnel(id, state);
    renderTunnels(configs);
  } catch (err) {
    console.error('Ошибка переключения туннеля:', err);
    showToast('Ошибка при изменении состояния туннеля', 'error');
  }
}

async function deleteTunnel(id, name) {
  const confirmed = await customConfirm(
    `Вы действительно хотите удалить конфигурацию «${name || id}»?`,
    'Удаление туннеля'
  );
  if (confirmed) {
    selectedIds.delete(id);
    const configs = await window.api.deleteConfig(id);
    renderTunnels(configs);
    showToast('Туннель удален', 'info');
  }
}

// --- SEARCH & FILTER EVENTS ---
searchInput.addEventListener('input', () => {
  if (searchInput.value.trim().length > 0) {
    searchClearBtn.classList.remove('hidden');
  } else {
    searchClearBtn.classList.add('hidden');
  }
  renderTunnels();
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  renderTunnels();
});

filterStatus.addEventListener('change', () => renderTunnels());
filterProvider.addEventListener('change', () => renderTunnels());
sortSelect.addEventListener('change', () => renderTunnels());

resetFiltersBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  filterStatus.value = 'all';
  filterProvider.value = 'all';
  sortSelect.value = 'created_desc';
  renderTunnels();
});

// --- BATCH ACTIONS ---
function updateBatchUI() {
  if (selectedIds.size > 0) {
    batchBar.classList.add('visible');
    selectedCountText.innerText = `Выбрано: ${selectedIds.size}`;
  } else {
    batchBar.classList.remove('visible');
  }
}

batchSelectAllBtn.addEventListener('click', () => {
  currentConfigs.forEach(config => selectedIds.add(config.id));
  renderTunnels();
});

batchCancelBtn.addEventListener('click', () => {
  selectedIds.clear();
  renderTunnels();
});

batchStartBtn.addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  selectedIds.clear();
  const configs = await window.api.batchToggle(ids, true);
  renderTunnels(configs);
  showToast(`Запуск выбранных (${ids.length} шт.)`, 'info');
});

batchStopBtn.addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  selectedIds.clear();
  const configs = await window.api.batchToggle(ids, false);
  renderTunnels(configs);
  showToast(`Остановка выбранных (${ids.length} шт.)`, 'info');
});

batchDeleteBtn.addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  const confirmed = await customConfirm(
    `Вы уверены, что хотите удалить выбранные туннели (${ids.length} шт.)?`,
    'Пакетное удаление'
  );
  if (confirmed) {
    selectedIds.clear();
    const configs = await window.api.batchDelete(ids);
    renderTunnels(configs);
    showToast(`Удалено ${ids.length} конфигураций`, 'info');
  }
});

// --- QR CODE GENERATOR (OFFLINE ZERO-DEPENDENCY SVG) ---
function createQrImage(text) {
  // Оффлайн-генерация QR-кода в main-процессе (data URL),
  // URL туннеля не покидает машину
  const img = document.createElement('img');
  img.alt = 'QR Code';
  img.width = 200;
  img.height = 200;

  window.api.generateQr(text).then(dataUrl => {
    img.src = dataUrl;
  }).catch(() => {
    qrCodeContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 20px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
        <p style="margin-top: 8px; font-size: 12px;">Не удалось сгенерировать QR-код</p>
      </div>
    `;
  });
  return img;
}

function openQrModal(url, name) {
  qrModalTitle.innerText = name ? `QR-код: ${name}` : 'QR-код туннеля';
  qrModalUrl.innerText = url;
  qrCodeContainer.innerHTML = '';
  const qrImg = createQrImage(url);
  qrCodeContainer.appendChild(qrImg);
  qrCopyBtn.onclick = () => copyLink(url);
  qrModal.classList.remove('hidden');
}

// --- LOGS MODAL ---
logsBtn.addEventListener('click', async () => {
  await refreshLogs();
  logsModal.classList.remove('hidden');
});

async function refreshLogs() {
  rawLogsCache = await window.api.getLogs();
  renderLogsView();
}

function renderLogsView() {
  const search = logsSearchInput.value.trim().toLowerCase();
  const level = logsLevelFilter.value;

  const filtered = rawLogsCache.filter(item => {
    if (level !== 'all' && item.level !== level) return false;
    if (search && !item.message.toLowerCase().includes(search) && !item.timestamp.includes(search)) return false;
    return true;
  });

  logsStatusCount.innerText = `Записей: ${filtered.length} (из ${rawLogsCache.length})`;
  logsConsole.innerHTML = '';

  if (filtered.length === 0) {
    logsConsole.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">Нет логов, соответствующих условиям фильтра.</div>';
    return;
  }

  filtered.forEach(log => {
    const div = document.createElement('div');
    const lvlClass = log.level ? log.level.toLowerCase() : 'info';
    div.className = `log-line ${lvlClass}`;
    div.innerText = `[${log.timestamp}] [${log.level}] ${log.message}`;
    logsConsole.appendChild(div);
  });

  logsConsole.scrollTop = logsConsole.scrollHeight;
}

logsSearchInput.addEventListener('input', () => renderLogsView());
logsLevelFilter.addEventListener('change', () => renderLogsView());

logsClearBtn.addEventListener('click', async () => {
  await window.api.clearLogs();
  rawLogsCache = [];
  renderLogsView();
  showToast('Логи в памяти очищены', 'info');
});

logsOpenFolderBtn.addEventListener('click', () => {
  window.api.openLogFolder();
});

logsCopyBtn.addEventListener('click', () => {
  if (rawLogsCache.length === 0) {
    showToast('Журнал логов пуст', 'info');
    return;
  }
  const text = rawLogsCache.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
  copyLink(text);
});

// --- SETTINGS MODAL ---
settingsBtn.addEventListener('click', async () => {
  const settings = await window.api.getSettings();
  settingAutoLaunch.checked = !!settings.autoLaunch;
  settingStartMinimized.checked = !!settings.startMinimized;
  settingCloseToTray.checked = settings.closeToTray !== false;
  settingNotifications.checked = settings.notifications !== false;
  settingDefaultProvider.value = settings.defaultProvider || 'lt';
  settingsModal.classList.remove('hidden');
});

settingsSaveBtn.addEventListener('click', async () => {
  const newSettings = {
    autoLaunch: settingAutoLaunch.checked,
    startMinimized: settingStartMinimized.checked,
    closeToTray: settingCloseToTray.checked,
    notifications: settingNotifications.checked,
    defaultProvider: settingDefaultProvider.value
  };
  await window.api.saveSettings(newSettings);
  settingsModal.classList.add('hidden');
  showToast('Настройки сохранены', 'success');
});

// --- BACKUP (IMPORT / EXPORT) MODAL ---
importExportBtn.addEventListener('click', () => {
  backupModal.classList.remove('hidden');
});

exportBtn.addEventListener('click', async () => {
  const res = await window.api.exportConfigs();
  if (res.success) {
    showToast(`Экспортировано ${res.count} конфигураций`, 'success');
    backupModal.classList.add('hidden');
  } else if (res.error) {
    showToast(`Ошибка экспорта: ${res.error}`, 'error');
  }
});

importBtn.addEventListener('click', async () => {
  const res = await window.api.importConfigs();
  if (res.success) {
    showToast(`Импортировано ${res.count} конфигураций`, 'success');
    renderTunnels(res.configs);
    backupModal.classList.add('hidden');
  } else if (res.error) {
    showToast(`Ошибка импорта: ${res.error}`, 'error');
  }
});


// --- REAL-TIME IPC LISTENERS ---
window.api.onTunnelStatus((data) => {
  latestStatuses[data.id] = data.status;

  const dot = document.getElementById(`status-dot-${data.id}`);
  const text = document.getElementById(`status-text-${data.id}`);
  const card = tunnelsList.querySelector(`.tunnel-card[data-id="${data.id}"]`);

  if (dot) {
    dot.className = `status-dot ${data.status.type}`;
  }
  if (text) {
    text.innerText = data.status.message;
  }
  if (card) {
    card.className = card.className.replace(/\bstatus-\S+/g, '').trim();
    card.classList.add(`status-${data.status.type}`);
  }

  const config = currentConfigs.find(c => c.id === data.id);
  if (config) {
    config.status = data.status;
  }
  updateStatsStrip();
});

window.api.onConfigsUpdated((configs) => {
  renderTunnels(configs);
});

window.api.onUptimesUpdated((uptimes) => {
  for (const [id, secs] of Object.entries(uptimes)) {
    latestUptimes[id] = secs;
    const el = document.getElementById(`uptime-${id}`);
    if (el) {
      el.innerText = formatUptime(secs);
      el.classList.remove('hidden');
    }
  }
  currentConfigs.forEach(config => {
    if (!uptimes[config.id]) {
      delete latestUptimes[config.id];
      const el = document.getElementById(`uptime-${config.id}`);
      if (el) {
        el.innerText = '';
        el.classList.add('hidden');
      }
    }
  });
});

window.api.onRequestStats((data) => {
  latestRequestStats[data.id] = data.stats;
  const el = document.getElementById(`stats-${data.id}`);
  if (el && data.stats && data.stats.count > 0) {
    el.innerText = `${data.stats.count} req`;
    el.title = requestStatsTitle(data.stats);
    el.classList.remove('hidden');
  }
});

// Initialization
loadTunnels();