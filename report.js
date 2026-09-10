const $ = (id) => document.getElementById(id);
const clampScore = (v) => Number.isFinite(v) ? Math.round(v) : null;
const categoryLabels = {
  ui: 'UI checks', performance: 'Performance', accessibility: 'Accessibilité', console: 'Console JS', network: 'Réseau'
};

function scoreClass(score) {
  if (score == null) return 'neutral';
  if (score >= 90) return 'good';
  if (score >= 70) return 'warn';
  return 'bad';
}

async function main() {
  const id = new URLSearchParams(location.search).get('id');
  const { diagnosticHistory = [] } = await chrome.storage.local.get('diagnosticHistory');
  const item = diagnosticHistory.find((x) => x.diagnosticId === id) || diagnosticHistory[0];
  if (!item) {
    $('reportTitle').textContent = 'Aucun diagnostic trouvé';
    return;
  }

  $('reportTitle').textContent = `${item.projectName || item.host} — ${item.diagnosticId}`;
  $('reportMeta').textContent = `${item.mode.toUpperCase()} · ${new Date(item.finishedAt || item.startedAt).toLocaleString()} · ${item.origin}`;
  $('overallScore').textContent = item.scores?.overall ?? '—';
  document.querySelector('.score-ring').classList.add(scoreClass(item.scores?.overall));

  $('scoreCards').innerHTML = Object.entries(categoryLabels).map(([key, label]) => {
    const score = clampScore(item.scores?.[key]);
    return `<article class="score-card ${scoreClass(score)}"><span>${label}</span><strong>${score ?? '—'}</strong><small>${score == null ? 'non mesuré' : '/100'}</small></article>`;
  }).join('');

  const s = item.summary || {};
  $('summaryGrid').innerHTML = [
    ['Pages', s.pagesVisited ?? 0],
    ['Screenshots', s.captures ?? 0],
    ['Erreurs JS', s.consoleErrors ?? 0],
    ['Requêtes échouées', s.failedRequests ?? 0],
    ['Violations a11y', s.accessibilityViolations ?? 0],
    ['Annotations UX', s.annotations ?? 0]
  ].map(([k,v]) => `<div><strong>${v}</strong><span>${k}</span></div>`).join('');

  const issues = item.topIssues || [];
  $('issues').innerHTML = issues.length ? issues.map((issue) => `
    <article class="issue-row"><span class="severity ${issue.severity || 'moderate'}">${issue.severity || 'info'}</span><div><strong>${escapeHtml(issue.title || issue.type)}</strong><p>${escapeHtml(issue.page || '')}${issue.detail ? ' — ' + escapeHtml(issue.detail) : ''}</p></div></article>`).join('') : '<p class="muted">Aucun problème prioritaire enregistré dans le résumé.</p>';

  if (item.parentDiagnosticId) {
    const parent = diagnosticHistory.find((x) => x.diagnosticId === item.parentDiagnosticId);
    if (parent?.scores?.overall != null && item.scores?.overall != null) {
      const delta = item.scores.overall - parent.scores.overall;
      $('comparison').classList.remove('hidden');
      $('comparison').innerHTML = `<strong>Comparaison avec ${parent.diagnosticId}</strong><span>Score global : ${parent.scores.overall} → ${item.scores.overall} <b>${delta >= 0 ? '+' : ''}${delta}</b></span>`;
    }
  }
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

main();
