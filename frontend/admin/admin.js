const API = (typeof window !== 'undefined' && window.SURVEY_API) || '';
const SURVEY_BASE = (typeof window !== 'undefined' && window.SURVEY_PUBLIC_URL)
  || (window.location.origin + window.location.pathname.replace(/\/admin\/?$/, '/'));
let ADMIN_KEY = '';
let ADMIN_PROFILE = null;  // { name, email, role }

// ── Auth ──
async function doLogin() {
  const input = document.getElementById('admin-key-input').value.trim();
  if (!input) return;
  ADMIN_KEY = input;
  try {
    const who = await api('/api/admin/me');
    ADMIN_PROFILE = who;
    sessionStorage.setItem('adminKey', ADMIN_KEY);
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadDashboard();
  } catch {
    document.getElementById('login-error').textContent = '관리자 키가 유효하지 않습니다';
    ADMIN_KEY = '';
  }
}

function logout() {
  sessionStorage.removeItem('adminKey');
  ADMIN_KEY = '';
  ADMIN_PROFILE = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
}

// Auto-login — URL ?key=... 우선, 이후 sessionStorage 복원. 인증 후 URL에서 key 즉시 제거.
(function init() {
  const params = new URLSearchParams(location.search);
  const urlKey = params.get('key');
  if (urlKey) {
    params.delete('key');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
  const saved = urlKey || sessionStorage.getItem('adminKey');
  if (saved) {
    ADMIN_KEY = saved;
    const el = document.getElementById('admin-key-input');
    if (el) el.value = saved;
    doLogin();
  }
  const inp = document.getElementById('admin-key-input');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
})();

// ── Navigation ──
document.querySelectorAll('.nav-item[data-page]').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    const page = el.dataset.page;
    document.getElementById('page-' + page).classList.add('active');
    if (page === 'dashboard') loadDashboard();
    if (page === 'participants') loadParticipants();
    if (page === 'responses') loadResponses();
  });
});

// ── API Helper ──
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(res.statusText);
  if (res.headers.get('content-type')?.includes('text/csv')) return res;
  return res.json();
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Dashboard ──
const CAT_COLORS = {
  '01.중앙정부': '#1d4ed8',
  '02.국책연구원': '#0ea5e9',
  '03.시도연구원': '#06b6d4',
  '04.공사·신탁': '#10b981',
  '05.광역지자체': '#3b82f6',
  '06.기초지자체': '#22c55e',
  '07.학계': '#f59e0b',
  '08.협회·학회': '#ec4899',
  '09.건축설계사무소': '#a855f7',
  '10.건설사·디벨로퍼': '#f97316',
  '11.부동산·도시운영': '#84cc16',
  '12.구조설계': '#14b8a6',
  '99.기타': '#6b7280',
  '미분류': '#d1d5db',
};

async function loadDashboard() {
  const data = await api('/api/admin/stats');
  const cats = data.by_category;

  document.getElementById('stat-cards').innerHTML = `
    <div class="stat-card"><div class="label">전체 대상자</div><div class="value">${data.total_participants}</div></div>
    <div class="stat-card"><div class="label">응답 완료</div><div class="value">${data.total_responses}</div></div>
    <div class="stat-card"><div class="label">응답률</div><div class="value">${data.total_participants ? (data.total_responses / data.total_participants * 100).toFixed(1) : 0}%</div></div>
  `;

  const order = Object.keys(cats).sort();
  document.getElementById('cat-bars').innerHTML = '<h3 style="font-size:14px;font-weight:600;margin-bottom:12px">구분별 응답 현황</h3>' +
    order.map(c => {
      const d = cats[c];
      const pct = d.participants ? (d.responded / d.participants * 100).toFixed(0) : 0;
      return `<div class="cat-row">
        <span class="cat-label">${c}</span>
        <div class="cat-track"><div class="cat-fill" style="width:${pct}%;background:${CAT_COLORS[c] || '#94a3b8'}"></div></div>
        <span class="cat-count">${d.responded} / ${d.participants} (${pct}%)</span>
      </div>`;
    }).join('');
}

// ── Participants & Email (통합) ──
let pPage = 0;
const P_LIMIT = 50;
let pCache = [];
let pSelected = new Set();
let pFilteredView = [];

function fmtKST(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(', ', ' ');
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금 전';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}일 전`;
  const mo = Math.floor(d / 30);
  return `${mo}개월 전`;
}

