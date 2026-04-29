import { sections, Q_TYPE, SURVEY_META, REWARD_CONSENT_NOTICE } from './questions.js';

const STORAGE_KEY = 'auri_survey_responses';
const STORAGE_PAGE_KEY = 'auri_survey_page';
const API_BASE = import.meta.env.VITE_API_BASE || '';

const GATE = {
  LOADING: 'loading',
  DENIED: 'denied',
  RESUBMIT_CHOICE: 'resubmit_choice',
  READ_ONLY: 'read_only',
  OPEN: 'open',
  REGISTER: 'register',                  // 토큰 없는 공개 진입 — 자가등록 폼
  ALREADY_RESPONDED: 'already_responded', // 자가등록 시도 시 이메일 dedup → 이미 응답 완료
  CLOSED: 'closed',                      // 사례품 정원 도달 — 신규 진입 차단 안내
};

const SURVEY_LIMIT = 300;

const REGISTER_DRAFT_KEY = 'auri_small_housing_register_draft';
// 자가등록 시 받는 전문분야 옵션 — questions.js의 SQ1과 동일하게 유지.
const SELF_REG_CATEGORIES = [
  '학계',
  '연구기관',
  '중앙부처·지자체·공공기관',
  '건설·개발·금융업계',
  '건축·설계·감리',
  '기타',
];

const EDIT_MODE = {
  NEW: 'new',
  EDIT: 'edit',
};

export class SurveyEngine {
  constructor(container) {
    this.container = container;
    const urlParams = new URLSearchParams(window.location.search);
    this.token = urlParams.get('token');
    // 자가등록 직후 토큰 URL로 이동했을 때 1회 표시되는 북마크 안내 플래그
    this.justRegistered = urlParams.get('just_registered') === '1';
    // 직원 테스트 모드: ?source=staff 진입 시 분석 제외 마커 부여 (등록 후 redirect URL에도 유지).
    this.isStaffMode = urlParams.get('source') === 'staff';
    this.participant = null;
    this.submitted = false;
    this.submittedAt = null;
    this.updatedAt = null;
    this.editMode = EDIT_MODE.NEW;
    this.gate = this.token ? GATE.LOADING : GATE.REGISTER;
    this.responses = this.loadResponses();
    this.currentPage = 0;
    this.visibleSections = [];
    this.editingParticipant = false;
    this.participantFormError = '';
    // 자가등록(GATE.REGISTER) 상태
    this.regDraft = this.loadRegisterDraft();
    this.regError = '';
    this.regSubmitting = false;
    this.alreadyRespondedReviewUrl = '';   // ALREADY_RESPONDED 화면에서 사용
    this.surveyStatus = null;              // { completed, limit, is_closed } — fetchSurveyStatus 결과

    if (this.token) {
      this.verifyToken().then(() => this.render());
    } else {
      // 토큰 없는 공개 진입은 자가등록 페이지를 그리기 전에 마감 여부를 확인한다.
      // 직원 테스트(`?source=staff`)는 마감과 무관하게 항상 등록 가능 — fetch 자체를 건너뜀.
      if (this.isStaffMode) {
        this.render();
      } else {
        this.fetchSurveyStatus().finally(() => this.render());
      }
    }
  }

