const addBtn = document.getElementById('add-btn');
const addForm = document.getElementById('add-form');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const tunnelsList = document.getElementById('tunnels-list');

let currentConfigs = []; 
let editingId = null;    
const latestStatuses = {};

addBtn.addEventListener('click', () => {
  editingId = null;
  document.getElementById('form-title').innerText = 'Новый туннель';
  document.getElementById('save-btn').innerText = 'Создать туннель';
  
  document.getElementById('name-input').value = '';
  document.getElementById('port-input').value = '';
  document.getElementById('subdomain-input').value = '';
  
  addForm.classList.remove('hidden');
  document.getElementById('name-input').focus();
});

cancelBtn.addEventListener('click', () => addForm.classList.add('hidden'));

saveBtn.addEventListener('click', async () => {
  const name = document.getElementById('name-input').value;
  const port = document.getElementById('port-input').value;
  const subdomain = document.getElementById('subdomain-input').value;
  
  if (!port) {
    alert('Укажите порт!');
    return;
  }

  let configs;
  if (editingId) {
    configs = await window.api.updateConfig({ id: editingId, name, port, subdomain });
  } else {
    configs = await window.api.addConfig({ name, port, subdomain });
  }

  renderTunnels(configs);
  addForm.classList.add('hidden');
  editingId = null;
});

async function loadTunnels() {
  const configs = await window.api.getConfigs();
  renderTunnels(configs);
}

function renderTunnels(configs) {
  currentConfigs = configs; 
  tunnelsList.innerHTML = '';

  if (configs.length === 0) {
    tunnelsList.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
        <p>Список туннелей пуст. Нажмите кнопку «+» вверху, чтобы добавить первый порт.</p>
      </div>
    `;
    return;
  }

  configs.forEach(config => {
    const card = document.createElement('div');
    card.className = 'tunnel-card';
    
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

    const metaSubdomain = config.subdomain 
      ? `<span class="meta-separator">•</span><span>Субдомен: <strong>${config.subdomain}</strong></span>` 
      : '';

    const status = latestStatuses[config.id] || config.status || { type: 'info', message: 'Не активен' };

    card.innerHTML = `
      <div class="tunnel-info">
        <h3 class="card-title">
          <span id="status-dot-${config.id}" class="status-dot ${status.type}"></span>
          ${config.name}
        </h3>
        <div class="card-meta">
          <span>Порт: <strong>${config.port}</strong></span>
          ${metaSubdomain}
          <span class="meta-separator">•</span>
          <span id="status-text-${config.id}" class="status-message">${status.message}</span>
        </div>
        ${urlBlockHtml}
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
    tunnelsList.appendChild(card);
  });
}

window.openEditForm = (id) => {
  const config = currentConfigs.find(c => c.id === id);
  if (!config) return;

  editingId = config.id;
  document.getElementById('name-input').value = config.name || '';
  document.getElementById('port-input').value = config.port || '';
  document.getElementById('subdomain-input').value = config.subdomain || '';

  document.getElementById('form-title').innerText = 'Редактировать туннель';
  document.getElementById('save-btn').innerText = 'Сохранить изменения';
  
  addForm.classList.remove('hidden');
  document.getElementById('name-input').focus();
};

window.copyLink = (url, btnId) => {
  navigator.clipboard.writeText(url).then(() => {
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

loadTunnels();