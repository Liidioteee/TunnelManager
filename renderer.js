const addBtn = document.getElementById('add-btn');
const addForm = document.getElementById('add-form');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const tunnelsList = document.getElementById('tunnels-list');
const logsBtn = document.getElementById('logs-btn');
const themeBtn = document.getElementById('theme-btn');
const providerSelect = document.getElementById('provider-select');
const subdomainGroup = document.getElementById('subdomain-group');
const filterStatus = document.getElementById('filter-status');
const filterProvider = document.getElementById('filter-provider');
const resetFiltersBtn = document.getElementById('reset-filters');
const batchBar = document.getElementById('batch-bar');
const selectedCountText = document.getElementById('selected-count');
const batchSelectAllBtn = document.getElementById('batch-select-all');
const batchCancelBtn = document.getElementById('batch-cancel-btn');
const batchStartBtn = document.getElementById('batch-start-btn');
const batchStopBtn = document.getElementById('batch-stop-btn');
const batchDeleteBtn = document.getElementById('batch-delete-btn');
const portInput = document.getElementById('port-input');

let currentConfigs = []; 
let editingId = null;    
const latestStatuses = {};
const latestUptimes = {};
const selectedIds = new Set();

function formatUptime(secs) {
  const h = Math.floor(secs / 3600).toString().padStart(2, '0');
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

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

logsBtn.addEventListener('click', () => {
  window.api.openLogFolder();
});

providerSelect.addEventListener('change', () => {
  if (providerSelect.value === 'cf') {
    subdomainGroup.classList.add('hidden');
    document.getElementById('subdomain-input').value = '';
  } else {
    subdomainGroup.classList.remove('hidden');
  }
});

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

addBtn.addEventListener('click', () => {
  editingId = null;
  document.getElementById('form-title').innerText = 'Новый туннель';
  document.getElementById('save-btn').innerText = 'Создать туннель';
  
  document.getElementById('name-input').value = '';
  portInput.value = '';
  document.getElementById('subdomain-input').value = '';
  providerSelect.value = 'lt';
  subdomainGroup.classList.remove('hidden');
  
  addForm.classList.remove('hidden');
  document.getElementById('name-input').focus();
});

cancelBtn.addEventListener('click', () => addForm.classList.add('hidden'));

saveBtn.addEventListener('click', async () => {
  const name = document.getElementById('name-input').value;
  const port = portInput.value;
  const subdomain = document.getElementById('subdomain-input').value;
  const provider = providerSelect.value;
  
  const portVal = parseInt(port, 10);
  if (!port || isNaN(portVal) || portVal < 1 || portVal > 65535) {
    alert('Пожалуйста, укажите корректный порт от 1 до 65535!');
    return;
  }

  const sanitizedPort = portVal.toString();

  let configs;
  if (editingId) {
    configs = await window.api.updateConfig({ id: editingId, name, port: sanitizedPort, subdomain, provider });
  } else {
    configs = await window.api.addConfig({ name, port: sanitizedPort, subdomain, provider });
  }

  renderTunnels(configs);
  addForm.classList.add('hidden');
  editingId = null;
});

async function loadTunnels() {
  const configs = await window.api.getConfigs();
  renderTunnels(configs);
}

function getFilteredConfigs() {
  return currentConfigs.filter(config => {
    const configProvider = config.provider || 'lt';
    if (filterProvider.value !== 'all' && configProvider !== filterProvider.value) {
      return false;
    }

    const status = latestStatuses[config.id] || config.status || { type: 'info', message: 'Не активен' };
    if (filterStatus.value !== 'all') {
      if (filterStatus.value === 'active' && (!config.active || status.type !== 'success')) {
        return false;
      }
      if (filterStatus.value === 'warning' && status.type !== 'warning') {
        return false;
      }
      if (filterStatus.value === 'inactive' && config.active) {
        return false;
      }
    }
    return true;
  });
}

function renderTunnels(configs) {
  if (configs) currentConfigs = configs;
  
  const filtered = getFilteredConfigs();
  tunnelsList.innerHTML = '';

  if (filtered.length === 0) {
    tunnelsList.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
        <p>Список пуст или нет туннелей, соответствующих фильтрам.</p>
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
      const copyBtnId = `copy-btn-${config.id}`;
      urlBlockHtml = `
        <div class="tunnel-url-container" style="margin-top: 6px;">
          <a href="${config.url}" class="tunnel-url-link" target="_blank">${config.url}</a>
          <button id="${copyBtnId}" class="btn-copy" onclick="copyLink('${config.url}', '${copyBtnId}')">Скопировать</button>
        </div>
      `;
    }

    const configProvider = config.provider || 'lt';
    const providerBadgeHtml = `<span class="provider-badge ${configProvider}">${configProvider.toUpperCase()}</span>`;

    const metaSubdomain = (configProvider === 'lt' && config.subdomain)
      ? `<span class="meta-separator">•</span><span>Субдомен: <strong>${config.subdomain}</strong></span>` 
      : '';

    const status = latestStatuses[config.id] || config.status || { type: 'info', message: 'Не активен' };

    const uptimeVal = latestUptimes[config.id];
    const uptimeBadgeHtml = uptimeVal 
      ? `<span id="uptime-${config.id}" class="uptime-badge">${formatUptime(uptimeVal)}</span>` 
      : `<span id="uptime-${config.id}" class="uptime-badge hidden"></span>`;

    card.innerHTML = `
      <div class="card-left-section">
        <div class="tunnel-info">
          <h3 class="card-title">
            <span id="status-dot-${config.id}" class="status-dot ${status.type}"></span>
            ${config.name}
            ${providerBadgeHtml}
            ${uptimeBadgeHtml}
          </h3>
          <div class="card-meta">
            <span>Порт: <strong>${parseInt(config.port, 10)}</strong></span>
            ${metaSubdomain}
            <span class="meta-separator">•</span>
            <span id="status-text-${config.id}" class="status-message">${status.message}</span>
          </div>
          ${urlBlockHtml}
        </div>
      </div>
      <div class="right-actions">
        <button class="btn-action" title="Редактировать" onclick="openEditForm('${config.id}')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
        </button>
        <label class="switch" title="Включить/Выключить">
          <input type="checkbox" id="switch-${config.id}" ${config.active ? 'checked' : ''} onchange="toggleTunnel('${config.id}', this.checked)">
          <span class="slider"></span>
        </label>
        <button class="btn-action btn-delete" title="Удалить" onclick="deleteTunnel('${config.id}')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      const interactive = e.target.closest('button, a, input, label, .switch, .btn-copy');
      if (interactive) return;

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

window.openEditForm = (id) => {
  const config = currentConfigs.find(c => c.id === id);
  if (!config) return;

  editingId = config.id;
  document.getElementById('name-input').value = config.name || '';
  portInput.value = config.port ? parseInt(config.port, 10) : '';
  document.getElementById('subdomain-input').value = config.subdomain || '';
  
  const provider = config.provider || 'lt';
  providerSelect.value = provider;
  if (provider === 'cf') {
    subdomainGroup.classList.add('hidden');
  } else {
    subdomainGroup.classList.remove('hidden');
  }

  document.getElementById('form-title').innerText = 'Редактировать туннель';
  document.getElementById('save-btn').innerText = 'Сохранить изменения';
  
  addForm.classList.remove('hidden');
  document.getElementById('name-input').focus();
};

window.copyLink = (url, btnId) => {
  navigator.clipboard.then = navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    
    const originalText = btn.innerText;
    btn.innerText = '✓ Скопировано';
    btn.style.backgroundColor = 'var(--success-bg)';
    btn.style.color = 'var(--success)';
    btn.style.borderColor = 'var(--success)';
    
    setTimeout(() => {
      btn.innerText = originalText;
      btn.style.backgroundColor = '';
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 2000);
  });
};

window.toggleTunnel = async (id, state) => {
  try {
    const configs = await window.api.toggleTunnel(id, state);
    renderTunnels(configs);
  } catch (err) {
    console.error('Ошибка переключения туннеля:', err);
  }
};

window.deleteTunnel = async (id) => {
  if (confirm('Вы уверены, что хотите удалить эту конфигурацию?')) {
    const configs = await window.api.deleteConfig(id);
    renderTunnels(configs);
  }
};

filterStatus.addEventListener('change', () => renderTunnels());
filterProvider.addEventListener('change', () => renderTunnels());

resetFiltersBtn.addEventListener('click', () => {
  filterStatus.value = 'all';
  filterProvider.value = 'all';
  renderTunnels();
});

window.updateBatchUI = () => {
  if (selectedIds.size > 0) {
    batchBar.classList.add('visible');
    selectedCountText.innerText = `Выбрано: ${selectedIds.size}`;
  } else {
    batchBar.classList.remove('visible');
  }
};

batchSelectAllBtn.addEventListener('click', () => {
  currentConfigs.forEach(config => {
    selectedIds.add(config.id);
  });
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
});

batchStopBtn.addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  selectedIds.clear();
  const configs = await window.api.batchToggle(ids, false);
  renderTunnels(configs);
});

batchDeleteBtn.addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  if (confirm(`Вы уверены, что хотите удалить выбранные туннели (${ids.length} шт.)?`)) {
    selectedIds.clear();
    const configs = await window.api.batchDelete(ids);
    renderTunnels(configs);
  }
});

window.api.onTunnelStatus((data) => {
  latestStatuses[data.id] = data.status;

  const dot = document.getElementById(`status-dot-${data.id}`);
  const text = document.getElementById(`status-text-${data.id}`);
  const toggle = document.getElementById(`switch-${data.id}`);
  
  if (dot) {
    dot.className = `status-dot ${data.status.type}`;
  }
  if (text) {
    text.innerText = data.status.message;
  }
  
  if (toggle && data.status.type === 'error') {
    toggle.checked = false;
  }

  const config = currentConfigs.find(c => c.id === data.id);
  if (config) {
    config.status = data.status;
  }
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

loadTunnels();