  async fetchSurveyStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/survey/status`);
      if (!res.ok) return;
      const data = await res.json();
      this.surveyStatus = data;
      if (data.is_closed) this.gate = GATE.CLOSED;
    } catch { /* 네트워크 실패 시에는 정상 등록 페이지로 fallback */ }
  }

  // ── Register Draft (자가등록 임시저장) ──
  loadRegisterDraft() {
    try {
      const saved = localStorage.getItem(REGISTER_DRAFT_KEY);
      return saved ? JSON.parse(saved) : { email: '', name: '', org: '', category: '', consent_pi: false };
    } catch { return { email: '', name: '', org: '', category: '', consent_pi: false }; }
  }
  saveRegisterDraft() {
    localStorage.setItem(REGISTER_DRAFT_KEY, JSON.stringify(this.regDraft));
  }
  clearRegisterDraft() {
    localStorage.removeItem(REGISTER_DRAFT_KEY);
  }

  async verifyToken() {
    try {
      const res = await fetch(`${API_BASE}/api/survey/${this.token}`);
      if (res.status === 410) {
        // 마감 — 미응답자가 토큰 링크로 들어왔거나, 백엔드가 마감 차단을 응답
        this.gate = GATE.CLOSED;
        return;
      }
      if (!res.ok) {
        this.gate = GATE.DENIED;
        return;
      }
      const data = await res.json();
      this.participant = data;
      this.submittedAt = data.submitted_at || null;
      this.updatedAt = data.updated_at || null;
      if (data.has_responded && data.responses) {
        this.responses = { ...this.responses, ...data.responses };
        this.saveResponses();
        this.submitted = true;
        this.gate = GATE.RESUBMIT_CHOICE;
      } else {
        this.gate = GATE.OPEN;
      }
    } catch {
      this.gate = GATE.DENIED;
    }
  }

  // ── Persistence ──
  loadResponses() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  }

  saveResponses() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.responses));
    localStorage.setItem(STORAGE_PAGE_KEY, String(this.currentPage));
  }

  getResponse(id) { return this.responses[id]; }
  setResponse(id, value) {
    this.responses[id] = value;
    this.saveResponses();
  }

  // ── Section Visibility (branching) ──
  updateVisibleSections() {
    const q6 = this.responses['Q6'];
    this.visibleSections = sections.filter(s => {
      if (!s.showWhen) return true;
      return q6 !== undefined && q6 === s.showWhen.value;
    });
  }

  // ── Question-level Visibility (branching) ──
  isQuestionVisible(q) {
    if (!q.showWhen) return true;
    const depVal = this.responses[q.showWhen.questionId];
    if (depVal === undefined) return false;
    if (Array.isArray(q.showWhen.valueIn)) return q.showWhen.valueIn.includes(depVal);
    if (q.showWhen.value !== undefined) return depVal === q.showWhen.value;
    if (q.showWhen.equals !== undefined) return depVal === q.showWhen.equals;
    return true;
  }

  // ── Render Router ──
  render() {
    if (this.gate === GATE.LOADING) {
      this.renderLoading();
      return;
    }
    if (this.gate === GATE.CLOSED) {
      this.renderClosed();
      return;
    }
    if (this.gate === GATE.DENIED) {
      this.renderAccessDenied();
      return;
    }
    if (this.gate === GATE.REGISTER) {
      this.renderRegister();
      return;
    }
    if (this.gate === GATE.ALREADY_RESPONDED) {
      this.renderAlreadyResponded();
      return;
    }
    if (this.gate === GATE.RESUBMIT_CHOICE) {
      this.renderResubmitChoice();
      return;
    }

    this.updateVisibleSections();
    if (this.currentPage === 0) {
      this.renderIntro();
    } else if (this.currentPage > this.visibleSections.length) {
      this.renderCompletion();
    } else {
      this.renderSection(this.visibleSections[this.currentPage - 1]);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Loading ──
  renderLoading() {
    this.container.innerHTML = `
      <div class="survey-container">
        <div class="completion" style="padding:160px 20px">
          <div class="spinner"></div>
          <style>@keyframes spin{to{transform:rotate(360deg)}}.spinner{width:40px;height:40px;border:3px solid #e0e0e0;border-top:3px solid #2c2c2c;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 24px}</style>
          <p style="color:var(--c-text-secondary)">설문 링크를 확인 중입니다…</p>
        </div>
      </div>
    `;
  }

  // ── Closed (사례품 정원 도달 — 신규 진입 차단) ──
  renderClosed() {
    const m = SURVEY_META;
    const completed = this.surveyStatus?.completed ?? SURVEY_LIMIT;
    this.container.innerHTML = `
      <div class="survey-container">
        <div class="register-shell">
          <div class="register-institution">${m.institution}</div>
          <h1 class="register-title">설문이 마감되었습니다</h1>
          <div class="register-card" style="text-align:center;padding:40px 24px">
            <p style="font-size:16px;line-height:1.8;margin:0 0 12px">
              목표 응답 <strong>${SURVEY_LIMIT}부</strong>가 모두 채워져 추가 응답을 받지 않습니다.
            </p>
            <p style="color:var(--c-text-secondary);margin:0 0 16px">
              현재 완료 응답: <strong>${completed}부</strong>
            </p>
            <p style="font-size:15px;color:var(--c-text-secondary);margin:0;line-height:1.7">
              본 조사에 관심 가져 주셔서 진심으로 감사드립니다.<br>
              결과 활용 및 후속 안내는 추후 별도 공지를 통해 알려드리겠습니다.
            </p>
            <p style="font-size:13px;color:var(--c-text-tertiary);margin:24px 0 0;line-height:1.7">
              이미 응답을 제출하신 경우, 받으신 안내 메일의 링크로 본인 응답을 확인·수정하실 수 있습니다.
            </p>
          </div>
          <div class="register-meta">
            <dl>
              <dt>조사기관</dt><dd>${m.institution}</dd>
              <dt>연구책임</dt><dd>${m.researcher}</dd>
              <dt>담당</dt><dd>${m.contactName} (${m.contact})</dd>
            </dl>
          </div>
        </div>
      </div>
    `;
  }

  // ── Access Denied ──
  renderAccessDenied() {
    const m = SURVEY_META;
    this.container.innerHTML = `
      <div class="survey-container">
        <div class="access-denied">
          <div class="access-denied-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="12" cy="12" r="9"></circle>
              <line x1="5.6" y1="5.6" x2="18.4" y2="18.4"></line>
            </svg>
          </div>
          <h1>접근 권한이 없습니다</h1>
          <p class="access-denied-msg">
            본 설문은 사전에 발송된 개별 링크를 통해서만 참여할 수 있습니다.<br/>
            이메일로 수신한 링크를 다시 확인하시거나, 아래 연락처로 문의해 주십시오.
          </p>
          <div class="access-denied-meta">
            <dl>
              <dt>조사기관</dt><dd>${m.institution}</dd>
              <dt>연구책임</dt><dd>${m.researcher}</dd>
              <dt>담당</dt><dd>${m.contactName} (${m.contact})</dd>
            </dl>
          </div>
        </div>
      </div>
    `;
  }

  // ── Resubmit Choice (이미 제출한 토큰 재접근) ──
  renderResubmitChoice() {
    const p = this.participant || {};
    const submittedStr = this.submittedAt ? this.formatDateTime(this.submittedAt) : '';
    const updatedStr = this.updatedAt ? this.formatDateTime(this.updatedAt) : '';

    this.container.innerHTML = `
      <div class="survey-container">
        <div class="resubmit-choice">
          <div class="resubmit-badge">제출 완료</div>
          <h1>이미 응답을 제출하셨습니다</h1>
          <div class="resubmit-meta">
            <dl>
              <dt>응답자</dt><dd>${this.escape(p.name || '-')}${p.org ? ` · ${this.escape(p.org)}` : ''}</dd>
              <dt>최초 제출</dt><dd>${submittedStr || '-'}</dd>
              ${updatedStr ? `<dt>최근 수정</dt><dd>${updatedStr}</dd>` : ''}
            </dl>
          </div>
          <p class="resubmit-msg">
            응답 내용을 <strong>수정</strong>하시거나, 제출한 응답을 <strong>확인</strong>만 하실 수 있습니다.
          </p>
          <div class="resubmit-actions">
            <button class="btn btn-next" id="btn-edit-mode">응답 수정하기</button>
            <button class="btn btn-prev" id="btn-view-mode">내 응답 확인 (읽기전용)</button>
          </div>
        </div>
      </div>
    `;
    this.container.querySelector('#btn-edit-mode').addEventListener('click', () => {
      this.editMode = EDIT_MODE.EDIT;
      this.gate = GATE.OPEN;
      this.currentPage = 0;
      this.render();
    });
    this.container.querySelector('#btn-view-mode').addEventListener('click', () => {
      this.gate = GATE.READ_ONLY;
      this.render();
    });
  }

  // ── Register (공개 자가등록 폼) ──
  renderRegister() {
    const m = SURVEY_META;
    const d = this.regDraft;
    const errHtml = this.regError ? `<p class="register-error">${this.escape(this.regError)}</p>` : '';
    const submitting = this.regSubmitting ? '<span class="register-submitting">등록 중…</span>' : '';
    const catOptions = SELF_REG_CATEGORIES.map(c => {
      const sel = (d.category === c) ? 'selected' : '';
      return `<option value="${this.escape(c)}" ${sel}>${this.escape(c)}</option>`;
    }).join('');

    const staffBanner = this.isStaffMode ? `
      <div class="register-card" style="background:#fef3c7;border-color:#fcd34d">
        <p style="margin:0;color:#92400e;font-weight:500;font-size:13px;line-height:1.7">
          🧪 <strong>직원 테스트 모드</strong> — 이 링크로 등록한 응답은
          <strong>분석·통계·사례품 발송 대상에서 자동 제외</strong>됩니다. 일반 응답자는 본 링크로 진입하지 마세요.
        </p>
      </div>
    ` : '';

    this.container.innerHTML = `
      <div class="survey-container">
        <div class="register-shell">
          <div class="register-institution">${m.institution}</div>
          <h1 class="register-title">${m.title}</h1>
          <div class="register-subtitle">${m.subtitle}</div>

          ${staffBanner}

          <div class="register-card">
            <h3>본 설문 안내</h3>
            <p style="font-size:13px;line-height:1.7;color:#444;margin:0">
              본 설문은 「소규모(비아파트) 주거 관련 제도개선」 연구를 위한 전문가 의견 조사입니다.
              아래 정보를 입력하시면 응답용 링크가 발급되며, 이어서 설문에 참여하실 수 있습니다.
              총 소요시간은 <strong>약 ${m.duration}</strong>입니다.
            </p>
          </div>

          <div class="register-card">
            <h3>응답자 정보 입력</h3>
            ${errHtml}
            <div class="register-section">
              <label class="register-label">이메일 <span class="register-req">*</span></label>
              <p class="register-hint">응답 완료 안내·중복 응답 확인에만 사용되며, 분석 데이터에는 포함되지 않습니다.</p>
              <input id="reg-email" type="email" class="register-input" placeholder="example@auri.re.kr"
                     value="${this.escape(d.email || '')}" autocomplete="email">
            </div>
            <div class="register-section">
              <label class="register-label">성명 <span class="register-req">*</span></label>
              <input id="reg-name" type="text" class="register-input" placeholder="홍길동"
                     value="${this.escape(d.name || '')}">
            </div>
            <div class="register-section">
              <label class="register-label">소속 기관</label>
              <input id="reg-org" type="text" class="register-input" placeholder="예) ○○대학교 / ○○연구원 / ○○건축사사무소"
                     value="${this.escape(d.org || '')}">
            </div>
            <div class="register-section">
              <label class="register-label">소속 분야</label>
              <select id="reg-category" class="register-input">
                <option value="">선택해 주십시오</option>
                ${catOptions}
              </select>
            </div>
          </div>

          <div class="register-card">
            <h3>개인정보 수집·이용 동의 <span class="register-req">*</span></h3>
            <p class="register-hint" style="margin-bottom:8px">
              본 연구의 응답 완료 안내 및 동일인의 중복 응답 확인을 위하여 이메일을 수집·이용하며,
              연구 종료 후에는 식별 정보가 모두 파기됩니다. 통계 분석 시 응답자는 익명 처리됩니다.
            </p>
            <label class="register-consent">
              <input id="reg-consent" type="checkbox" ${d.consent_pi ? 'checked' : ''}>
              <span>위 내용을 읽고 동의합니다.</span>
            </label>
          </div>

          <div class="register-actions">
            <button class="btn btn-next" id="btn-reg-submit" ${this.regSubmitting ? 'disabled' : ''}>
              설문 시작
            </button>
            ${submitting}
          </div>

          <div class="register-meta">
            <dl>
              <dt>조사기관</dt><dd>${m.institution}</dd>
              <dt>연구책임</dt><dd>${m.researcher}</dd>
              <dt>담당</dt><dd>${m.contactName} (${m.contact})</dd>
            </dl>
          </div>
        </div>
      </div>
    `;

    const sync = () => {
      this.regDraft.email = this.container.querySelector('#reg-email').value;
      this.regDraft.name = this.container.querySelector('#reg-name').value;
      this.regDraft.org = this.container.querySelector('#reg-org').value;
      this.regDraft.category = this.container.querySelector('#reg-category').value;
      this.regDraft.consent_pi = this.container.querySelector('#reg-consent').checked;
      this.saveRegisterDraft();
    };
    ['#reg-email', '#reg-name', '#reg-org'].forEach(s => {
      this.container.querySelector(s)?.addEventListener('input', sync);
    });
    this.container.querySelector('#reg-category')?.addEventListener('change', sync);
    this.container.querySelector('#reg-consent')?.addEventListener('change', sync);
    this.container.querySelector('#btn-reg-submit')?.addEventListener('click', () => {
      sync();
      this.submitRegistration();
    });
  }

  async submitRegistration() {
    const d = this.regDraft;
    const errors = [];
    const email = (d.email || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('올바른 이메일을 입력해 주십시오.');
    if (!(d.name || '').trim()) errors.push('성명을 입력해 주십시오.');
    if (!d.consent_pi) errors.push('개인정보 수집·이용에 동의해 주셔야 참여하실 수 있습니다.');
    if (errors.length) {
      this.regError = errors.join(' / ');
      this.render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    this.regError = '';
    this.regSubmitting = true;
    this.render();

    try {
      const payload = {
        email: email,
        name: (d.name || '').trim(),
        org: (d.org || '').trim(),
        category: (d.category || '').trim(),
        consent_pi: true,
        is_staff: !!this.isStaffMode,
      };
      const res = await fetch(`${API_BASE}/api/survey/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 410) {
        // 등록 시점에 정원이 마감된 경우 — 안내 화면으로 전환
        this.gate = GATE.CLOSED;
        this.regSubmitting = false;
        this.render();
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `등록 실패 (${res.status})`);
      }
      const data = await res.json();
      this.clearRegisterDraft();

      if (data.has_responded) {
        // 동일 이메일이 이미 응답을 완료한 상태 — 명시적 안내 화면으로 분기.
        const url = new URL(window.location.href);
        url.searchParams.set('token', data.token);
        this.alreadyRespondedReviewUrl = url.toString();
        this.gate = GATE.ALREADY_RESPONDED;
        this.regSubmitting = false;
        this.render();
        return;
      }

      // 미응답이면 발급 토큰 URL로 이동 — 페이지 reload하여 토큰 인증 흐름 진입.
      // just_registered=1 플래그로 인트로에 "이 URL 북마크 안내" 배너 1회 표시.
      // 직원 테스트 모드는 redirect 후에도 source=staff 파라미터 유지 (참고 표시용).
      const url = new URL(window.location.href);
      url.searchParams.set('token', data.token);
      url.searchParams.set('just_registered', '1');
      if (this.isStaffMode) url.searchParams.set('source', 'staff');
      window.location.href = url.toString();
    } catch (e) {
      this.regError = e.message || '등록 중 오류가 발생했습니다. 잠시 후 다시 시도해 주십시오.';
      this.regSubmitting = false;
      this.render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ── Already Responded (자가등록 dedup → 이미 응답 완료) ──
  renderAlreadyResponded() {
    const m = SURVEY_META;
    const reviewUrl = this.alreadyRespondedReviewUrl || '#';
    this.container.innerHTML = `
      <div class="survey-container">
        <div class="resubmit-choice">
          <div class="resubmit-badge">제출 완료</div>
          <h1>이미 응답을 완료하셨습니다</h1>
          <p class="resubmit-msg">
            입력하신 이메일로 <strong>이전에 본 설문에 응답한 기록</strong>이 확인되었습니다.<br>
            동일한 응답자에 대해 중복 응답을 받지 않습니다.
          </p>
          <p style="font-size:13px;color:#666;margin:20px 0 0;line-height:1.7">
            제출하신 응답을 확인하거나 수정하시려면 아래 버튼을 눌러 응답 페이지로 이동해 주십시오.<br>
            받으신 안내 메일이 있다면 그 메일의 링크를 사용하셔도 됩니다.
          </p>
          <div class="resubmit-actions" style="margin-top:24px">
            <a class="btn btn-next" href="${reviewUrl}">내 응답 확인·수정</a>
          </div>
          <div class="access-denied-meta" style="margin-top:32px">
            <dl>
              <dt>조사기관</dt><dd>${m.institution}</dd>
              <dt>연구책임</dt><dd>${m.researcher}</dd>
              <dt>담당</dt><dd>${m.contactName} (${m.contact})</dd>
            </dl>
          </div>
        </div>
      </div>
    `;
  }

  // ── Status Bar (공통 상단) ──
  renderStatusBar() {
    let status, statusClass;
    if (this.submitted && this.editMode === EDIT_MODE.EDIT) {
      status = '수정 중';
      statusClass = 'status-editing';
    } else if (this.submitted) {
      status = '제출 완료';
      statusClass = 'status-done';
    } else {
      status = '미제출';
      statusClass = 'status-pending';
    }

    const submittedInfo = this.submittedAt
      ? `<span class="status-time">제출: ${this.formatDateTime(this.submittedAt)}</span>`
      : '';
    const updatedInfo = this.updatedAt
      ? `<span class="status-time">수정: ${this.formatDateTime(this.updatedAt)}</span>`
      : '';

    return `
      <div class="status-info-bar">
        <div class="status-info-inner">
          <span class="status-badge ${statusClass}">${status}</span>
          <div class="status-times">
            ${submittedInfo}
            ${updatedInfo}
          </div>
        </div>
      </div>
    `;
  }

  // ── Participant Info Card ──
  renderParticipantCard() {
    const p = this.participant;
    if (!p) return '';

    if (this.editingParticipant) {
      const errHtml = this.participantFormError
        ? `<p class="participant-error">${this.escape(this.participantFormError)}</p>`
        : '';
      return `
        <div class="participant-card editing">
          <div class="participant-card-header">
            <h3>내 정보 수정</h3>
          </div>
          <div class="participant-form">
            <label>
              <span>이름</span>
              <input type="text" id="p-name" value="${this.escape(p.name || '')}" />
            </label>
            <label>
              <span>이메일</span>
              <input type="email" id="p-email" value="${this.escape(p.email || '')}" />
            </label>
            <label>
              <span>소속</span>
              <input type="text" id="p-org" value="${this.escape(p.org || '')}" />
            </label>
            <label>
              <span>연락처</span>
              <input type="tel" id="p-phone" value="${this.escape(p.phone || '')}" placeholder="010-0000-0000" />
            </label>
          </div>
          ${errHtml}
          <div class="participant-actions">
            <button class="btn btn-prev" id="btn-p-cancel">취소</button>
            <button class="btn btn-next" id="btn-p-save">저장</button>
          </div>
        </div>
      `;
    }

    return `
      <div class="participant-card">
        <div class="participant-card-header">
          <h3>내 정보</h3>
          <button class="btn-link" id="btn-p-edit">수정</button>
        </div>
        <dl class="participant-info">
          <dt>이름</dt><dd>${this.escape(p.name || '-')}</dd>
          <dt>이메일</dt><dd>${this.escape(p.email || '-')}</dd>
          <dt>소속</dt><dd>${this.escape(p.org || '-')}</dd>
          <dt>연락처</dt><dd>${this.escape(p.phone || '-')}</dd>
          <dt>직군</dt><dd class="readonly">${this.escape(p.category || '-')} <span class="hint">(사전 분류)</span></dd>
        </dl>
      </div>
    `;
  }

  bindParticipantEvents() {
    this.container.querySelector('#btn-p-edit')?.addEventListener('click', () => {
      this.editingParticipant = true;
      this.participantFormError = '';
      this.render();
    });
    this.container.querySelector('#btn-p-cancel')?.addEventListener('click', () => {
      this.editingParticipant = false;
      this.participantFormError = '';
      this.render();
    });
    this.container.querySelector('#btn-p-save')?.addEventListener('click', () => {
      this.saveParticipant();
    });
  }

  async saveParticipant() {
    const nameEl = this.container.querySelector('#p-name');
    const emailEl = this.container.querySelector('#p-email');
    const orgEl = this.container.querySelector('#p-org');
    const phoneEl = this.container.querySelector('#p-phone');

    const payload = {
      name: nameEl.value.trim(),
      email: emailEl.value.trim(),
      org: orgEl.value.trim(),
      phone: phoneEl.value.trim(),
    };

    if (!payload.name) {
      this.participantFormError = '이름을 입력해 주십시오.';
      this.render();
      return;
    }
    if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      this.participantFormError = '올바른 이메일을 입력해 주십시오.';
      this.render();
      return;
    }

    const saveBtn = this.container.querySelector('#btn-p-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '저장 중…'; }

    try {
      const res = await fetch(`${API_BASE}/api/survey/${this.token}/participant`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `저장 실패 (${res.status})`);
      }
      const data = await res.json();
      this.participant = { ...this.participant, ...data.participant };
      this.editingParticipant = false;
      this.participantFormError = '';
      this.render();
    } catch (err) {
      this.participantFormError = err.message || '저장 중 오류가 발생했습니다.';
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '저장'; }
      this.render();
    }
  }

  // ── Intro ──
  renderIntro() {
    const m = SURVEY_META;
    const statusBar = this.renderStatusBar();
    const participantCard = this.renderParticipantCard();
    const startLabel = this.submitted && this.editMode === EDIT_MODE.EDIT
      ? '응답 수정 시작하기'
      : '설문 시작하기';

    const consent = !!this.responses['CONSENT_REWARD'];
    const phone = this.responses['PHONE'] || '';
    const N = REWARD_CONSENT_NOTICE;
    const consentRows = N.rows.map(([k, v]) =>
      `<tr><th>${k}</th><td>${v}</td></tr>`
    ).join('');

    // 자가등록 직후(`?just_registered=1`) 1회 표시되는 북마크 안내. 닫으면 URL에서 플래그 제거.
    const bookmarkBanner = this.justRegistered ? `
      <div class="bookmark-banner">
        <div class="bookmark-banner-icon">🔖</div>
        <div class="bookmark-banner-body">
          <strong>이 페이지의 URL을 북마크해 주세요.</strong>
          <p>응답 작성 도중 자리를 비우셨다가 다시 돌아오실 때 사용하시는 <strong>고유 응답 링크</strong>입니다.
             제출 직후 입력하신 이메일로 응답 확인 링크가 자동 발송됩니다.</p>
          <button class="bookmark-banner-close" id="btn-bookmark-close" aria-label="닫기">×</button>
        </div>
      </div>
    ` : '';

    // 직원 테스트 모드 또는 verify_token으로 확인된 source=staff 응답자에게 상시 노출되는 알림.
    const isStaffParticipant = (this.participant && this.participant.source === 'staff') || this.isStaffMode;
    const staffBanner = isStaffParticipant ? `
      <div class="bookmark-banner" style="background:#fef3c7;border-color:#fcd34d">
        <div class="bookmark-banner-icon">🧪</div>
        <div class="bookmark-banner-body">
          <strong style="color:#92400e">직원 테스트 응답</strong>
          <p style="color:#92400e">이 응답은 <strong>분석·통계·사례품 발송 대상에서 제외</strong>됩니다.
             테스트 목적으로만 자유롭게 작성·제출하셔도 됩니다.</p>
        </div>
      </div>
    ` : '';

    this.container.innerHTML = `
      ${statusBar}
      <div class="progress-bar-wrap"><div class="progress-bar-inner">
        <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
        <span class="progress-label">0%</span>
      </div></div>
      <div class="survey-container with-status-bar">
        <div class="survey-header">
          <div class="institution">${m.institution}</div>
          <h1>${m.title}</h1>
          <div class="subtitle">${m.subtitle}</div>
        </div>

        ${staffBanner}

        ${bookmarkBanner}

        ${participantCard}

        <div class="intro-card">
          <h2>연구 소개</h2>
          <p>건축공간연구원(AURI)에서는 다세대·다가구·연립주택 등 아파트가 아닌 소규모 주택과 관련한 제도 개선 방향에 대해 전문가 의견을 수렴하고 있습니다. 소규모 비아파트 주택의 규모 기준 확대 필요성, 용도체계 개선, 입지 및 건축기준 조정 방향, 우려사항 및 보완과제를 종합적으로 파악하여 정책 연구에 반영하는 것을 목적으로 합니다.</p>
        </div>

        <div class="intro-card">
          <h2>설문 구성</h2>
          <p>본 설문은 <strong>8개 영역 총 27문항</strong>으로 구성됩니다.</p>
          <ul style="margin-top:12px">
            <li>SQ. 응답자 선정 (소속·경력·경험·지역)</li>
            <li>A~D. 역할 인식 · 규모 기준 · 용도체계 · 입지 차등</li>
            <li>E·G. 건축기준·주거품질 · 우려사항</li>
            <li>H~I. 정비사업 연계 · 종합 의견</li>
          </ul>
          <dl class="intro-meta">
            <dt>소요 시간</dt><dd>${m.duration}</dd>
            <dt>비밀보장</dt><dd>통계법 제33조에 따라 비밀 보장, 연구 목적 외 사용 금지</dd>
            <dt>설문 답례품</dt><dd>스타벅스 아메리카노 쿠폰</dd>
            <dt>연구책임</dt><dd>${m.researcher}</dd>
            <dt>담당</dt><dd>${m.contactName} (${m.contact})</dd>
          </dl>
        </div>

        <div class="intro-card consent-block">
          <h2>${N.title}</h2>
          <p class="consent-intro">${N.lead}</p>
          <table class="consent-table">
            <tbody>${consentRows}</tbody>
          </table>
          <label class="consent-check">
            <input type="checkbox" id="intro-consent" ${consent ? 'checked' : ''} />
            <span>${N.consentLabel}</span>
          </label>
          <div id="intro-phone-wrap" style="${consent ? '' : 'display:none'};margin-top:12px">
            <label style="display:block;font-size:13px;color:#374151;margin-bottom:6px">
              휴대전화 번호 <span style="color:#dc2626">*</span>
              <span style="font-size:11px;color:#6b7280;font-weight:400;margin-left:6px">동의 시 필수 · 발송 후 즉시 파기</span>
            </label>
            <input type="tel" id="intro-phone" value="${phone.replace(/"/g, '&quot;')}" placeholder="010-1234-5678"
              style="width:100%;max-width:320px;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px" />
            <p id="intro-phone-error" style="display:none;color:#b91c1c;font-size:12px;margin-top:6px"></p>
          </div>
        </div>

        <button class="btn-start" id="btn-start">${startLabel}</button>
      </div>
    `;
    this.bindParticipantEvents();
    this.bindIntroConsentEvents();
    this.container.querySelector('#btn-start')?.addEventListener('click', () => {
      if (!this.commitIntroConsent()) return;
      this.currentPage = 1;
      this.render();
    });
    this.container.querySelector('#btn-bookmark-close')?.addEventListener('click', () => {
      this.justRegistered = false;
      const url = new URL(window.location.href);
      url.searchParams.delete('just_registered');
      window.history.replaceState({}, '', url.toString());
      this.render();
    });
  }

  bindIntroConsentEvents() {
    const cb = this.container.querySelector('#intro-consent');
    const wrap = this.container.querySelector('#intro-phone-wrap');
    const phoneInput = this.container.querySelector('#intro-phone');
    if (!cb) return;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        wrap.style.display = '';
        phoneInput?.focus();
      } else {
        wrap.style.display = 'none';
        if (phoneInput) phoneInput.value = '';
        const err = this.container.querySelector('#intro-phone-error');
        if (err) err.style.display = 'none';
      }
    });
  }

  commitIntroConsent() {
    const cb = this.container.querySelector('#intro-consent');
    const phoneInput = this.container.querySelector('#intro-phone');
    const errEl = this.container.querySelector('#intro-phone-error');
    if (!cb) return true;  // intro 외 페이지에서 호출된 경우
    if (cb.checked) {
      const phone = (phoneInput?.value || '').trim();
      const re = new RegExp(REWARD_CONSENT_NOTICE.phonePattern);
      if (!re.test(phone)) {
        if (errEl) {
          errEl.textContent = REWARD_CONSENT_NOTICE.phonePatternMessage;
          errEl.style.display = '';
        }
        phoneInput?.focus();
        return false;
      }
      this.setResponse('CONSENT_REWARD', true);
      this.setResponse('PHONE', phone);
    } else {
      this.setResponse('CONSENT_REWARD', false);
      this.setResponse('PHONE', '');
    }
    return true;
  }

  // ── Section ──
  renderSection(section) {
    const pct = Math.round((this.currentPage / (this.visibleSections.length + 1)) * 100);
    const isLast = this.currentPage === this.visibleSections.length;
    const statusBar = this.renderStatusBar();
    const submitLabel = this.submitted && this.editMode === EDIT_MODE.EDIT ? '수정 내용 제출' : '제출하기';

    let html = `
      ${statusBar}
      <div class="progress-bar-wrap"><div class="progress-bar-inner">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <span class="progress-label">${pct}%</span>
      </div></div>
      <div class="survey-container with-status-bar">
        <div class="section">
          <div class="section-header">
            <span class="section-tag">${section.tag}</span>
            <h2>${section.title}</h2>
            ${section.subtitle ? `<p class="section-subtitle">${section.subtitle}</p>` : ''}
          </div>
    `;

    for (const q of section.questions) {
      if (!this.isQuestionVisible(q)) continue;
      html += this.renderQuestion(q);
    }

    html += `</div></div>`;
    html += `
      <div class="nav-bar"><div class="nav-inner">
        <button class="btn btn-prev" id="btn-prev">&larr; 이전</button>
        ${isLast
          ? `<button class="btn btn-submit" id="btn-next">${submitLabel}</button>`
          : '<button class="btn btn-next" id="btn-next">다음 &rarr;</button>'
        }
      </div></div>
    `;

    this.container.innerHTML = html;
    this.bindEvents(section);
    this.restoreValues(section);
  }

  renderQuestion(q) {
    if (q.type === Q_TYPE.SUB_QUESTIONS) {
      return this.renderSubQuestions(q);
    }

    let inner = '';
    const noteHtml = q.note ? `<p class="question-note">${q.note}</p>` : '';

    switch (q.type) {
      case Q_TYPE.SINGLE:
      case Q_TYPE.SINGLE_WITH_OTHER:
        inner = this.renderOptions(q, 'radio', q.type === Q_TYPE.SINGLE_WITH_OTHER);
        break;
      case Q_TYPE.MULTI:
      case Q_TYPE.MULTI_LIMIT:
        inner = this.renderOptions(q, 'checkbox');
        break;
      case Q_TYPE.MULTI_WITH_OTHER:
      case Q_TYPE.MULTI_LIMIT_OTHER:
        inner = this.renderOptions(q, 'checkbox', true);
        break;
      case Q_TYPE.LIKERT_TABLE:
        inner = this.renderLikertTable(q);
        break;
      case Q_TYPE.TEXT:
        inner = this.renderTextInput(q);
        break;
    }

    return `
      <div class="question-block" data-qid="${q.id}">
        <div class="question-label">
          <span class="question-id">${q.id.replace(/([A-Z]+)(\d)/, '$1-$2')}</span>
          <span class="question-text">${q.text}</span>
        </div>
        ${noteHtml}
        ${inner}
        <p class="question-error" data-error="${q.id}"></p>
      </div>
    `;
  }

  renderConsentReward(q) {
    const notice = q.notice || {};
    const rows = (notice.rows || []).map(([k, v]) =>
      `<tr><th>${k}</th><td>${v}</td></tr>`
    ).join('');
    return `
      <div class="question-block consent-block" data-qid="${q.id}">
        <div class="question-label">
          <span class="question-text">${q.text}</span>
        </div>
        ${notice.intro ? `<p class="consent-intro">${notice.intro}</p>` : ''}
        <table class="consent-table">
          <tbody>${rows}</tbody>
        </table>
        <label class="consent-check">
          <input type="checkbox" data-consent-qid="${q.id}" />
          <span>${notice.consentLabel || '위 사항에 동의합니다 (선택).'}</span>
        </label>
        <p class="question-error" data-error="${q.id}"></p>
      </div>
    `;
  }

  renderOptions(q, inputType, hasOther = false) {
    let html = `<div class="option-list" data-qid="${q.id}" data-type="${inputType}">`;
    const name = q.id;
    q.options.forEach((opt, i) => {
      html += `
        <label class="option-item" data-index="${i}">
          <input type="${inputType}" name="${name}" value="${i}" />
          <span class="option-text">${opt}</span>
        </label>
      `;
    });
    if (hasOther) {
      html += `
        <label class="option-item other-row" data-index="other">
          <input type="${inputType}" name="${name}" value="other" />
          <span class="option-text">${q.otherLabel || '기타'}:</span>
          <input type="text" class="other-text" data-qid="${q.id}_other" placeholder="직접 입력" />
        </label>
      `;
    }
    html += '</div>';
    return html;
  }

  renderLikertTable(q) {
    let html = '<div class="likert-table-wrap"><table class="likert-table" data-qid="' + q.id + '">';
    html += '<thead><tr><th></th>';
    q.scaleLabels.forEach((l, i) => { html += `<th>${i + 1}<br><span style="font-weight:400">${l}</span></th>`; });
    html += '</tr></thead><tbody>';
    q.items.forEach((item, idx) => {
      html += `<tr data-row="${idx}">`;
      html += `<td><span class="item-number">(${idx + 1})</span>${item}</td>`;
      for (let v = 1; v <= q.scaleLabels.length; v++) {
        html += `<td><input type="radio" class="likert-radio" name="${q.id}_${idx}" value="${v}" /></td>`;
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  renderTextInput(q) {
    const isIdCode = q.id === 'ID_CODE';
    const cls = isIdCode ? 'text-input id-code-input' : 'text-input';
    if (isIdCode) {
      return `<input type="text" class="${cls}" data-qid="${q.id}" placeholder="${q.placeholder || ''}" maxlength="10" />`;
    }
    return `<textarea class="${cls}" data-qid="${q.id}" placeholder="${q.placeholder || ''}" rows="4"></textarea>`;
  }

  renderSubQuestions(q) {
    let html = `
      <div class="question-block" data-qid="${q.id}">
        <div class="question-label">
          <span class="question-id">${q.id.replace(/([A-Z]+)(\d)/, '$1-$2')}</span>
          <span class="question-text">${q.text}</span>
        </div>
        <div class="sub-question-group">
    `;
    for (const sq of q.subQuestions) {
      const noteHtml = sq.note ? `<p class="sub-question-note">${sq.note}</p>` : '';
      let inner = '';
      if (sq.type === Q_TYPE.SINGLE) {
        inner = this.renderOptions(sq, 'radio');
      } else if (sq.type === Q_TYPE.MULTI_WITH_OTHER || sq.type === Q_TYPE.MULTI_LIMIT_OTHER) {
        inner = this.renderOptions(sq, 'checkbox', true);
      } else if (sq.type === Q_TYPE.MULTI) {
        inner = this.renderOptions(sq, 'checkbox');
      }
      html += `
        <div class="sub-question" data-qid="${sq.id}">
          <div class="sub-question-label">${sq.label}</div>
          ${noteHtml}
          ${inner}
          <p class="question-error" data-error="${sq.id}"></p>
        </div>
      `;
    }
    html += '</div></div>';
    return html;
  }

  // ── Event Binding ──
  bindEvents(section) {
    this.container.querySelector('#btn-prev')?.addEventListener('click', () => {
      this.currentPage--;
      if (this.currentPage < 0) this.currentPage = 0;
      this.render();
    });

    this.container.querySelector('#btn-next')?.addEventListener('click', () => {
      if (this.validateSection(section)) {
        this.currentPage++;
        this.updateVisibleSections();
        this.render();
      }
    });

    this.container.querySelectorAll('.option-list').forEach(list => {
      const qid = list.dataset.qid;
      const type = list.dataset.type;
      const q = this.findQuestion(qid);

      list.querySelectorAll('.option-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('other-text')) return;
          const input = item.querySelector('input[type="radio"], input[type="checkbox"]');
          if (!input || input.disabled) return;

          if (type === 'radio') {
            list.querySelectorAll('.option-item').forEach(oi => oi.classList.remove('selected'));
            input.checked = true;
            item.classList.add('selected');
            this.setResponse(qid, parseInt(input.value) || input.value);
            const hasDependent = section.questions.some(sq => sq.showWhen && sq.showWhen.questionId === qid);
            if (hasDependent) {
              this.renderSection(section);
              return;
            }
          } else {
            input.checked = !input.checked;
            item.classList.toggle('selected', input.checked);
            this.collectMultiResponse(qid, list, q);
          }

          if (q && q.exclusive !== undefined && input.checked) {
            const idx = parseInt(item.dataset.index);
            if (idx === q.exclusive) {
              list.querySelectorAll('.option-item').forEach(oi => {
                if (oi !== item) {
                  const cb = oi.querySelector('input[type="checkbox"]');
                  if (cb) { cb.checked = false; oi.classList.remove('selected'); }
                }
              });
            } else {
              const exItem = list.querySelector(`[data-index="${q.exclusive}"]`);
              if (exItem) {
                const cb = exItem.querySelector('input[type="checkbox"]');
                if (cb) { cb.checked = false; exItem.classList.remove('selected'); }
              }
            }
            this.collectMultiResponse(qid, list, q);
          }

          if (q && q.maxSelect) {
            this.enforceMaxSelect(qid, list, q);
          }

          const block = item.closest('.question-block, .sub-question');
          if (block) block.classList.remove('has-error');
        });
      });
    });

    this.container.querySelectorAll('.likert-radio').forEach(radio => {
      radio.addEventListener('change', () => {
        const name = radio.name;
        const [qid, rowStr] = name.split(/_(\d+)$/);
        const row = parseInt(rowStr);
        const val = parseInt(radio.value);
        let resp = this.getResponse(qid) || {};
        resp[row] = val;
        this.setResponse(qid, resp);

        const table = radio.closest('.likert-table');
        if (table) table.classList.remove('has-error');
      });
    });

    this.container.querySelectorAll('.text-input').forEach(el => {
      const qid = el.dataset.qid;
      el.addEventListener('input', () => {
        this.setResponse(qid, el.value);
        el.closest('.question-block')?.classList.remove('has-error');
      });
    });

    this.container.querySelectorAll('.other-text').forEach(el => {
      el.addEventListener('input', () => {
        const qid = el.dataset.qid;
        this.setResponse(qid, el.value);
      });
      el.addEventListener('click', (e) => e.stopPropagation());
    });

    this.container.querySelectorAll('input[data-consent-qid]').forEach(cb => {
      cb.addEventListener('change', () => {
        const qid = cb.dataset.consentQid;
        this.setResponse(qid, cb.checked);
        // 동의 해제 시 의존 응답(PHONE 등) 정리
        if (!cb.checked) {
          const allQ = this.getAllQuestions(section);
          allQ.forEach(dq => {
            if (dq.showWhen && dq.showWhen.questionId === qid) {
              this.setResponse(dq.id, undefined);
            }
          });
        }
        this.render();
      });
    });
  }

  collectMultiResponse(qid, list) {
    const checked = [];
    list.querySelectorAll('input:checked').forEach(cb => {
      checked.push(cb.value === 'other' ? 'other' : parseInt(cb.value));
    });
    this.setResponse(qid, checked);
  }

  enforceMaxSelect(qid, list, q) {
    const checked = list.querySelectorAll('input:checked');
    const unchecked = list.querySelectorAll('input:not(:checked)');
    if (checked.length >= q.maxSelect) {
      unchecked.forEach(cb => {
        cb.disabled = true;
        cb.closest('.option-item')?.classList.add('disabled');
      });
    } else {
      list.querySelectorAll('input').forEach(cb => {
        cb.disabled = false;
        cb.closest('.option-item')?.classList.remove('disabled');
      });
    }
  }

  // ── Restore Saved Values ──
  restoreValues(section) {
    const allQuestions = this.getAllQuestions(section);
    for (const q of allQuestions) {
      const val = this.getResponse(q.id);
      if (val === undefined) continue;

      if (q.type === Q_TYPE.LIKERT_TABLE) {
        if (typeof val === 'object') {
          for (const [row, v] of Object.entries(val)) {
            const radio = this.container.querySelector(`input[name="${q.id}_${row}"][value="${v}"]`);
            if (radio) radio.checked = true;
          }
        }
      } else if (q.type === Q_TYPE.CONSENT_REWARD) {
        const cb = this.container.querySelector(`input[data-consent-qid="${q.id}"]`);
        if (cb) cb.checked = !!val;
      } else if (q.type === Q_TYPE.TEXT) {
        const el = this.container.querySelector(`[data-qid="${q.id}"]`);
        if (el) el.value = val;
      } else if (q.type === Q_TYPE.SINGLE || q.type === Q_TYPE.SINGLE_WITH_OTHER) {
        const list = this.container.querySelector(`.option-list[data-qid="${q.id}"]`);
        if (list) {
          const input = list.querySelector(`input[value="${val}"]`);
          if (input) {
            input.checked = true;
            input.closest('.option-item')?.classList.add('selected');
          }
        }
        if (val === 'other') {
          const otherText = this.getResponse(q.id + '_other');
          const otherInput = this.container.querySelector(`.other-text[data-qid="${q.id}_other"]`);
          if (otherInput && otherText) otherInput.value = otherText;
        }
      } else if (Array.isArray(val)) {
        const list = this.container.querySelector(`.option-list[data-qid="${q.id}"]`);
        if (list) {
          val.forEach(v => {
            const input = list.querySelector(`input[value="${v}"]`);
            if (input) {
              input.checked = true;
              input.closest('.option-item')?.classList.add('selected');
            }
          });
          if (q.maxSelect) this.enforceMaxSelect(q.id, list, q);
        }
        if (val.includes('other')) {
          const otherText = this.getResponse(q.id + '_other');
          const otherInput = this.container.querySelector(`.other-text[data-qid="${q.id}_other"]`);
          if (otherInput && otherText) otherInput.value = otherText;
        }
      }
    }
  }

  // ── Validation ──
  validateSection(section) {
    let valid = true;
    const allQuestions = this.getAllQuestions(section);

    for (const q of allQuestions) {
      if (q.optional) continue;
      if (!this.isQuestionVisible(q)) continue;

      const val = this.getResponse(q.id);
      let ok = true;

      if (q.type === Q_TYPE.LIKERT_TABLE) {
        const expected = q.items.length;
        ok = val && typeof val === 'object' && Object.keys(val).length === expected;
        if (!ok) {
          const table = this.container.querySelector(`.likert-table[data-qid="${q.id}"]`);
          table?.classList.add('has-error');
          this.showError(q.id, '모든 항목에 응답해 주십시오.');
        }
      } else if (q.type === Q_TYPE.TEXT) {
        ok = val && val.trim().length > 0;
        if (!ok) this.showError(q.id, '응답을 입력해 주십시오.');
        if (ok && q.pattern) {
          const re = new RegExp(q.pattern);
          if (!re.test(val.trim())) {
            ok = false;
            this.showError(q.id, q.patternMessage || '올바른 형식으로 입력해 주십시오.');
          }
        }
      } else if (q.type === Q_TYPE.SINGLE || q.type === Q_TYPE.SINGLE_WITH_OTHER) {
        ok = val !== undefined;
        if (!ok) this.showError(q.id, '하나를 선택해 주십시오.');
      } else if (Array.isArray(val)) {
        ok = val.length > 0;
        if (!ok) this.showError(q.id, '하나 이상 선택해 주십시오.');
      } else {
        ok = val !== undefined;
        if (!ok) this.showError(q.id, '응답해 주십시오.');
      }

      if (!ok) {
        valid = false;
        const block = this.container.querySelector(`[data-qid="${q.id}"]`);
        block?.classList.add('has-error');
      }
    }

    if (!valid) {
      const firstError = this.container.querySelector('.has-error');
      firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    return valid;
  }

  showError(qid, msg) {
    const el = this.container.querySelector(`[data-error="${qid}"]`);
    if (el) el.textContent = msg;
  }

  // ── Helpers ──
  getAllQuestions(section) {
    const result = [];
    for (const q of section.questions) {
      if (q.type === Q_TYPE.SUB_QUESTIONS) {
        for (const sq of q.subQuestions) result.push(sq);
      } else {
        result.push(q);
      }
    }
    return result;
  }

  findQuestion(qid) {
    for (const s of sections) {
      for (const q of s.questions) {
        if (q.id === qid) return q;
        if (q.type === Q_TYPE.SUB_QUESTIONS) {
          for (const sq of q.subQuestions) {
            if (sq.id === qid) return sq;
          }
        }
      }
    }
    return null;
  }

  escape(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  formatDateTime(isoStr) {
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    } catch { return isoStr; }
  }

  // ── Completion ──
  renderCompletion() {
    if (this.token && (!this.submitted || this.editMode === EDIT_MODE.EDIT)) {
      this.submitToServer();
      return;
    }

    const statusBar = this.renderStatusBar();
    const alreadyMsg = this.submitted
      ? '<p class="resubmit-note">이전 응답이 업데이트되었습니다.</p>'
      : '';

    this.container.innerHTML = `
      ${statusBar}
      <div class="survey-container with-status-bar">
        <div class="completion">
          <div class="completion-icon">
            <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </div>
          <h2>설문이 완료되었습니다</h2>
          <p>1차 설문에 응해 주셔서 진심으로 감사드립니다.<br/>
          수집된 결과는 2차 설문(IPA·AHP) 문항 설계에 반영되며, 최종적으로 건축 분야 AI 정책 수립의 핵심 근거자료로 활용됩니다.</p>
          ${alreadyMsg}
          <button class="btn btn-next" id="btn-download" style="margin-top:32px">응답 데이터 다운로드 (JSON)</button>
        </div>
      </div>
    `;
    this.container.querySelector('#btn-download')?.addEventListener('click', () => {
      this.downloadResponses();
    });
  }

  async submitToServer() {
    const statusBar = this.renderStatusBar();
    this.container.innerHTML = `
      ${statusBar}
      <div class="survey-container with-status-bar">
        <div class="completion" style="padding:120px 20px">
          <div class="spinner" style="width:40px;height:40px;border:3px solid #e0e0e0;border-top:3px solid #2c2c2c;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 24px"></div>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
          <h2>응답을 제출하고 있습니다…</h2>
        </div>
      </div>
    `;

    try {
      // 응답 dict 에서 사례품 동의·휴대폰은 분리해 별도 필드로 전송 (PII 분리)
      const responsesPayload = { ...this.responses };
      const consentReward = !!responsesPayload['CONSENT_REWARD'];
      const rewardPhone = consentReward ? (responsesPayload['PHONE'] || '').trim() : '';
      delete responsesPayload['CONSENT_REWARD'];
      delete responsesPayload['PHONE'];

      const res = await fetch(`${API_BASE}/api/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: this.token,
          survey_version: 'v10.0',
          responses: responsesPayload,
          consent_reward: consentReward,
          reward_phone: rewardPhone,
        }),
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      this.submitted = true;
      const now = new Date().toISOString();
      if (data.status === 'created') this.submittedAt = now;
      else this.updatedAt = now;
      this.editMode = EDIT_MODE.NEW;
      this.renderCompletion();
    } catch (err) {
      const statusBar = this.renderStatusBar();
      this.container.innerHTML = `
        ${statusBar}
        <div class="survey-container with-status-bar">
          <div class="completion">
            <h2 style="color:var(--c-error)">제출 중 오류가 발생했습니다</h2>
            <p style="margin:16px 0">${err.message}<br/>응답은 브라우저에 저장되어 있습니다. 다시 시도하거나 JSON을 다운로드해 주십시오.</p>
            <button class="btn btn-next" id="btn-retry" style="margin:8px">다시 시도</button>
            <button class="btn btn-prev" id="btn-fallback" style="margin:8px">JSON 다운로드</button>
          </div>
        </div>
      `;
      this.container.querySelector('#btn-retry')?.addEventListener('click', () => this.submitToServer());
      this.container.querySelector('#btn-fallback')?.addEventListener('click', () => this.downloadResponses());
    }
  }

  downloadResponses() {
    const data = {
      meta: {
        survey: SURVEY_META.title,
        version: 'v7',
        submittedAt: new Date().toISOString(),
        idCode: this.responses['ID_CODE'] || '',
        token: this.token || '',
      },
      responses: { ...this.responses },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `survey_${data.meta.idCode || 'anon'}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