async function loadParticipants(page = 0) {
  pPage = page;
  const cat = document.getElementById('p-category').value;
  const params = new URLSearchParams({ skip: '0', limit: '5000' });
  if (cat) params.set('category', cat);
  const data = await api('/api/admin/participants?' + params.toString());
  pCache = data.data;
  pSelected.clear();
  renderParticipants();
}

function renderParticipants() {
  const page = pPage;
  const search = document.getElementById('p-search').value.trim().toLowerCase();
  const sendStatus = document.getElementById('p-send-status').value;
  const respStatus = document.getElementById('p-resp-status').value;

  pFilteredView = pCache.filter(p => {
    if (search && !(
      (p.name || '').toLowerCase().includes(search) ||
      (p.org || '').toLowerCase().includes(search) ||
      (p.email || '').toLowerCase().includes(search)
    )) return false;
    if (sendStatus === 'unsent' && p.email_sent) return false;
    if (sendStatus === 'sent' && !p.email_sent) return false;
    if (respStatus === 'responded' && !p.responded) return false;
    if (respStatus === 'unresponded' && p.responded) return false;
    return true;
  });

  const total = pFilteredView.length;
  const totalPages = Math.max(1, Math.ceil(total / P_LIMIT));
  if (page >= totalPages) { pPage = 0; }
  const rows = pFilteredView.slice(pPage * P_LIMIT, (pPage + 1) * P_LIMIT);

  const pageTokens = rows.map(r => r.token);
  const allChecked = rows.length > 0 && pageTokens.every(t => pSelected.has(t));

  document.getElementById('p-table').innerHTML = `<table>
    <thead><tr>
      <th class="checkbox-col"><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="togglePageSelect(this.checked)"></th>
      <th>이름</th><th>소속</th><th>구분</th><th>전문분야</th><th>이메일</th>
      <th>발송</th><th>응답</th><th>토큰</th><th></th>
    </tr></thead>
    <tbody>${rows.map(p => {
      const count = p.email_sent_count || 0;
      const lastAt = p.email_last_sent_at || p.email_sent_at;
      const lastStatus = p.email_last_status || (p.email_sent ? 'sent' : '');
      const lastType = p.email_last_type || '';
      const typeLabel = { invite: '초대', reminder: '추가요청', deadline: '마감알림', custom: '사용자', completion: '완료알림' }[lastType] || '';
      const sentTime = lastAt ? `${fmtKST(lastAt)}<br><span style="color:var(--text3);font-size:11px">${relTime(lastAt)}</span>` : '';

      let sendBadge;
      if (lastStatus === 'failed') {
        sendBadge = `<span class="badge badge-red">실패</span>` +
          (p.email_last_error ? `<div style="font-size:10px;color:#c00;margin-top:2px;max-width:160px;word-break:break-all">${(p.email_last_error || '').slice(0, 60)}</div>` : '');
      } else if (count > 0 || p.email_sent) {
        sendBadge = `<span class="badge badge-green">발송 ${count || 1}회</span>` +
          (typeLabel ? `<span style="font-size:10px;color:var(--text3);margin-left:4px">${typeLabel}</span>` : '') +
          `<div style="font-size:11px;color:var(--text3);margin-top:2px">${sentTime}</div>`;
      } else {
        sendBadge = '<span class="badge badge-gray">미발송</span>';
      }
      const logBtn = (count > 0 || lastStatus === 'failed')
        ? `<button class="btn-log" title="발송 이력" onclick="showEmailLogs('${p.token}', '${(p.name || '').replace(/'/g, "\\'")}')">📜</button>`
        : '';

      const respBadge = p.responded
        ? `<span class="badge badge-blue">응답</span><div style="font-size:11px;color:var(--text3);margin-top:2px">${fmtKST(p.response_submitted_at)}</div>`
        : ((count > 0 || p.email_sent) ? '<span class="badge badge-orange">미응답</span>' : '<span class="badge badge-gray">-</span>');
      const link = `${SURVEY_BASE}?token=${p.token}`;
      return `<tr>
        <td class="checkbox-col"><input type="checkbox" ${pSelected.has(p.token) ? 'checked' : ''} onchange="toggleRowSelect('${p.token}', this.checked)"></td>
        <td>${p.name || ''}</td>
        <td>${p.org || ''}</td>
        <td><span class="badge badge-blue">${p.category || ''}</span></td>
        <td style="font-size:11px;color:#555;max-width:160px">${p.field || ''}</td>
        <td style="font-size:12px">${p.email}</td>
        <td style="min-width:180px">${sendBadge} ${logBtn}</td>
        <td style="min-width:150px">${respBadge}</td>
        <td><code style="font-size:11px;cursor:pointer" title="클릭하여 링크 복사" onclick="navigator.clipboard.writeText('${link}');toast('링크 복사됨')">${p.token}</code></td>
        <td><button class="btn-log danger" title="삭제" onclick="deleteParticipant('${p.token}', '${(p.name || '').replace(/'/g, "\\'")}')">🗑</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;

  const pag = [];
  const btn = (i, label, disabled) => `<button class="btn btn-sm ${i === pPage ? 'btn-primary' : 'btn-outline'}"${disabled ? ' disabled' : ''} onclick="gotoPage(${i})">${label}</button>`;
  if (totalPages > 1) {
    pag.push(btn(0, '«', pPage === 0));
    pag.push(btn(Math.max(0, pPage - 1), '‹', pPage === 0));
    const start = Math.max(0, Math.min(pPage - 4, totalPages - 9));
    const end = Math.min(totalPages, start + 9);
    for (let i = start; i < end; i++) pag.push(btn(i, i + 1, false));
    pag.push(btn(Math.min(totalPages - 1, pPage + 1), '›', pPage >= totalPages - 1));
    pag.push(btn(totalPages - 1, '»', pPage >= totalPages - 1));
  }
  pag.push(`<span style="font-size:12px;color:var(--text3);margin-left:8px;align-self:center">${total}명${totalPages > 1 ? ` / ${totalPages}페이지` : ''} · 선택 ${pSelected.size}</span>`);
  document.getElementById('p-pagination').innerHTML = pag.join('');

  const sendBtn = document.getElementById('btn-send');
  sendBtn.disabled = pSelected.size === 0;
  sendBtn.textContent = `선택 발송 (${pSelected.size})`;

  const customBtn = document.getElementById('btn-custom-send');
  if (customBtn) {
    customBtn.disabled = pSelected.size === 0;
    customBtn.textContent = `자유 본문 발송 (${pSelected.size})`;
  }
}

function gotoPage(i) { pPage = i; renderParticipants(); }

function togglePageSelect(checked) {
  const page = pFilteredView.slice(pPage * P_LIMIT, (pPage + 1) * P_LIMIT);
  page.forEach(p => { checked ? pSelected.add(p.token) : pSelected.delete(p.token); });
  renderParticipants();
}

function toggleRowSelect(token, checked) {
  if (checked) pSelected.add(token); else pSelected.delete(token);
  renderParticipants();
}

document.getElementById('p-category').addEventListener('change', () => loadParticipants(0));
document.getElementById('p-search').addEventListener('input', () => { pPage = 0; renderParticipants(); });
document.getElementById('p-send-status').addEventListener('change', () => { pPage = 0; renderParticipants(); });
document.getElementById('p-resp-status').addEventListener('change', () => { pPage = 0; renderParticipants(); });

async function sendSelected() {
  if (pSelected.size === 0) return;
  const type = await promptEmailType(pSelected.size);
  if (!type) return;
  await runSend([...pSelected], type);
}

async function sendToUnresponded() {
  const targets = pFilteredView.filter(p => (p.email_sent_count || 0) > 0 || p.email_sent).filter(p => !p.responded).map(p => p.token);
  if (targets.length === 0) { toast('현재 뷰에 미응답 대상이 없습니다', 'error'); return; }
  if (!confirm(`현재 필터에 해당하는 미응답자 ${targets.length}명에게 추가 요청 메일을 발송합니다. 계속할까요?`)) return;
  await runSend(targets, 'reminder');
}

function promptEmailType(count) {
  return new Promise((resolve) => {
    const typeLabels = {
      invite: '① 초대 (invite)',
      reminder: '② 추가 요청 (reminder)',
      deadline: '③ 마감 알림 (deadline)',
    };
    const msg = `${count}명에게 이메일을 발송합니다.\n\n` +
      `발송 타입을 선택하세요:\n` +
      `  1 = 초대 (최초 발송)\n` +
      `  2 = 추가 요청 (리마인더)\n` +
      `  3 = 마감 알림\n\n` +
      `번호 입력 (취소하려면 빈 값):`;
    const input = prompt(msg, '1');
    if (!input) return resolve(null);
    const map = { '1': 'invite', '2': 'reminder', '3': 'deadline' };
    const type = map[input.trim()] || null;
    if (!type) { toast('잘못된 입력', 'error'); return resolve(null); }
    if (!confirm(`${typeLabels[type]} 타입으로 ${count}명에게 발송합니다. 계속할까요?`)) return resolve(null);
    resolve(type);
  });
}

async function runSend(tokens, type = 'invite') {
  const btn = document.getElementById('btn-send');
  btn.disabled = true;
  btn.textContent = `발송 중 (${tokens.length})...`;
  try {
    const result = await api('/api/admin/email/send', {
      method: 'POST',
      body: JSON.stringify({ tokens, type }),
    });
    showSendResult(result);
    await loadParticipants(pPage);
  } catch (e) {
    toast('발송 실패: ' + e.message, 'error');
  }
}

function showSendResult(result) {
  const errors = result.errors || [];
  const headline = `발송 완료 [${result.type}]: ${result.sent}건 성공${result.failed ? `, ${result.failed}건 실패` : ''}${result.skipped ? `, ${result.skipped}건 누락(존재하지 않는 토큰)` : ''}`;
  if (result.failed === 0 && result.skipped === 0) {
    toast(headline);
    return;
  }
  const errRows = errors.map(e =>
    `<tr><td style="font-size:11px;font-family:monospace">${e.token}</td>
         <td style="font-size:12px">${e.email}</td>
         <td style="font-size:11px;color:#c00;word-break:break-all">${(e.error || '').slice(0, 200)}</td></tr>`
  ).join('');
  const body = `
    <div style="padding:14px 18px">
      <p style="margin:0 0 12px;font-size:14px"><b>${headline}</b></p>
      <p style="margin:0 0 8px;font-size:12px;color:#666">batch: <code>${result.batch_id}</code> · subject: ${result.subject || ''}</p>
      ${errRows ? `<table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f3f4f6"><th style="text-align:left;padding:6px 8px;font-size:12px">토큰</th><th style="text-align:left;padding:6px 8px;font-size:12px">이메일</th><th style="text-align:left;padding:6px 8px;font-size:12px">오류</th></tr></thead>
        <tbody>${errRows}</tbody>
      </table>` : ''}
    </div>`;
  document.getElementById('log-modal-title').textContent = '발송 결과';
  document.getElementById('log-modal-body').innerHTML = body;
  document.getElementById('log-modal').style.display = 'flex';
}

// ── Email Log Modal ──
async function showEmailLogs(token, name) {
  try {
    const data = await api(`/api/admin/email/logs?token=${encodeURIComponent(token)}&limit=100`);
    const logs = data.data || [];
    const typeLabels = { invite: '초대', reminder: '추가요청', deadline: '마감알림', custom: '사용자', completion: '완료알림' };

    const rows = logs.map(l => {
      const statusBadge = l.status === 'sent'
        ? '<span class="badge badge-green">성공</span>'
        : '<span class="badge badge-red">실패</span>';
      return `<tr>
        <td style="font-size:11px">${fmtKST(l.sent_at)}<br><span style="color:var(--text3);font-size:10px">${relTime(l.sent_at)}</span></td>
        <td>${statusBadge}</td>
        <td><span class="badge badge-blue">${typeLabels[l.type] || l.type || '-'}</span></td>
        <td style="font-size:11px">${l.subject || ''}</td>
        <td style="font-size:11px">${l.admin_name || l.admin_email || ''}</td>
        <td style="font-size:10px;color:#c00;max-width:240px;word-break:break-all">${l.error || ''}</td>
      </tr>`;
    }).join('');

    const body = logs.length === 0
      ? '<p style="text-align:center;color:var(--text3);padding:40px">이력이 없습니다.</p>'
      : `<table class="log-table">
          <thead><tr><th>시각</th><th>상태</th><th>타입</th><th>제목</th><th>발송자</th><th>오류</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;

    document.getElementById('log-modal-title').textContent = `이메일 발송 이력 — ${name} (${logs.length}건)`;
    document.getElementById('log-modal-body').innerHTML = body;
    document.getElementById('log-modal').style.display = 'flex';
  } catch (e) {
    toast('이력 조회 실패: ' + e.message, 'error');
  }
}

function closeLogModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('log-modal').style.display = 'none';
}

function exportParticipantLinks() {
  const rows = [['name', 'email', 'org', 'category', 'field', 'phone', 'token', 'email_sent_count', 'email_last_sent_at_kst', 'responded', 'survey_link']];
  pCache.forEach(p => {
    rows.push([p.name, p.email, p.org || '', p.category || '', p.field || '', p.phone || '', p.token,
      p.email_sent_count || 0,
      p.email_last_sent_at ? fmtKST(p.email_last_sent_at) : (p.email_sent_at ? fmtKST(p.email_sent_at) : ''),
      p.responded ? 'Y' : 'N',
      `${SURVEY_BASE}?token=${p.token}`]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'participants_links.csv';
  a.click();
}

// \u2500\u2500 \ub300\uc0c1\uc790 \ucd94\uac00/\uc0ad\uc81c \u2500\u2500
function openAddParticipant() {
  ['add-name','add-email','add-org','add-field','add-phone'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const cat = document.getElementById('add-category'); if (cat) cat.value = '';
  document.getElementById('add-error').textContent = '';
  document.getElementById('add-modal').style.display = 'flex';
}

function closeAddParticipant(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('add-modal').style.display = 'none';
}

async function submitAddParticipant() {
  const errEl = document.getElementById('add-error');
  errEl.textContent = '';
  const payload = {
    name: document.getElementById('add-name').value.trim(),
    email: document.getElementById('add-email').value.trim(),
    org: document.getElementById('add-org').value.trim(),
    field: document.getElementById('add-field').value.trim(),
    phone: document.getElementById('add-phone').value.trim(),
    category: document.getElementById('add-category').value,
  };
  if (!payload.email) { errEl.textContent = '\uc774\uba54\uc77c\uc740 \ud544\uc218\uc785\ub2c8\ub2e4.'; return; }
  if (!payload.name) { errEl.textContent = '\uc774\ub984\uc744 \uc785\ub825\ud574 \uc8fc\uc2ed\uc2dc\uc624.'; return; }
  try {
    await api('/api/admin/participants', { method: 'POST', body: JSON.stringify(payload) });
    toast('\ub300\uc0c1\uc790 \ucd94\uac00 \uc644\ub8cc');
    closeAddParticipant();
    await loadParticipants(0);
  } catch (e) {
    errEl.textContent = '\ucd94\uac00 \uc2e4\ud328: ' + e.message;
  }
}

async function deleteParticipant(token, name) {
  if (!confirm(`"${name}" \ub300\uc0c1\uc790\ub97c \uc0ad\uc81c\ud569\ub2c8\ub2e4.\n\uc751\ub2f5 \ub370\uc774\ud130\ub294 \uadf8\ub300\ub85c \ubcf4\uc874\ub418\uc9c0\ub9cc \ud1a0\ud070\uc740 \ub354 \uc774\uc0c1 \ub3d9\uc791\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4. \uacc4\uc18d\ud560\uae4c\uc694?`)) return;
  try {
    await api(`/api/admin/participants/${encodeURIComponent(token)}`, { method: 'DELETE' });
    toast('\uc0ad\uc81c\ub428');
    await loadParticipants(pPage);
  } catch (e) {
    toast('\uc0ad\uc81c \uc2e4\ud328: ' + e.message, 'error');
  }
}

// \u2500\u2500 Custom Email Compose (\uc790\uc720 \ubcf8\ubb38 \ubc1c\uc1a1) \u2500\u2500
function openCustomCompose() {
  if (pSelected.size === 0) {
    toast('\ub300\uc0c1\uc790\ub97c \uba3c\uc800 \uc120\ud0dd\ud574 \uc8fc\uc2ed\uc2dc\uc624.', 'error');
    return;
  }
  const tokens = [...pSelected];
  const recipients = pCache.filter(p => tokens.includes(p.token));
  document.getElementById('custom-recipient-count').textContent = String(recipients.length);
  document.getElementById('custom-recipients-preview').innerHTML =
    recipients.slice(0, 50).map(p =>
      `<div>\u00b7 ${p.name} (${p.email}) \u2014 ${p.org || ''}</div>`
    ).join('') + (recipients.length > 50 ? `<div style="margin-top:4px;color:#999">\u2026 \uc678 ${recipients.length - 50}\uba85</div>` : '');
  document.getElementById('custom-error').textContent = '';
  document.getElementById('custom-modal').style.display = 'flex';
}

function closeCustomCompose(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('custom-modal').style.display = 'none';
}

async function customPreview() {
  const subject = document.getElementById('custom-subject').value.trim();
  const body_html = document.getElementById('custom-body').value;
  if (!body_html.trim()) {
    document.getElementById('custom-error').textContent = '\ubcf8\ubb38\uc744 \uc785\ub825\ud574 \uc8fc\uc2ed\uc2dc\uc624.';
    return;
  }
  const tokens = [...pSelected];
  try {
    const res = await fetch(API + '/api/admin/email/custom-preview', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens, subject, body_html }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const sampleBase = tokens.length > 0
      ? `\uc120\ud0dd\ub41c \uccab \ub300\uc0c1\uc790 (${pCache.find(p => p.token === tokens[0])?.name || tokens[0]})`
      : '\uc0d8\ud50c (\ud64d\uae38\ub3d9/\uc608\uc2dc \uae30\uad00)';
    const meta = `<div style="padding:10px 14px;font-size:12px;color:#444;background:#f9fafb;border-bottom:1px solid #eee">
        <div><b>\ud0c0\uc785</b>: \uc790\uc720 \ubcf8\ubb38 (custom)</div>
        <div><b>\uc81c\ubaa9</b>: ${subject || '<span style="color:#c00">(\ubbf8\uc785\ub825)</span>'}</div>
        <div><b>\uce58\ud658 \uae30\uc900</b>: ${sampleBase}</div>
      </div>`;
    document.getElementById('preview-body').innerHTML =
      meta + `<iframe srcdoc="${html.replace(/"/g, '&quot;')}" style="width:100%;height:70vh;border:0;background:#fff"></iframe>`;
    document.getElementById('preview-modal').style.display = 'flex';
  } catch (e) {
    document.getElementById('custom-error').textContent = '\ubbf8\ub9ac\ubcf4\uae30 \uc2e4\ud328: ' + e.message;
  }
}

async function customSend() {
  const subject = document.getElementById('custom-subject').value.trim();
  const body_html = document.getElementById('custom-body').value;
  const errEl = document.getElementById('custom-error');
  errEl.textContent = '';
  if (!subject) { errEl.textContent = '\uc81c\ubaa9\uc744 \uc785\ub825\ud574 \uc8fc\uc2ed\uc2dc\uc624.'; return; }
  if (!body_html.trim()) { errEl.textContent = '\ubcf8\ubb38\uc744 \uc785\ub825\ud574 \uc8fc\uc2ed\uc2dc\uc624.'; return; }
  const tokens = [...pSelected];
  if (tokens.length === 0) { errEl.textContent = '\uc218\uc2e0\uc790\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.'; return; }
  if (!confirm(`${tokens.length}\uba85\uc5d0\uac8c \uc790\uc720 \ubcf8\ubb38 \uba54\uc77c\uc744 \ubc1c\uc1a1\ud569\ub2c8\ub2e4.\n\uc81c\ubaa9: ${subject}\n\uacc4\uc18d\ud560\uae4c\uc694?`)) return;

  try {
    const result = await api('/api/admin/email/custom-send', {
      method: 'POST',
      body: JSON.stringify({ tokens, subject, body_html }),
    });
    closeCustomCompose();
    showSendResult({ ...result, subject });
    await loadParticipants(pPage);
  } catch (e) {
    errEl.textContent = '\ubc1c\uc1a1 \uc2e4\ud328: ' + e.message;
  }
}

// ── Email Preview Modal ──
const TYPE_LABEL = { invite: '① 초대 (invite)', reminder: '② 추가요청 (reminder)', deadline: '③ 마감알림 (deadline)' };

async function previewEmail() {
  // 첫 번째 선택된 토큰 기준으로 (없으면 샘플) + type별 미리보기 (선택)
  const firstSelected = pSelected.size > 0 ? [...pSelected][0] : null;
  let chosenType = 'invite';
  if (pSelected.size > 0) {
    const t = prompt(
      '미리볼 메일 타입을 선택하세요\n' +
      '  1 = 초대 (invite)\n' +
      '  2 = 추가요청 (reminder)\n' +
      '  3 = 마감알림 (deadline)\n\n' +
      '취소하려면 빈 값',
      '1'
    );
    if (!t) return;
    chosenType = ({ '1': 'invite', '2': 'reminder', '3': 'deadline' })[t.trim()] || 'invite';
  }
  try {
    const params = new URLSearchParams({ type: chosenType });
    if (firstSelected) params.set('token', firstSelected);
    const res = await fetch(API + '/api/admin/email/preview?' + params.toString(), {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const subjectGuess = {
      invite: '[AURI] 소규모(비아파트) 주거 제도개선 전문가 설문 참여 요청',
      reminder: '[AURI] 소규모 주거 전문가 설문 응답 추가 요청 (미응답자 재안내)',
      deadline: '[AURI] 소규모 주거 전문가 설문 — 마감 임박 안내',
    }[chosenType];
    const meta = `<div style="padding:10px 14px;font-size:12px;color:#444;background:#f9fafb;border-bottom:1px solid #eee">
        <div><b>타입</b>: ${TYPE_LABEL[chosenType] || chosenType}</div>
        <div><b>예상 제목</b>: ${subjectGuess}</div>
        <div><b>치환 기준</b>: ${firstSelected ? '선택된 첫 대상자' : '샘플 (홍길동/예시 기관)'}</div>
      </div>`;
    document.getElementById('preview-body').innerHTML =
      meta + `<iframe srcdoc="${html.replace(/"/g, '&quot;')}" style="width:100%;height:70vh;border:0;background:#fff"></iframe>`;
    document.getElementById('preview-modal').style.display = 'flex';
  } catch (e) {
    toast('미리보기 실패: ' + e.message, 'error');
  }
}

function closePreview(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('preview-modal').style.display = 'none';
  document.getElementById('preview-body').innerHTML = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('preview-modal').style.display === 'flex') {
    closePreview();
  }
});

// ── Responses ──
let rCache = [];
async function loadResponses() {
  const cat = document.getElementById('r-category').value;
  const params = new URLSearchParams({ skip: '0', limit: '200' });
  if (cat) params.set('category', cat);
  const data = await api('/api/admin/responses?' + params.toString());
  rCache = data.data;

  document.getElementById('r-table').innerHTML = `<table>
    <thead><tr><th>이름</th><th>소속</th><th>구분</th><th>전문분야</th><th>제출일시</th><th>수정일시</th><th>상세</th></tr></thead>
    <tbody>${rCache.map(r => {
      return `<tr>
        <td>${r.name || ''}</td>
        <td>${r.org || ''}</td>
        <td><span class="badge badge-blue">${r.category || ''}</span></td>
        <td style="font-size:11px;color:#555">${r.field || ''}</td>
        <td style="font-size:12px">${r.submitted_at ? new Date(r.submitted_at).toLocaleString('ko') : ''}</td>
        <td style="font-size:12px">${r.updated_at ? new Date(r.updated_at).toLocaleString('ko') : '-'}</td>
        <td><button class="btn btn-sm btn-outline" onclick="showResponseDetail('${r.token}')">열기</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── Response Detail Modal ──
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatAnswer(q, val, allResp) {
  if (val === undefined || val === null || val === '') {
    return '<span style="color:var(--text3)">(무응답)</span>';
  }
  const QT = window.Q_TYPE || {};
  if (q.type === QT.SINGLE || q.type === QT.SINGLE_WITH_OTHER) {
    if (val === 'other') {
      const other = allResp[q.id + '_other'] || '';
      return `<span class="badge badge-blue">기타</span> <span>${escapeHtml(other)}</span>`;
    }
    const idx = typeof val === 'number' ? val : parseInt(val, 10);
    const opt = q.options?.[idx];
    return opt ? `<span>${escapeHtml(opt)}</span> <code style="color:var(--text3);font-size:11px">(${idx})</code>` : `<code>${escapeHtml(String(val))}</code>`;
  }
  if ([QT.MULTI, QT.MULTI_WITH_OTHER, QT.MULTI_LIMIT, QT.MULTI_LIMIT_OTHER].includes(q.type)) {
    if (!Array.isArray(val)) return `<code>${escapeHtml(JSON.stringify(val))}</code>`;
    const parts = val.map(v => {
      if (v === 'other') {
        const other = allResp[q.id + '_other'] || '';
        return `<span class="chip chip-other">기타: ${escapeHtml(other)}</span>`;
      }
      const idx = typeof v === 'number' ? v : parseInt(v, 10);
      const opt = q.options?.[idx];
      return `<span class="chip">${escapeHtml(opt || String(v))}</span>`;
    });
    return parts.join(' ');
  }
  if (q.type === QT.NUMBER_TABLE) {
    if (typeof val !== 'object') return `<code>${escapeHtml(JSON.stringify(val))}</code>`;
    const fmt = (n) => new Intl.NumberFormat('ko').format(Number(n) || 0);
    const rows = q.rows.map(r => {
      const rv = val[r.id];
      if (rv === 'unknown') {
        return `<tr><td>${escapeHtml(r.label)}</td><td colspan="${q.columns.length + 1}" style="color:var(--text3);font-style:italic">모름/해당없음</td></tr>`;
      }
      if (!rv || typeof rv !== 'object') {
        return `<tr><td>${escapeHtml(r.label)}</td><td colspan="${q.columns.length + 1}" style="color:var(--text3)">(무응답)</td></tr>`;
      }
      const cells = q.columns.map(c => `<td style="text-align:right">${fmt(rv[c.id])}</td>`).join('');
      const sum = q.columns.reduce((a, c) => a + (Number(rv[c.id]) || 0), 0);
      return `<tr><td>${escapeHtml(r.label)}</td>${cells}<td style="text-align:right;font-weight:600">${fmt(sum)}</td></tr>`;
    }).join('');
    const header = `<tr><th>연도</th>${q.columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}<th>합계</th></tr>`;
    return `<table class="inline-number"><thead>${header}</thead><tbody>${rows}</tbody></table>` +
      (q.unit ? `<div style="font-size:11px;color:var(--text3);margin-top:4px">단위: ${escapeHtml(q.unit)}</div>` : '');
  }
  if (q.type === QT.LIKERT_TABLE) {
    if (typeof val !== 'object') return `<code>${escapeHtml(JSON.stringify(val))}</code>`;
    const rows = q.items.map((item, i) => {
      const v = val[i];
      const label = v ? (q.scaleLabels?.[v - 1] || v) : '(무응답)';
      return `<tr><td style="font-size:12px">${escapeHtml(item)}</td><td><strong>${escapeHtml(String(label))}</strong></td></tr>`;
    });
    return `<table class="inline-likert"><tbody>${rows.join('')}</tbody></table>`;
  }
  if (q.type === QT.TEXT) {
    return `<div class="response-text">${escapeHtml(String(val)).replace(/\n/g, '<br>')}</div>`;
  }
  return `<code>${escapeHtml(JSON.stringify(val))}</code>`;
}

async function showResponseDetail(token) {
  const row = rCache.find(r => r.token === token);
  if (!row) { toast('응답을 찾을 수 없습니다', 'error'); return; }
  const respMap = row.responses || {};
  const sections = window.SURVEY_SECTIONS;
  const QT = window.Q_TYPE || {};

  const meta = `
    <div class="resp-meta">
      <dl>
        <dt>응답자</dt><dd>${escapeHtml(row.name || '-')}${row.email ? ` <span style="color:#888;font-size:11px">(${escapeHtml(row.email)})</span>` : ''}</dd>
        <dt>소속</dt><dd>${escapeHtml(row.org || '-')}</dd>
        <dt>구분</dt><dd><span class="badge badge-blue">${escapeHtml(row.category || '-')}</span></dd>
        ${row.field ? `<dt>전문분야</dt><dd>${escapeHtml(row.field)}</dd>` : ''}
        <dt>토큰</dt><dd><code style="font-size:11px">${escapeHtml(token)}</code></dd>
        <dt>설문 버전</dt><dd>${escapeHtml(row.survey_version || '-')}</dd>
        <dt>제출</dt><dd style="font-size:12px">${row.submitted_at ? new Date(row.submitted_at).toLocaleString('ko') : '-'}</dd>
        ${row.updated_at ? `<dt>수정</dt><dd style="font-size:12px">${new Date(row.updated_at).toLocaleString('ko')}</dd>` : ''}
      </dl>
    </div>
  `;

  let body;
  if (!sections) {
    body = `<p style="color:#c00;font-size:12px;margin-bottom:8px">(questions.js 스키마 미로드 — raw JSON으로 표시합니다)</p>
            <pre style="white-space:pre-wrap;font-size:11px;background:#f9fafb;padding:12px;border-radius:6px">${escapeHtml(JSON.stringify(respMap, null, 2))}</pre>`;
  } else {
    const items = [];
    for (const s of sections) {
      items.push(`<h3 class="resp-section">${escapeHtml(s.title)}</h3>`);
      for (const q of s.questions) {
        if (q.type === QT.SUB_QUESTIONS) {
          items.push(`<div class="resp-q"><div class="resp-q-id">${q.id}</div><div class="resp-q-text">${escapeHtml(q.text)}</div>`);
          for (const sq of q.subQuestions) {
            const v = respMap[sq.id];
            items.push(`<div class="resp-sub"><span class="resp-sub-label">${escapeHtml(sq.label)}</span> ${formatAnswer(sq, v, respMap)}</div>`);
          }
          items.push(`</div>`);
        } else {
          const v = respMap[q.id];
          items.push(`<div class="resp-q"><div class="resp-q-id">${q.id}</div><div class="resp-q-text">${escapeHtml(q.text)}</div><div class="resp-a">${formatAnswer(q, v, respMap)}</div></div>`);
        }
      }
    }
    body = items.join('');
  }

  document.getElementById('resp-modal-title').textContent = `응답 상세 — ${row.name || ''} (${row.org || ''})`;
  document.getElementById('resp-modal-body').innerHTML = meta + body;
  document.getElementById('resp-modal').style.display = 'flex';
}

function closeRespModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('resp-modal').style.display = 'none';
}

async function downloadCSV() {
  try {
    const res = await fetch(API + '/api/admin/export', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    if (!res.ok) throw new Error('No data');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'survey_responses.csv';
    a.click();
    toast('CSV 다운로드 완료');
  } catch (e) {
    toast('다운로드 실패 (응답 데이터 없음)', 'error');
  }
}
