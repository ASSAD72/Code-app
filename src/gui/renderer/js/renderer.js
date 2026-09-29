// CodeX Desktop — Renderer process script.
// Runs in the isolated renderer context; only talks to Core via the
// `window.codex` bridge exposed by preload.ts (real IPC, no direct
// filesystem/process access from here).

(function () {
  'use strict';

  const state = {
    projects: [],
    environments: [],
    packs: [],
  };

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      item.classList.add('active');
      const viewName = item.dataset.view;
      document.getElementById(`view-${viewName}`).classList.add('active');
      document.getElementById('view-title').textContent = item.textContent;
      onViewShown(viewName);
    });
  });

  function onViewShown(viewName) {
    if (viewName === 'dashboard') loadDashboard();
    if (viewName === 'projects') loadProjects();
    if (viewName === 'environments') loadEnvironments();
    if (viewName === 'jobs') loadJobs();
    if (viewName === 'snapshots') loadSnapshotProjectOptions();
    if (viewName === 'exports') loadExportProjectOptions();
    if (viewName === 'plugins') loadPlugins();
  }

  async function loadDashboard() {
    const availability = await window.codex.environments.availability();
    const sandboxStatusEl = document.getElementById('sandbox-status');
    sandboxStatusEl.innerHTML = Object.entries(availability)
      .map(
        ([type, status]) =>
          `<div class="status-row"><span class="status-dot ${status.available ? 'ok' : 'bad'}"></span>${type}</div>`
      )
      .join('');

    const projects = await window.codex.projects.list();
    document.getElementById('project-count').textContent = projects.length;

    const jobs = await window.codex.jobs.list();
    const activeCount = jobs.filter((j) => ['QUEUED', 'RUNNING', 'BUILDING', 'TESTING'].includes(j.status)).length;
    document.getElementById('active-job-count').textContent = activeCount;

    document.getElementById('ai-status').innerHTML = '<div class="status-row muted">Configured via CODEX_AI_PROVIDER env var</div>';
  }

  async function loadProjects() {
    state.projects = await window.codex.projects.list();
    const tbody = document.querySelector('#projects-table tbody');
    tbody.innerHTML = state.projects
      .map(
        (p) => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.type)}</td>
        <td>${escapeHtml(p.environmentId.slice(0, 8))}</td>
        <td>${new Date(p.updatedAt).toLocaleString()}</td>
        <td>
          <button class="btn-secondary" data-action="build" data-id="${p.id}">Build</button>
          <button class="btn-secondary" data-action="test" data-id="${p.id}">Test</button>
          <button class="btn-secondary" data-action="repair" data-id="${p.id}">Repair</button>
        </td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => handleProjectAction(btn.dataset.action, btn.dataset.id));
    });
  }

  async function handleProjectAction(action, projectId) {
    if (action === 'build') {
      const result = await window.codex.build.run(projectId);
      alert(result.success ? 'Build succeeded!' : `Build failed (exit ${result.exitCode})`);
    } else if (action === 'test') {
      const result = await window.codex.test.run(projectId);
      alert(result.success ? 'Tests passed!' : `Tests failed (exit ${result.exitCode})`);
    } else if (action === 'repair') {
      const session = await window.codex.repair.run(projectId, 8);
      alert(`Repair session ${session.status} after ${session.attempts.length} attempt(s).`);
    }
  }

  document.getElementById('btn-new-project').addEventListener('click', async () => {
    state.packs = await window.codex.environments.packs();
    showModal(`
      <h3>New Project</h3>
      <label>Name</label>
      <input type="text" id="new-project-name" placeholder="my-app" />
      <label>Environment Pack</label>
      <select id="new-project-pack">
        ${state.packs.map((p) => `<option value="${p.packId}">${escapeHtml(p.displayName)}</option>`).join('')}
      </select>
      <button class="btn-primary" id="confirm-new-project">Create</button>
    `);
    document.getElementById('confirm-new-project').addEventListener('click', async () => {
      const name = document.getElementById('new-project-name').value.trim();
      const packId = document.getElementById('new-project-pack').value;
      if (!name) return;
      hideModal();
      await window.codex.projects.create({ name, packId, type: 'custom' });
      loadProjects();
    });
  });

  async function loadEnvironments() {
    state.environments = await window.codex.environments.list();
    const tbody = document.querySelector('#environments-table tbody');
    tbody.innerHTML = state.environments
      .map(
        (e) => `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td>${escapeHtml(e.packId)}</td>
        <td>${escapeHtml(e.providerType)}</td>
        <td>${escapeHtml(e.version)}</td>
      </tr>`
      )
      .join('');
  }

  document.getElementById('btn-new-environment').addEventListener('click', async () => {
    state.packs = await window.codex.environments.packs();
    showModal(`
      <h3>New Environment</h3>
      <label>Pack</label>
      <select id="new-env-pack">
        ${state.packs.map((p) => `<option value="${p.packId}">${escapeHtml(p.displayName)}</option>`).join('')}
      </select>
      <button class="btn-primary" id="confirm-new-env">Create</button>
    `);
    document.getElementById('confirm-new-env').addEventListener('click', async () => {
      const packId = document.getElementById('new-env-pack').value;
      hideModal();
      await window.codex.environments.create(packId);
      loadEnvironments();
    });
  });

  async function loadJobs() {
    const jobs = await window.codex.jobs.list();
    const tbody = document.querySelector('#jobs-table tbody');
    tbody.innerHTML = jobs
      .map(
        (j) => `
      <tr>
        <td>${escapeHtml(j.title)}</td>
        <td>${escapeHtml(j.kind)}</td>
        <td><span class="badge ${j.status}">${j.status}</span></td>
        <td>${new Date(j.createdAt).toLocaleString()}</td>
        <td>${['QUEUED', 'RUNNING', 'BUILDING', 'TESTING'].includes(j.status) ? `<button class="btn-secondary" data-cancel="${j.id}">Cancel</button>` : ''}</td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => window.codex.jobs.cancel(btn.dataset.cancel).then(loadJobs));
    });
  }

  window.codex.jobs.onLog(({ jobId, line }) => {
    const el = document.getElementById('terminal-output');
    const div = document.createElement('div');
    div.className = `log-line ${line.stream}`;
    div.textContent = `[${jobId.slice(0, 8)}] ${line.text}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  });

  window.codex.jobs.onStatus(() => {
    if (document.getElementById('view-jobs').classList.contains('active')) loadJobs();
  });

  async function loadSnapshotProjectOptions() {
    const projects = await window.codex.projects.list();
    const select = document.getElementById('snapshot-project-select');
    select.innerHTML = projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    if (projects.length > 0) loadSnapshots(projects[0].id);
    select.onchange = () => loadSnapshots(select.value);
  }

  async function loadSnapshots(projectId) {
    const snapshots = await window.codex.snapshots.list(projectId);
    const tbody = document.querySelector('#snapshots-table tbody');
    tbody.innerHTML = snapshots
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.id)}</td>
        <td>${escapeHtml(s.label)}</td>
        <td>${new Date(s.createdAt).toLocaleString()}</td>
        <td><button class="btn-secondary" data-restore="${s.id}" data-project="${projectId}">Restore</button></td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('This will overwrite current project state. Continue?')) return;
        await window.codex.snapshots.restore(btn.dataset.project, btn.dataset.restore);
        alert('Restored.');
      });
    });
  }

  document.getElementById('btn-new-snapshot').addEventListener('click', async () => {
    const projectId = document.getElementById('snapshot-project-select').value;
    if (!projectId) return;
    const label = prompt('Snapshot label:', 'Manual snapshot') || 'Manual snapshot';
    await window.codex.snapshots.create(projectId, label);
    loadSnapshots(projectId);
  });

  async function loadExportProjectOptions() {
    const projects = await window.codex.projects.list();
    const select = document.getElementById('export-project-select');
    select.innerHTML = projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  }

  document.getElementById('btn-export').addEventListener('click', async () => {
    const projectId = document.getElementById('export-project-select').value;
    const target = document.getElementById('export-target-select').value;
    if (!projectId) return;
    const logEl = document.getElementById('export-log');
    logEl.textContent = 'Exporting...';
    try {
      const outputDir = './codex-exports';
      const result =
        target === 'source'
          ? await window.codex.exportProject.source(projectId, outputDir)
          : await window.codex.exportProject.native(projectId, target, outputDir);
      logEl.textContent = `Exported to: ${result}`;
    } catch (err) {
      logEl.textContent = `Export failed: ${err.message}`;
    }
  });

  window.codex.exportProject.onProgress((line) => {
    const logEl = document.getElementById('export-log');
    logEl.textContent += `\n${line}`;
  });

  async function loadPlugins() {
    const plugins = await window.codex.plugins.list();
    const tbody = document.querySelector('#plugins-table tbody');
    tbody.innerHTML = plugins
      .map(
        (p) => `
      <tr>
        <td>${escapeHtml(p.manifest.id)}</td>
        <td>${escapeHtml(p.manifest.version)}</td>
        <td>${p.enabled ? 'Yes' : 'No'}</td>
      </tr>`
      )
      .join('');
    if (plugins.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">No plugins installed.</td></tr>';
    }
  }

  function showModal(html) {
    document.getElementById('modal-box').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }
  function hideModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') hideModal();
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  loadDashboard();
})();
