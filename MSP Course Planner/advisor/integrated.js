/* MSP advisor integration pilot — hosted INSIDE planner-v1.html.
 * Uses the pre-existing Supabase schema; all database access is subject to RLS.
 * Deliberately does not read, serialize, or upload the student's transcript. */
(() => {
  'use strict';
  const cfg = window.MSP_ADVISOR_CONFIG || {};
  const PERIODS = ['P1','P2','P4','P5'];
  const KEYS = ['A','B','C'];
  const bridge = window.MSPPlannerBridge;
  const $ = id => document.getElementById(id);
  const escapeHTML = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dateText = v => v ? new Date(v).toLocaleString(undefined, { dateStyle:'medium',timeStyle:'short' }) : '';
  const checked = result => { if(result.error) throw result.error; return result.data; };
  let db = null;
  let adminEnabled = false;
  let adminData = null;
  let adminBusy = false;
  let adminTab = 'reports';
  let adminStatusFilter = 'all';
  let adminQuery = '';
  let adminRequestFilter = 'pending';
  let user = null;
  let state = null;
  let reviewing = null;
  let busy = false;
  let refreshSerial = 0;
  let reviewPlanKey = null;
  let reviewPeriod = null;
  let studentFilter = 'all';
  let submissionPeriodFilter = 'all';
  let submissionReviewFilter = 'all';
  let submissionVersionFilter = 'all';
  let submissionRefreshing = false;
  let submissionLastUpdated = null;
  let studentSearch = '';
  let studentRefreshSerial = 0;
  let advisorRefreshSerial = 0;
  let advisorRefreshing = false;
  let advisorLastUpdated = null;
  let feedbackRefreshError = false;
  let realtimeChannel = null;
  let realtimeUserId = null;
  let realtimeRole = null;
  let realtimeTimer = null;
  const reviewDrafts = new Map();
  let noticeTimer = null;
  let selectedSnapshot = null;
  let snapshotRequestSerial = 0;
  // Success notices disappear; errors remain until dismissed or replaced.
  const notice = (text, error = false) => {
    clearTimeout(noticeTimer);
    const node = $('mspNotice');
    if (!node) return;
    const modal = $('mspSubmissionDialog')?.open ? $('mspSubmissionDialog') : $('mspAccountDialog')?.open ? $('mspAccountDialog') : null;
    if (modal) {
      if (node.parentElement !== modal) {
        const header = modal.querySelector('.msp-dialog-head, .msp-snapshot-head');
        if (header) header.after(node);
        else modal.prepend(node);
      }
    } else if (node.parentElement !== document.body) document.body.appendChild(node);
    node.replaceChildren();
    node.dataset.error = String(error);
    if (!text) return;
    const message = document.createElement('span');
    message.className = 'msp-notice-message';
    message.textContent = text;
    node.appendChild(message);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'msp-notice-dismiss';
    dismiss.setAttribute('aria-label','Dismiss notification');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => { clearTimeout(noticeTimer); node.replaceChildren(); });
    node.appendChild(dismiss);
    node.setAttribute('role',error ? 'alert' : 'status');
    if (!error) noticeTimer = setTimeout(() => { if (node.contains(message)) node.replaceChildren(); }, 4800);
  };
  const report = err => notice(err?.message || String(err), true);
  const elVal = id => $(id)?.value?.trim() || '';
  const isAdvisor = () => !!state?.advisor?.active;
  const isAdmin = () => adminEnabled;
  // Student-domain UM addresses can never request advisor access from the UI.
  // Keep test addresses usable until institutionally verified staff login exists.
  // Set restrictAdvisorRequestsToStaffEmail: true in config.js to apply the
  // production-facing UI rule (backend authorization must also be enforced).
  function eligibleAdvisorRequest() {
    if (!user || isAdvisor()) return false;
    const domain = (user.email || '').trim().toLowerCase().split('@')[1] || '';
    if (domain === 'student.maastrichtuniversity.nl') return false;
    if (cfg.restrictAdvisorRequestsToStaffEmail === true) {
      return domain === 'maastrichtuniversity.nl';
    }
    return true;
  }

  function nonEmpty(plan) {
    return Array.isArray(plan?.courses) && plan.courses.some(Boolean) ||
      Array.isArray(plan?.skills) && plan.skills.some(Boolean) || !!plan?.bundle;
  }
  function collected(scope) {
    if (!bridge?.ready()) return [];
    const snapshot = bridge.snapshot();
    const result = [];
    for (const period of PERIODS) {
      if (scope === 'period' && period !== bridge.period()) continue;
      for (const key of KEYS) {
        const plan = snapshot.plans?.[period]?.[key];
        if (!nonEmpty(plan)) continue;
        const payload = {
          customLoad: plan.customLoad === true,
          courseCount: Number(plan.courseCount) || 0,
          skillCount: Number(plan.skillCount) || 0,
          courses: Array.isArray(plan.courses) ? plan.courses.map(x => typeof x === 'string' ? x : '') : [],
          skills: Array.isArray(plan.skills) ? plan.skills.map(x => typeof x === 'string' ? x : '') : [],
          bundle: typeof plan.bundle === 'string' ? plan.bundle : '',
          externalCourses: Array.isArray(plan.externalCourses) ? plan.externalCourses.map(x => x && typeof x === 'object' && !Array.isArray(x) ? x : {}) : []
        };
        if (JSON.stringify(payload).length > 22000) throw Error(`${period} Plan ${key} exceeds the pilot's maximum submission size.`);
        result.push({period, key, plan:payload});
      }
    }
    return result;
  }
  // Review decisions belong to a submitted snapshot, not a mutable planner slot.
  // Each period / plan is represented by its most recent submission.
  function newestBySlot(rows) {
    const found = new Map();
    for (const row of rows || []) {
      if (!PERIODS.includes(row.period) || !KEYS.includes(row.plan_key)) continue;
      const slot = `${row.period}:${row.plan_key}`;
      const previous = found.get(slot);
      if (!previous || (Number(row.version_number) && Number(previous.version_number) ? Number(row.version_number) > Number(previous.version_number) : new Date(row.submitted_at) > new Date(previous.submitted_at))) found.set(slot, row);
    }
    return [...found.values()];
  }
  // Version numbers are scoped to one period and plan, oldest to newest.
  function submissionVersions(rows) {
    const groups = new Map();
    for (const row of rows || []) {
      const key = `${row.period}:${row.plan_key}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const result = new Map();
    for (const group of groups.values()) {
      group.sort((a,b) => (Number(a.version_number) && Number(b.version_number) ? Number(a.version_number) - Number(b.version_number) : new Date(a.submitted_at) - new Date(b.submitted_at)) || String(a.id).localeCompare(String(b.id)));
      group.forEach((row,i) => result.set(row.id,{version:Number(row.version_number) || i+1,latest:i===group.length-1}));
    }
    return result;
  }
  function ownSubmission(id) { return state?.own?.find(row => row.id === id); }
  function selectedPeriodPlan() {
    if (!selectedSnapshot || !bridge?.ready()) return null;
    try { return bridge.snapshot().plans?.[selectedSnapshot.row.period]?.[selectedSnapshot.row.plan_key] || null; }
    catch { return null; }
  }
  function snapshotEntries(plan, type) {
    const values = Array.isArray(plan?.[type]) ? plan[type] : [];
    return values.filter(Boolean).map((code,i) => {
      if (/^__EXTERNAL_COURSE_\d+__$/.test(code)) {
        const index = Number(code.match(/\d+/)[0]);
        const course = plan.externalCourses?.[index] || {};
        return `${course.code || 'External course'}${course.title ? ' — ' + course.title : ''}`;
      }
      return String(code);
    });
  }
  const snapshotList = values => values.length ? `<ul>${values.map(v=>`<li>${escapeHTML(v)}</li>`).join('')}</ul>` : '<p class="msp-caption">None selected</p>';
  function snapshotPanel(plan, title) {
    if (!plan) return `<section class="msp-snapshot-panel"><h4>${escapeHTML(title)}</h4><p class="msp-caption">Planner data is not loaded yet.</p></section>`;
    return `<section class="msp-snapshot-panel"><h4>${escapeHTML(title)}</h4>
      <div class="msp-snapshot-field"><b>Courses</b>${snapshotList(snapshotEntries(plan,'courses'))}</div>
      <div class="msp-snapshot-field"><b>Skills / practicals</b>${snapshotList(snapshotEntries(plan,'skills'))}</div>
      <div class="msp-snapshot-field"><b>Field course / bundle</b><p>${escapeHTML(plan.bundle || 'None')}</p></div>
      <p class="msp-caption">Study load: ${Number(plan.courseCount) || 0} courses · ${Number(plan.skillCount) || 0} skills${plan.customLoad ? ' · Custom load' : ''}</p></section>`;
  }
  function snapshotDifferences(sent, current) {
    if (!current) return '<p class="msp-caption">Load your planner to compare these versions.</p>';
    const changes = [];
    for (const [field,title] of [['courses','Courses'],['skills','Skills / practicals']]) {
      const before = snapshotEntries(sent,field), after = snapshotEntries(current,field);
      // Include duplicates so repeated selections do not disappear silently.
      const removed = [...before];
      const added = [];
      for (const item of after) { const index=removed.indexOf(item); if (index>=0) removed.splice(index,1); else added.push(item); }
      for (const item of removed) changes.push(`<li class="msp-diff-removed">− ${escapeHTML(title)}: ${escapeHTML(item)}</li>`);
      for (const item of added) changes.push(`<li class="msp-diff-added">+ ${escapeHTML(title)}: ${escapeHTML(item)}</li>`);
    }
    if ((sent.bundle||'') !== (current.bundle||'')) changes.push(`<li>Bundle changed: ${escapeHTML(sent.bundle||'None')} → ${escapeHTML(current.bundle||'None')}</li>`);
    if (Number(sent.courseCount)!==Number(current.courseCount) || Number(sent.skillCount)!==Number(current.skillCount) || !!sent.customLoad!==!!current.customLoad)
      changes.push(`<li>Study load settings changed</li>`);
    return changes.length ? `<ul class="msp-diff-list">${changes.join('')}</ul>` : '<p class="msp-snapshot-same">No differences from your current plan.</p>';
  }
  function ensureSnapshotDialog() {
    let node = $('mspSubmissionDialog');
    if (node) return node;
    node = document.createElement('dialog');
    node.id = 'mspSubmissionDialog';
    node.setAttribute('aria-labelledby','mspSnapshotTitle');
    node.innerHTML = `<div class="msp-snapshot-head"><div><span class="msp-dialog-eyebrow">MSP Course Planner</span><h3 id="mspSnapshotTitle">Submitted plan</h3></div>
      <button class="msp-snapshot-close" type="button" data-msp-action="closeSnapshot" aria-label="Close submitted plan preview">×</button></div>
      <div id="mspSnapshotContent" class="msp-snapshot-content"></div>`;
    node.addEventListener('close', () => {
      selectedSnapshot=null;
      ++snapshotRequestSerial;
      const toast=$('mspNotice');
      if (toast && toast.parentElement===node) document.body.appendChild(toast);
    });
    document.body.appendChild(node);
    return node;
  }
  function closeSnapshot() {
    ++snapshotRequestSerial;
    selectedSnapshot=null;
    const dialog=$('mspSubmissionDialog');
    if (dialog?.open) dialog.close();
  }
  function drawSnapshot() {
    const content=$('mspSnapshotContent');
    if (!content || !selectedSnapshot) return;
    const {row,compare} = selectedSnapshot;
    const version = submissionVersions(state?.own).get(row.id);
    const current = compare ? selectedPeriodPlan() : null;
    $('mspSnapshotTitle').textContent = `${row.period} · Plan ${row.plan_key} · Version ${version?.version || '?'}`;
    content.innerHTML = `<div class="msp-snapshot-meta">${statusHtml(row)} <span>Sent ${escapeHTML(dateText(row.submitted_at))}</span>${version?.latest ? '<span class="msp-status">Latest version</span>' : '<span class="msp-status">Earlier version</span>'}</div>
      <p class="msp-caption">This is a saved, read-only copy. Opening it will not change your current planner.</p>
      <div class="msp-snapshot-actions"><button type="button" class="btn ${compare?'btn-gh':'btn-navy'}" data-msp-action="snapshotView">View submission</button>
        <button type="button" class="btn ${compare?'btn-navy':'btn-gh'}" data-msp-action="snapshotCompare" ${!bridge?.ready()?'disabled title="Planner is not loaded yet"':''}>Compare with current plan</button></div>
      <div class="msp-snapshot-grid ${compare ? 'msp-snapshot-two' : ''}">${snapshotPanel(row.plan_data,'Submitted version')}${compare ? snapshotPanel(current,'Current planner') : ''}</div>
      ${compare ? `<section class="msp-snapshot-diff"><h4>Changes since submission</h4>${snapshotDifferences(row.plan_data,current)}</section>` : ''}
      ${row.student_message ? `<div class="msp-snapshot-note"><b>Message sent with this plan</b><p>${escapeHTML(row.student_message)}</p></div>` : ''}
      ${state.reviews?.find(r=>r.submission_id===row.id)?.comment ? `<div class="msp-snapshot-note"><b>Advisor feedback</b><p>${escapeHTML(state.reviews.find(r=>r.submission_id===row.id).comment)}</p></div>` : ''}`;
  }
  async function openSnapshot(id, compare=false) {
    if (!user || !state || isAdvisor() || bridge?.isReviewing()) throw Error('Sign in as a student to view your submissions.');
    const metadata = ownSubmission(id);
    if (!metadata) throw Error('This submission is no longer available. Refresh the page.');
    const uid=user.id, n=++snapshotRequestSerial;
    const dialog=ensureSnapshotDialog();
    selectedSnapshot=null;
    $('mspSnapshotTitle').textContent = 'Loading submitted plan…';
    $('mspSnapshotContent').innerHTML='<p class="msp-caption" role="status">Loading the saved plan…</p>';
    if (!dialog.open) dialog.showModal();
    try {
      const row=checked(await db.from('plan_submissions')
        .select('id,student_id,period,plan_key,plan_data,student_message,submitted_at,version_number')
        .eq('id',id).eq('student_id',uid).single());
      if (n!==snapshotRequestSerial || uid!==user?.id || !dialog.open) return;
      if (!row || row.id!==metadata.id || row.period!==metadata.period || row.plan_key!==metadata.plan_key || !row.plan_data)
        throw Error('Unable to verify the saved submission.');
      selectedSnapshot={row,compare:compare && !!bridge?.ready()};
      drawSnapshot();
    } catch(err) {
      if (n===snapshotRequestSerial && dialog.open) {
        $('mspSnapshotTitle').textContent='Unable to open submission';
        $('mspSnapshotContent').innerHTML=`<p class="msp-warning" role="alert">${escapeHTML(err.message || String(err))}</p><button type="button" class="btn btn-gh" data-msp-action="closeSnapshot">Close</button>`;
      }
    }
  }

  function reviewInfo(row) {
    if (!row) return {key:'none', label:'Not submitted'};
    const decision = state?.reviews?.find(r => r.submission_id === row.id)?.decision;
    if (decision === 'reviewed') return {key:'reviewed', label:'Reviewed'};
    if (decision === 'changes_requested') return {key:'changes', label:'Changes requested'};
    return {key:'pending', label:'Awaiting review'};
  }
  const statusHtml = row => {
    const status = reviewInfo(row);
    return `<span class="msp-status msp-status-${status.key}">${status.label}</span>`;
  };
  function reviewRow(period, key) {
    return newestBySlot(reviewing?.rows).find(r => r.period === period && r.plan_key === key);
  }

  function ensureStudentFeedback() {
    const anchor = $('advicePanel');
    if (!anchor) return null;
    let node = $('mspStudentFeedback');
    if (!node) {
      node = document.createElement('section');
      node.id = 'mspStudentFeedback';
      node.className = 'card msp-feedback-card';
      node.setAttribute('aria-label', 'Advisor feedback on submitted plans');
      anchor.before(node);
    }
    return node;
  }
  function drawStudentFeedback() {
    const node = ensureStudentFeedback();
    if (!node) return;
    const visible = !!user && !!state && !isAdvisor() && !bridge?.isReviewing() && !!state.own?.length;
    node.hidden = !visible;
    if (!visible) return;
    const period = bridge?.period() || 'P1';
    const latest = newestBySlot(state.own).filter(r => r.period === period);
    node.innerHTML = `<div class="card-h"><div class="step">✓</div><h2>Advisor feedback</h2><span class="hint">${escapeHTML(period)} · latest submissions</span></div>
      <div class="card-b">${latest.length ? `<div class="msp-feedback-list">${KEYS.map(key => {
        const row = latest.find(r => r.plan_key === key);
        if (!row) return '';
        const review = state.reviews?.find(x => x.submission_id === row.id);
        return `<div class="msp-feedback-item"><div class="msp-feedback-line"><b>Plan ${key}</b>${statusHtml(row)}<small>Sent ${escapeHTML(dateText(row.submitted_at))}</small></div>
          ${review?.comment ? `<p class="msp-feedback-comment">${escapeHTML(review.comment)}</p>` : ''}</div>`;
      }).join('')}</div>` : `<p class="msp-caption">No plans submitted for ${escapeHTML(period)} yet. You can view other periods under My submissions.</p>`}
      <p class="msp-caption msp-feedback-foot">This shows the newest submission of each plan. <a href="#submissions" onclick="switchView('submissions');closeSidebar()">View all submissions and earlier versions →</a></p>
      ${feedbackRefreshError ? '<p class="msp-warning" role="status">Could not check for updates. Showing the last loaded feedback.</p>' : ''}</div>`;
  }

  function planSummary(plan) {
    const courses = (plan?.courses || []).filter(Boolean).map(escapeHTML).join(', ') || 'None';
    const skills = (plan?.skills || []).filter(Boolean).map(escapeHTML).join(', ') || 'None';
    return `Courses: ${courses} · Skills: ${skills}${plan?.bundle ? ` · Bundle: ${escapeHTML(plan.bundle)}` : ''}`;
  }
  function closeAccount() { $('mspAccountDialog')?.close(); }
  function openAccount() {
    if (!$('mspAccountDialog')?.open) $('mspAccountDialog')?.showModal();
    drawAccount();
  }
  window.MSPAdvisorIntegrated = {
    openAccount, updateReviewBanner, refresh:loadState,
    refreshSend() {drawSend();drawQuickSend();},
    isAdmin,
    openAdmin() { if (adminEnabled) { window.switchView('admin'); void refreshAdmin(); } },
    submitFeedback: submitPublicFeedback
  };

  function drawAccount() {
    const node = $('mspAccountBody');
    if (!node) return;
    if (!cfg.enabled || !db) {
      node.innerHTML = '<p>Advisor integration is not configured yet. Configure advisor/config.js and the Supabase schema first.</p>';
      return;
    }
    if (!user) {
      node.innerHTML = `<h3>Sign in</h3><p>Students and advisors use the same account portal. Advisor access requires separate approval.</p>
        <form id="mspLoginForm">
          <label for="mspEmail">Email</label><input id="mspEmail" type="email" autocomplete="username" required>
          <label for="mspPassword">Password</label><input id="mspPassword" type="password" autocomplete="current-password" required>
          <button type="submit" class="btn btn-navy">Sign in</button>
        </form>`;
      return;
    }
    const requested = state?.request?.status;
    node.innerHTML = `<h3>Signed in</h3><p><b>${escapeHTML(user.email)}</b></p>
      <label for="mspName">Your display name</label>
      <div class="msp-row"><input id="mspName" maxlength="120" value="${escapeHTML(state?.profile?.display_name || '')}" placeholder="Display name">
        <button class="btn btn-navy" data-msp-action="saveName">Save name</button></div>
      ${isAdvisor() ? '<p class="msp-note">Approved study advisor. Open <b>My students</b> in the sidebar to review submissions.</p>' :
      eligibleAdvisorRequest() ? `<h4>Register as a study advisor</h4>${requested
        ? `<p>Request status: <b>${escapeHTML(requested)}</b>. Approval is performed by the pilot administrator.</p>`
        : `<div class="msp-row"><input id="mspAdvisorName" maxlength="120" placeholder="Full name"><button class="btn btn-gh" data-msp-action="requestAdvisor">Request advisor access</button></div>`}` : ''}
      <button class="btn btn-gh" data-msp-action="logout">Sign out</button>`;
  }
  function drawSend() {
    const node = $('mspSendBody');
    if (!node) return;
    if (!cfg.enabled || !db) {
      node.innerHTML = '<p>Advisor submission pilot is not yet configured.</p>';
      return;
    }
    if (bridge?.isReviewing()) {
      node.innerHTML = '<p>Advisor review is read-only. Exit review mode to return to your own planner.</p>';
      return;
    }
    if (!user) {
      node.innerHTML = '<p>Sign in to send your plans to your study advisor.</p><button class="btn btn-navy" data-msp-action="account">Sign in</button>';
      return;
    }
    if (isAdvisor()) {
      node.innerHTML = '<p>Advisor account. Open <b>My students</b> in the sidebar to review submissions.</p>';
      return;
    }
    const advisers = state?.advisors || [];
    const assigned = state?.assignment?.advisor_id;
    const periodCount = bridge?.ready() ? collected('period').length : 0;
    const allCount = bridge?.ready() ? collected('all').length : 0;
    const select = advisers.map(a => `<option value="${escapeHTML(a.user_id)}" ${assigned===a.user_id?'selected':''}>${escapeHTML(a.display_name)}</option>`).join('');
    const assignmentValid = !!assigned && advisers.some(a => a.user_id === assigned);
    node.innerHTML = `<p>Only selected courses, practicals and bundles are submitted. Transcripts, GPA and grades stay local.</p>
      ${!state?.profile ? '<p class="msp-warning">Add a display name under Account before sending.</p>' : ''}
      <label for="mspAdvisorSelect">Your study advisor</label>
      <div class="msp-row"><select id="mspAdvisorSelect"><option value="">Choose an advisor</option>${select}</select>
        <button class="btn btn-gh" data-msp-action="saveAdvisor" ${!state?.profile?'disabled':''}>Save advisor</button></div>
      ${!advisers.length ? '<p class="msp-warning">No advisors have been approved yet.</p>' : ''}
      <label for="mspStudentNote">Optional message to advisor</label>
      <textarea id="mspStudentNote" maxlength="1200" rows="2" placeholder="Questions about your planned courses…"></textarea>
      <div class="msp-send-options">
        <button class="btn btn-navy" data-msp-action="submit" data-scope="period" ${!assignmentValid || !state?.profile || !periodCount?'disabled':''}>
          Send this period <small>${escapeHTML(bridge.period())} · ${periodCount} populated plan${periodCount===1?'':'s'}</small>
        </button>
        <button class="btn btn-gh" data-msp-action="submit" data-scope="all" ${!assignmentValid || !state?.profile || !allCount?'disabled':''}>
          Send all periods <small>${allCount} populated plan${allCount===1?'':'s'} across P1, P2, P4 and P5</small>
        </button>
      </div><p class="msp-caption">Empty plans are excluded. Each submission is a saved snapshot; editing your planner later will not change what you sent.</p>
      <p class="msp-submissions-cta"><a class="btn btn-gh" href="#submissions" onclick="switchView('submissions');closeSidebar()">View my submissions →</a></p>`;
  }
  function drawQuickSend() {
    const node = $('mspQuickSend');
    if (!node) return;
    const available = !!cfg.enabled && !!db && !!user && !!state && !isAdvisor() && !bridge?.isReviewing();
    node.hidden = !available;
    if (!available) return;
    const assigned = state?.assignment?.advisor_id;
    const assignmentValid = !!assigned && (state.advisors || []).some(a => a.user_id === assigned);
    const profileValid = !!state.profile?.display_name;
    if (!assignmentValid || !profileValid) {
      node.innerHTML = `<div class="msp-quick-copy"><b>Ready to send a plan?</b><span>Choose your study advisor and save your name first.</span></div>
        <button type="button" class="msp-quick-button msp-quick-setup" data-msp-action="setupSend">Set up submissions <span aria-hidden="true">↓</span></button>`;
      return;
    }
    const period = bridge?.period() || 'P1';
    const currentCount = bridge?.ready() ? collected('period').length : 0;
    const totalCount = bridge?.ready() ? collected('all').length : 0;
    node.innerHTML = `<div class="msp-quick-copy"><b>Share with your advisor</b><span>Only populated plans are sent</span></div>
      <div class="msp-quick-actions">
        <button type="button" class="msp-quick-button msp-quick-primary" data-msp-action="submit" data-scope="period" ${!currentCount?'disabled':''} title="Send all populated A–C plans for ${escapeHTML(period)}">Send ${escapeHTML(period)} <span class="msp-quick-count">${currentCount}</span></button>
        <button type="button" class="msp-quick-button" data-msp-action="submit" data-scope="all" ${!totalCount?'disabled':''} title="Send every populated plan across all periods">Send all <span class="msp-quick-count">${totalCount}</span></button>
      </div>`;
  }

  // Standalone student submissions page: all periods, all versions, and feedback.
  // Render metadata only; full plan_data is loaded on demand by openSnapshot().
  function drawSubmissionHistory() {
    const node = $('mspSubmissionsBody');
    if (!node) return;
    if (!cfg.enabled || !db) { node.innerHTML = '<p class="msp-caption">Advisor integration is not configured.</p>'; return; }
    if (!user || !state) {
      node.innerHTML = '<p class="msp-caption">Sign in to see the plans you have sent to your advisor.</p><button class="btn btn-navy" type="button" data-msp-action="account">Sign in</button>';
      return;
    }
    if (isAdvisor()) { node.innerHTML = '<p class="msp-caption">Advisor accounts can review plans under My students.</p>'; return; }
    const all = state.own || [];
    const newest = submissionVersions(all);
    const lastUpdated = submissionLastUpdated ? `Updated ${submissionLastUpdated.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}` : 'Synced with your account';
    node.innerHTML = `<div class="msp-students-intro"><div class="msp-students-heading">
      <p class="msp-caption">View exactly what you sent, compare with your current plan, and manage saved versions. Your current planner is not changed.</p>
      <div class="msp-students-refresh"><small>${escapeHTML(lastUpdated)}</small><button type="button" class="btn btn-gh msp-refresh-btn" data-msp-action="refreshSubmissions" ${submissionRefreshing?'disabled':''}>${submissionRefreshing?'Refreshing…':'↻ Refresh'}</button></div></div>
      <div class="msp-student-stats"><div><b>${all.length}</b><span>Total submissions</span></div>
        <div><b>${[...newest.values()].filter(v=>v.latest).length}</b><span>Latest plans</span></div>
        <div><b>${all.filter(s=>reviewInfo(s).key==='pending').length}</b><span>Awaiting review</span></div></div>
      <div class="msp-submission-toolbar msp-students-toolbar">
        <label for="mspSubmissionPeriod">Period<select id="mspSubmissionPeriod"><option value="all">All periods</option>${PERIODS.map(p=>`<option value="${p}">${p}</option>`).join('')}</select></label>
        <label for="mspSubmissionReview">Review status<select id="mspSubmissionReview"><option value="all">All statuses</option><option value="pending">Awaiting review</option><option value="reviewed">Reviewed</option><option value="changes">Changes requested</option></select></label>
        <label for="mspSubmissionVersion">Version<select id="mspSubmissionVersion"><option value="all">All versions</option><option value="latest">Latest per plan</option><option value="older">Earlier versions</option></select></label>
      </div></div><div id="mspSubmissionResults" class="msp-submissions-list" aria-live="polite"></div>`;
    $('mspSubmissionPeriod').value = submissionPeriodFilter;
    $('mspSubmissionReview').value = submissionReviewFilter;
    $('mspSubmissionVersion').value = submissionVersionFilter;
    filterSubmissions();
  }
  function filterSubmissions() {
    const node = $('mspSubmissionResults');
    if (!node || !state || isAdvisor()) return;
    const all = [...(state.own || [])].sort((a,b)=> new Date(b.submitted_at) - new Date(a.submitted_at) || String(b.id).localeCompare(String(a.id)));
    const versions = submissionVersions(all);
    const reviews = new Map((state.reviews || []).map(r => [r.submission_id,r]));
    const rows = all.filter(s => {
      const v = versions.get(s.id);
      return (submissionPeriodFilter === 'all' || s.period === submissionPeriodFilter) &&
        (submissionReviewFilter === 'all' || reviewInfo(s).key === submissionReviewFilter) &&
        (submissionVersionFilter === 'all' || (submissionVersionFilter === 'latest' ? v?.latest : !v?.latest));
    });
    node.innerHTML = `<p class="msp-caption msp-submissions-result-count">Showing ${rows.length} of ${all.length} submission${all.length===1?'':'s'}</p>` +
      (rows.map(s => {
        const version=versions.get(s.id) || {version:Number(s.version_number)||1,latest:true};
        const review=reviews.get(s.id);
        return `<section class="msp-history-entry" aria-label="${escapeHTML(s.period)} Plan ${escapeHTML(s.plan_key)} Version ${version.version}">
          <div class="msp-history-header"><div><b>${escapeHTML(s.period)} · Plan ${escapeHTML(s.plan_key)}</b>
          <span class="msp-caption">Version ${version.version} · Sent ${escapeHTML(dateText(s.submitted_at))}</span></div>
          <div class="msp-history-badges">${version.latest?'<span class="msp-status">Latest version</span>':'<span class="msp-status">Earlier version</span>'}${statusHtml(s)}</div></div>
          ${review?.comment ? `<p class="msp-history-comment">${escapeHTML(review.comment)}</p>` : ''}
          <div class="msp-history-actions"><button type="button" class="btn btn-navy" data-msp-action="viewSubmission" data-submission="${escapeHTML(s.id)}">View saved plan</button>
            <button type="button" class="btn btn-gh" data-msp-action="compareSubmission" data-submission="${escapeHTML(s.id)}" ${!bridge?.ready()?'disabled title="Planner is not ready"':''}>Compare with current</button>
            <button type="button" class="btn btn-gh msp-history-delete" data-msp-action="deleteSubmission" data-submission="${escapeHTML(s.id)}">Delete submission</button></div></section>`;
      }).join('') || '<p class="msp-caption msp-submissions-empty">No submissions match your filters.</p>');
  }
  async function deleteSubmission(id) {
    if (!user || !state || isAdvisor()) throw Error('Sign in as a student to manage your submissions.');
    const row=ownSubmission(id);
    const version=submissionVersions(state.own).get(id);
    if (!row || !version) throw Error('This submission is no longer available. Refresh and try again.');
    const sameSlot=(state.own || []).filter(s => s.period===row.period && s.plan_key===row.plan_key);
    const effect = version.latest && sameSlot.length===1
      ? 'This is the ONLY submitted version for this plan; deleting it will leave no submission for this period and plan.'
      : version.latest ? 'This is the LATEST submission. The next newest remaining version will become the latest.'
      : 'This is an earlier submission.';
    if (!confirm(`Permanently delete ${row.period} Plan ${row.plan_key} · Version ${version.version}?\n\n${effect}\n\nAny advisor review and feedback attached to this submission will also be permanently deleted. This cannot be undone.`)) return;
    // SECURITY DEFINER RPC verifies auth.uid() and row ownership in PostgreSQL.
    checked(await db.rpc('delete_plan_submission',{p_submission_id:id}));
    if (user && state) {
      state.own=state.own.filter(s=>s.id!==id);
      state.reviews=(state.reviews||[]).filter(r=>r.submission_id!==id);
      if (selectedSnapshot?.row.id===id) closeSnapshot();
      drawSubmissionHistory();
      drawStudentFeedback();
    }
    notice(`Deleted Version ${version.version} of ${row.period} Plan ${row.plan_key}.`);
    void refreshStudentPeriod(null);
  }
  // Advisor dashboard: filter the newest submissions without concealing older history.
  function drawStudents() {
    const node = $('mspStudentsBody');
    if (!node) return;
    if (!user) { node.innerHTML = '<p>Sign in to view advisor submissions.</p>'; return; }
    if (!isAdvisor()) { node.innerHTML = '<p>You need approved advisor access to see students.</p>'; return; }
    const latest = new Map();
    for (const s of state?.assigned || []) {
      const slot = `${s.student_id}:${s.period}:${s.plan_key}`;
      const prior = latest.get(slot);
      if (!prior || (Number(s.version_number) && Number(prior.version_number) ? Number(s.version_number) > Number(prior.version_number) : new Date(s.submitted_at) > new Date(prior.submitted_at))) latest.set(slot, s);
    }
    const all = [...latest.values()];
    const students = new Set(all.map(s => s.student_id));
    const pending = all.filter(s => reviewInfo(s).key === 'pending').length;
    const completed = all.filter(s => ['reviewed','changes'].includes(reviewInfo(s).key)).length;
    const focused = document.activeElement;
    const focusId = focused?.id === 'mspStudentSearch' || focused?.id === 'mspStudentFilter' ? focused.id : null;
    const focusStart = focusId === 'mspStudentSearch' ? focused.selectionStart : null;
    const focusEnd = focusId === 'mspStudentSearch' ? focused.selectionEnd : null;
    const updatedText = advisorLastUpdated ? `Updated ${advisorLastUpdated.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}` : 'Not refreshed yet';
    node.innerHTML = `<div class="msp-students-intro"><div class="msp-students-heading"><p class="msp-caption">Latest plan versions are counted below. Open a student to review submissions in the planner.</p>
      <div class="msp-students-refresh"><small id="mspStudentsUpdated">${escapeHTML(updatedText)}</small><button type="button" class="btn btn-gh msp-refresh-btn" data-msp-action="refreshStudents" ${advisorRefreshing?'disabled':''}>${advisorRefreshing?'Refreshing…':'↻ Refresh'}</button></div></div>
      <div class="msp-student-stats"><div><b>${students.size}</b><span>Students</span></div><div><b>${pending}</b><span>Awaiting review</span></div><div><b>${completed}</b><span>Feedback sent</span></div></div>
      <div class="msp-students-toolbar"><label for="mspStudentSearch">Find student<input id="mspStudentSearch" type="search" placeholder="Search by student name" value="${escapeHTML(studentSearch)}"></label>
      <label for="mspStudentFilter">Review status<select id="mspStudentFilter"><option value="all">All students</option><option value="pending">Awaiting review</option><option value="changes">Changes requested</option><option value="reviewed">Reviewed</option></select></label></div></div>
      <div id="mspStudentResults" class="msp-student-list" aria-live="polite"></div>`;
    $('mspStudentFilter').value = studentFilter;
    filterStudents();
    if (focusId) {
      const restored = $(focusId);
      restored?.focus({preventScroll:true});
      if (focusId === 'mspStudentSearch' && focusStart !== null) restored.setSelectionRange(focusStart,focusEnd);
    }
  }
  function filterStudents() {
    const node = $('mspStudentResults');
    if (!node || !isAdvisor()) return;
    const grouped = new Map();
    for (const s of state?.assigned || []) {
      if (!grouped.has(s.student_id)) grouped.set(s.student_id, []);
      grouped.get(s.student_id).push(s);
    }
    const names = new Map((state?.profiles || []).map(p => [p.id, p.display_name]));
    const query = studentSearch.trim().toLowerCase();
    const entries = [...grouped].map(([uid, rows]) => {
      const latest = newestBySlot(rows);
      return {uid, latest, name:names.get(uid) || 'Student', newest:Math.max(...latest.map(x => new Date(x.submitted_at).getTime()))};
    }).filter(item => item.name.toLowerCase().includes(query) && (studentFilter === 'all' || item.latest.some(s => reviewInfo(s).key === studentFilter)))
      .sort((a,b) => b.newest - a.newest);
    node.innerHTML = entries.map(item => {
      const waiting = item.latest.filter(s => reviewInfo(s).key === 'pending').length;
      const changes = item.latest.filter(s => reviewInfo(s).key === 'changes').length;
      const badge = waiting ? `<span class="msp-status msp-status-pending">${waiting} awaiting review</span>` : changes
        ? `<span class="msp-status msp-status-changes">${changes} changes requested</span>` : `<span class="msp-status msp-status-reviewed">Reviewed</span>`;
      return `<button type="button" class="msp-student" data-msp-action="openStudent" data-student="${escapeHTML(item.uid)}">
        <span class="msp-student-main"><b>${escapeHTML(item.name)}</b><small>${item.latest.length} latest plan${item.latest.length === 1 ? '' : 's'} · Submitted ${escapeHTML(dateText(item.newest))}</small></span>
        ${badge}<span class="msp-student-open">Open plans →</span></button>`;
    }).join('') || '<p class="msp-caption">No students match your current filters.</p>';
  }
  function syncReviewCompare() {
    const cols = $('cmpview')?.querySelectorAll('.cmp-col');
    if (!cols?.length) return;
    cols.forEach((col, i) => {
      const key = KEYS[i];
      let button = col.querySelector('.msp-cmp-review-state');
      if (!reviewing || !bridge?.isReviewing()) { button?.remove(); return; }
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'msp-cmp-review-state';
        button.dataset.mspAction = 'selectReviewPlan';
        button.dataset.plan = key;
        col.querySelector('.cmp-col-h')?.after(button);
      }
      const row = reviewRow(bridge.period(), key);
      const status = reviewInfo(row);
      const content = `<span>Advisor review</span><span class="msp-status msp-status-${status.key}">${status.label}</span>`;
      if (button.innerHTML !== content) button.innerHTML = content;
      const selected = reviewPlanKey === key;
      if (button.classList.contains('selected') !== selected) button.classList.toggle('selected', selected);
      if (button.getAttribute('aria-pressed') !== String(selected)) button.setAttribute('aria-pressed', String(selected));
      button.disabled = !row;
      button.title = row ? `Give feedback on Plan ${key}` : `No submission for Plan ${key}`;
    });
  }
  function updateReviewBanner() {
    const banner = $('mspReviewBanner');
    if (!banner) return;
    if (!reviewing || !bridge?.isReviewing()) { banner.hidden = true; syncReviewCompare(); return; }
    banner.hidden = false;
    const period = bridge.period();
    if (reviewPeriod !== period) {
      reviewPeriod = period;
      reviewPlanKey = null;
    }
    const latest = KEYS.map(key => reviewRow(period,key)).filter(Boolean);
    if (!reviewPlanKey) reviewPlanKey = latest.some(s => s.plan_key === bridge.planKey()) ? bridge.planKey() : latest[0]?.plan_key || 'A';
    const row = reviewRow(period, reviewPlanKey);
    const review = state?.reviews?.find(x => x.submission_id === row?.id);
    banner.innerHTML = `<div class="msp-review-header"><div><b>Viewing ${escapeHTML(reviewing.name)}'s plans</b><br><small>Read-only review · ${escapeHTML(period)} · Select a submitted plan to give feedback</small></div>
      <button class="btn btn-navy" data-msp-action="exitReview">Exit student review</button></div>
      ${reviewing.hasNewer ? '<p class="msp-warning msp-new-version-warning" role="status">Submitted plans have changed. Exit review and reopen the student to load their current submitted plans.</p>' : ''}
      <div class="msp-review-tabs" role="group" aria-label="Choose a plan for advisor feedback">${KEYS.map(key => {
        const slot = reviewRow(period,key);
        return `<button type="button" class="msp-review-tab ${key === reviewPlanKey ? 'active' : ''}" data-msp-action="selectReviewPlan" data-plan="${key}" aria-pressed="${String(key === reviewPlanKey)}" ${!slot?'disabled':''}>
          <b>Plan ${key}</b>${statusHtml(slot)}</button>`;
      }).join('')}</div>
      ${row ? `<div class="msp-review-detail"><div class="msp-review-meta"><small>Plan ${escapeHTML(reviewPlanKey)} · Submitted ${escapeHTML(dateText(row.submitted_at))}</small>${statusHtml(row)}</div>
        ${row.student_message ? `<p><b>Student message:</b> ${escapeHTML(row.student_message)}</p>` : ''}
        <label for="mspReviewComment">Feedback on Plan ${escapeHTML(reviewPlanKey)}</label><textarea id="mspReviewComment" maxlength="3000" rows="2" placeholder="Optional feedback for this submitted plan">${escapeHTML(reviewDrafts.get(row.id) ?? review?.comment ?? '')}</textarea>
        <div class="msp-row"><button class="btn btn-gh" data-msp-action="review" data-decision="reviewed" data-submission="${escapeHTML(row.id)}">Mark reviewed</button>
          <button class="btn btn-navy" data-msp-action="review" data-decision="changes_requested" data-submission="${escapeHTML(row.id)}">Request changes</button></div>
      </div>` : '<p class="msp-caption">No plan was submitted for this period. Choose another period to review.</p>'}`;
    syncReviewCompare();
  }

  // Feedback form remains available to signed-out visitors. The server validates
  // Turnstile and applies rate limits; never expose the service role in the browser.
  async function submitPublicFeedback(payload) {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw Error('Feedback service is not configured.');
    let token = null;
    if (db) {
      const session = await db.auth.getSession();
      if (!session.error) token = session.data.session?.access_token || null;
    }
    const response = await fetch(`${cfg.supabaseUrl.replace(/\/$/,'')}/functions/v1/submit-feedback`, {
      method:'POST',
      headers: {'Content-Type':'application/json','apikey':cfg.supabaseAnonKey,...(token?{Authorization:`Bearer ${token}`}:{})},
      body:JSON.stringify(payload)
    });
    const result = await response.json().catch(()=>({}));
    if (!response.ok || !result.ok) throw Error(result.error || 'Could not send your report. Try again.');
  }

  function adminStatus(status) {
    const names = {new:'New',in_progress:'In progress',resolved:'Resolved',closed:'Closed',
      pending:'Pending',approved:'Approved',rejected:'Denied'};
    return names[status] || status;
  }
  function adminBadge(status) {
    const cls = {new:'pending',in_progress:'pending',resolved:'reviewed',closed:'',
      pending:'pending',approved:'reviewed',rejected:'changes'}[status] || '';
    return `<span class="msp-status ${cls?'msp-status-'+cls:''}">${escapeHTML(adminStatus(status))}</span>`;
  }
  function renderAdmin() {
    const root = $('mspAdminBody');
    if (!root) return;
    if (!adminEnabled) { root.innerHTML='<p class="msp-caption">Administrator access is required.</p>'; return; }
    const data = adminData;
    const reports = data?.reports || [], requests = data?.requests || [], advisors = data?.advisors || [];
    const count = (s) => reports.filter(r=>r.status===s).length;
    root.innerHTML = `<div class="msp-admin-top">
      <p class="msp-caption">Manage planner feedback and verified study advisor access. Changes are saved to Supabase.</p>
      <button class="btn btn-gh msp-refresh-btn" type="button" data-msp-action="refreshAdmin" ${adminBusy?'disabled':''}>${adminBusy?'Refreshing…':'↻ Refresh'}</button></div>
      <div class="msp-student-stats"><div><b>${count('new')}</b><span>New reports</span></div>
      <div><b>${requests.filter(r=>r.status==='pending').length}</b><span>Advisor requests</span></div>
      <div><b>${advisors.filter(a=>a.active).length}</b><span>Active advisors</span></div></div>
      <div class="msp-admin-tabs" role="group" aria-label="Administration sections">
        ${[['reports','Reports'],['requests','Advisor requests'],['advisors','All advisors']].map(([tab,label])=>
          `<button type="button" class="btn ${adminTab===tab?'btn-navy':'btn-gh'}" data-msp-action="adminTab" data-tab="${tab}" aria-pressed="${adminTab===tab}">${label}</button>`).join('')}
      </div><div id="mspAdminPanel">${!data?'<p class="msp-caption">Loading administration data…</p>':''}</div>`;
    renderAdminPanel();
  }
  function renderAdminPanel() {
    const panel=$('mspAdminPanel');
    if (!panel || !adminData || !adminEnabled) return;
    if (adminTab==='reports') {
      const reports=adminData.reports||[];
      const rows=reports.filter(r => (adminStatusFilter==='all'||r.status===adminStatusFilter) &&
        `${r.title} ${r.message} ${r.email} ${r.report_type}`.toLowerCase().includes(adminQuery.toLowerCase()));
      panel.innerHTML=`<div class="msp-admin-filters msp-students-toolbar">
        <label>Search reports<input id="mspAdminSearch" type="search" placeholder="Title, issue, contact" value="${escapeHTML(adminQuery)}"></label>
        <label>Status<select id="mspAdminStatusFilter">${[['all','All statuses'],['new','New'],['in_progress','In progress'],['resolved','Resolved'],['closed','Closed']].map(([v,l])=>`<option value="${v}" ${adminStatusFilter===v?'selected':''}>${l}</option>`).join('')}</select></label></div>
        <p class="msp-caption">Showing ${rows.length} of ${reports.length} newest reports (maximum 250)</p>
        <div class="msp-admin-list">${rows.map(r=>`<article class="msp-admin-item"><div class="msp-history-header"><div>
          <b>${escapeHTML(r.title)}</b><span class="msp-caption">${escapeHTML(r.report_type)} · ${escapeHTML(dateText(r.created_at))}</span></div>${adminBadge(r.status)}</div>
          <p class="msp-admin-message">${escapeHTML(r.message)}</p>
          ${r.expected_behaviour?`<details><summary>Expected behavior</summary><p class="msp-admin-message">${escapeHTML(r.expected_behaviour)}</p></details>`:''}
          ${r.email?`<p class="msp-caption">Contact: <a href="mailto:${encodeURIComponent(r.email).replace(/%40/g,'@')}">${escapeHTML(r.email)}</a></p>`:''}
          ${r.diagnostics && Object.keys(r.diagnostics).length?`<details><summary>Technical information</summary><pre class="msp-admin-diagnostics">${escapeHTML(JSON.stringify(r.diagnostics,null,2))}</pre></details>`:''}
          <div class="msp-admin-actions"><label>Review status
          <select data-msp-admin-report="${escapeHTML(r.id)}" aria-label="Report status">${['new','in_progress','resolved','closed'].map(v=>`<option value="${v}" ${r.status===v?'selected':''}>${adminStatus(v)}</option>`).join('')}</select></label></div>
          </article>`).join('')||'<p class="msp-caption">No reports match these filters.</p>'}</div>`;
    } else if(adminTab==='requests') {
      const requests=adminData.requests||[];
      const rows=requests.filter(r=>adminRequestFilter==='all'||r.status===adminRequestFilter);
      panel.innerHTML=`<div class="msp-admin-filters msp-students-toolbar"><label>Request status
        <select id="mspAdminRequestFilter"><option value="pending" ${adminRequestFilter==='pending'?'selected':''}>Pending</option><option value="all" ${adminRequestFilter==='all'?'selected':''}>All requests</option><option value="approved" ${adminRequestFilter==='approved'?'selected':''}>Approved</option><option value="rejected" ${adminRequestFilter==='rejected'?'selected':''}>Denied</option></select></label></div>
        <div class="msp-admin-list">${rows.map(r=>`<article class="msp-admin-item"><div class="msp-history-header"><div><b>${escapeHTML(r.display_name)}</b><span class="msp-caption">${escapeHTML(r.email||'No account email')} · ${escapeHTML(dateText(r.created_at))}</span></div>${adminBadge(r.status)}</div>
        ${r.status==='pending'?`<p class="msp-caption">Verify the person's institutional identity and advisor eligibility before approval.</p><div class="msp-admin-actions">
        <button type="button" class="btn btn-navy" data-msp-action="adminApproveAdvisor" data-user="${escapeHTML(r.user_id)}">Approve</button>
        <button type="button" class="btn btn-gh" data-msp-action="adminRejectAdvisor" data-user="${escapeHTML(r.user_id)}">Deny</button></div>`:''}</article>`).join('')||'<p class="msp-caption">No advisor requests to show.</p>'}</div>`;
    } else {
      const advisors=adminData.advisors||[];
      panel.innerHTML=`<p class="msp-caption">${advisors.length} approved advisor account${advisors.length===1?'':'s'} · inactive advisors cannot access student submissions.</p>
      <div class="msp-admin-list">${advisors.map(a=>`<article class="msp-admin-item"><div class="msp-history-header"><div><b>${escapeHTML(a.display_name)}</b>
      <span class="msp-caption">${escapeHTML(a.email||'No account email')} · ${Number(a.students)||0} assigned student(s)</span></div>${adminBadge(a.active?'approved':'closed')}</div>
      <div class="msp-admin-actions"><button type="button" class="btn btn-gh" data-msp-action="adminToggleAdvisor" data-user="${escapeHTML(a.user_id)}" data-active="${a.active?'false':'true'}">${a.active?'Deactivate advisor':'Reactivate advisor'}</button></div></article>`).join('')||'<p class="msp-caption">No advisors have been approved yet.</p>'}</div>`;
    }
  }
  async function refreshAdmin() {
    if (!adminEnabled || !db || adminBusy) return;
    adminBusy=true;renderAdmin();
    try {
      const result=checked(await db.rpc('msp_admin_dashboard'));
      if (!adminEnabled || !user) return;
      adminData=result;renderAdmin();
    } catch(err) { report(err); } finally { adminBusy=false;renderAdmin(); }
  }
  async function adminAction(action,target) {
    if (!adminEnabled) throw Error('Administrator access required.');
    if (action==='adminTab') { adminTab=target.dataset.tab;renderAdmin();return; }
    if (action==='refreshAdmin') {await refreshAdmin();return;}
    if (action==='adminApproveAdvisor'||action==='adminRejectAdvisor') {
      const uid=target.dataset.user;
      const request=adminData?.requests?.find(r=>r.user_id===uid && r.status==='pending');
      if (!request) throw Error('This request is no longer pending. Refresh the page.');
      const decision=action==='adminApproveAdvisor'?'approved':'rejected';
      const ask=decision==='approved'?`Approve ${request.display_name} (${request.email}) as an advisor? Confirm their institutional identity first.`:`Deny advisor access for ${request.display_name}?`;
      if (!confirm(ask)) return;
      checked(await db.rpc('msp_admin_review_request',{p_user_id:uid,p_decision:decision}));
      notice(`Advisor request ${decision==='approved'?'approved':'denied'}.`);
      await refreshAdmin();return;
    }
    if (action==='adminToggleAdvisor') {
      const advisor=adminData?.advisors?.find(a=>a.user_id===target.dataset.user);
      if (!advisor) throw Error('Advisor not found. Refresh the list.');
      const makeActive=target.dataset.active==='true';
      if (!confirm(`${makeActive?'Reactivate':'Deactivate'} ${advisor.display_name}? ${!makeActive?'They will lose access to students until reactivated.':''}`)) return;
      checked(await db.rpc('msp_admin_set_advisor_active',{p_user_id:advisor.user_id,p_active:makeActive}));
      notice(`Advisor ${makeActive?'reactivated':'deactivated'}.`);
      await refreshAdmin();return;
    }
    throw Error('Unknown administration action.');
  }

  async function loadState() {
    const n=++refreshSerial;
    ++studentRefreshSerial;
    ++advisorRefreshSerial;
    advisorRefreshing = false;
    if (!db || !user) { state=null;adminEnabled=false;adminData=null;render();return; }
    const uid=user.id;
    try {
      const [adminResult,list]=await Promise.all([
        db.rpc('msp_is_admin'),
        Promise.all([
        db.from('profiles').select('id,display_name').eq('id',uid).maybeSingle(),
        db.from('advisors').select('user_id,display_name,active').eq('active',true).order('display_name'),
        db.from('advisor_assignments').select('student_id,advisor_id').eq('student_id',uid).maybeSingle(),
        db.from('advisor_requests').select('user_id,status,display_name').eq('user_id',uid).maybeSingle(),
        db.from('plan_submissions').select('id,period,plan_key,submitted_at,version_number').eq('student_id',uid).order('submitted_at',{ascending:false}),
        db.from('advisors').select('user_id,display_name,active').eq('user_id',uid).maybeSingle()
        ])
      ]);
      list.forEach(checked);
      if (adminResult.error) console.warn('Admin role check unavailable:',adminResult.error.message);
      const [profile,advisors,assignment,request,own,advisor]=list.map(x=>x.data);
      const assigned=advisor?.active ? checked(await db.from('plan_submissions').select('id,student_id,advisor_id,period,plan_key,plan_data,student_message,submitted_at').eq('advisor_id',uid).order('submitted_at',{ascending:false})) : [];
      const ids=[...new Set([...(own||[]),...assigned].map(x=>x.id))];
      const reviews=ids.length ? checked(await db.from('plan_reviews').select('submission_id,advisor_id,decision,comment,reviewed_at').in('submission_id',ids)) : [];
      const studentIds=[...new Set(assigned.map(x=>x.student_id))];
      const profiles=studentIds.length ? checked(await db.from('profiles').select('id,display_name').in('id',studentIds)) : [];
      if (n!==refreshSerial || uid!==user?.id) return;
      adminEnabled = adminResult.error ? false : adminResult.data === true;
      if (!adminEnabled) adminData=null;
      state={profile,advisors:advisors||[],assignment,request,own:own||[],advisor,assigned,reviews,profiles};
      if (advisor?.active) advisorLastUpdated = new Date();
      else submissionLastUpdated = new Date();
      render();
      if (selectedSnapshot) {
        if (ownSubmission(selectedSnapshot.row.id)) drawSnapshot();
        else closeSnapshot();
      }
      ensureRealtime();
    } catch(e) { if (n===refreshSerial) { report(e); render(); } }
  }
  // Cache-first period changes: repaint synchronously; fetch only this period's
  // metadata and reviews in the background (no plan_data downloads).
  async function refreshStudentPeriod(period, manual=false) {
    if (!db || !user || !state || isAdvisor() || (period !== null && !PERIODS.includes(period))) return;
    const uid = user.id;
    const n = ++studentRefreshSerial;
    if (manual) { submissionRefreshing=true; drawSubmissionHistory(); }
    try {
      let query = db.from('plan_submissions').select('id,period,plan_key,submitted_at,version_number').eq('student_id',uid);
      if (period !== null) query = query.eq('period',period);
      const rows = checked(await query.order('submitted_at',{ascending:false}));
      const ids = rows.map(row => row.id);
      const reviews = ids.length ? checked(await db.from('plan_reviews')
        .select('submission_id,advisor_id,decision,comment,reviewed_at').in('submission_id',ids)) : [];
      if (n !== studentRefreshSerial || uid !== user?.id || !state || isAdvisor()) return;
      const oldIds = new Set((state.own || []).filter(row => period === null || row.period === period).map(row => row.id));
      state.own = [...(state.own || []).filter(row => period !== null && row.period !== period),...rows];
      state.reviews = [...(state.reviews || []).filter(row => !oldIds.has(row.submission_id)),...reviews];
      feedbackRefreshError = false;
      submissionLastUpdated = new Date();
      if (manual) submissionRefreshing=false;
      drawStudentFeedback();
      drawSubmissionHistory();
      if (selectedSnapshot) {
        if (!ownSubmission(selectedSnapshot.row.id)) closeSnapshot();
        else drawSnapshot();
      }
    } catch (err) {
      if (n === studentRefreshSerial && uid === user?.id) {
        feedbackRefreshError = true;
        drawStudentFeedback();
        console.warn('Could not refresh advisor feedback:', err);
        if (manual) notice(`Could not refresh submissions: ${err.message || err}`, true);
      }
    } finally {
      if (n === studentRefreshSerial && manual) { submissionRefreshing=false; drawSubmissionHistory(); }
    }
  }

  // Dashboard refresh is independent of the planner and avoids reloading
  // profile/account settings and rebuilding a student's local plan.
  async function refreshAdvisorData() {
    if (!db || !user || !state || !isAdvisor()) return;
    const uid = user.id;
    const n = ++advisorRefreshSerial;
    advisorRefreshing = true;
    const btn = document.querySelector('#mspStudentsBody [data-msp-action="refreshStudents"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try {
      const assigned = checked(await db.from('plan_submissions')
        .select('id,student_id,advisor_id,period,plan_key,plan_data,student_message,submitted_at')
        .eq('advisor_id',uid).order('submitted_at',{ascending:false}));
      const ids = [...new Set([...(state.own || []),...assigned].map(row => row.id))];
      const studentIds = [...new Set(assigned.map(row => row.student_id))];
      const [reviewsResult,profilesResult] = await Promise.all([
        ids.length ? db.from('plan_reviews').select('submission_id,advisor_id,decision,comment,reviewed_at').in('submission_id',ids) : Promise.resolve({data:[],error:null}),
        studentIds.length ? db.from('profiles').select('id,display_name').in('id',studentIds) : Promise.resolve({data:[],error:null})
      ]);
      const reviews = checked(reviewsResult);
      const profiles = checked(profilesResult);
      if (n !== advisorRefreshSerial || uid !== user?.id || !state || !isAdvisor()) return;
      state.assigned = assigned;
      state.reviews = reviews;
      state.profiles = profiles;
      advisorLastUpdated = new Date();
      // The planner is a read-only snapshot. Do not silently swap its plans
      // while the advisor is writing feedback about an earlier version.
      if (reviewing) {
        const remote = newestBySlot(assigned.filter(row => row.student_id === reviewing.student));
        const opened = newestBySlot(reviewing.rows);
        reviewing.hasNewer = remote.some(row => !opened.some(old =>
          old.period === row.period && old.plan_key === row.plan_key && old.id === row.id)) ||
          opened.some(old => !assigned.some(row => row.id === old.id));
      }
      drawStudents();
      if (reviewing) updateReviewBanner();
    } catch (err) {
      if (n === advisorRefreshSerial && uid === user?.id) {
        console.warn('Could not refresh student submissions:', err);
        notice(`Could not refresh students: ${err.message || err}`, true);
      }
    } finally {
      if (n === advisorRefreshSerial) {
        advisorRefreshing = false;
        const button = document.querySelector('#mspStudentsBody [data-msp-action="refreshStudents"]');
        if (button) { button.disabled = false; button.textContent = '↻ Refresh'; }
      }
    }
  }

  // PostgreSQL change events can trigger an incremental refresh when the two
  // tables are enabled in Supabase's realtime publication. Manual refresh and
  // period-change fetching continue working if realtime is unavailable.
  function stopRealtime() {
    clearTimeout(realtimeTimer); realtimeTimer = null;
    if (realtimeChannel && db?.removeChannel) void db.removeChannel(realtimeChannel);
    realtimeChannel = null; realtimeUserId = null; realtimeRole = null;
  }
  function scheduleRealtimeRefresh() {
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(() => {
      realtimeTimer = null;
      if (!user || !state) return;
      if (isAdvisor()) void refreshAdvisorData();
      else void refreshStudentPeriod(null);
    }, 150);
  }
  function ensureRealtime() {
    if (!db?.channel || !user || !state) return;
    if (realtimeChannel && realtimeUserId === user.id && realtimeRole === isAdvisor()) return;
    stopRealtime();
    realtimeUserId = user.id;
    realtimeRole = isAdvisor();
    const submissionFilter = `${isAdvisor() ? 'advisor_id' : 'student_id'}=eq.${user.id}`;
    try {
      realtimeChannel = db.channel(`msp-advisor-data-${user.id}`)
        .on('postgres_changes',{event:'*',schema:'public',table:'plan_submissions',filter:submissionFilter},scheduleRealtimeRefresh)
        .on('postgres_changes',{event:'*',schema:'public',table:'plan_reviews'},scheduleRealtimeRefresh)
        .subscribe();
    } catch(err) {
      console.warn('Realtime updates unavailable; using period and manual refresh:',err);
      stopRealtime();
    }
  }
  function periodChanged() {
    feedbackRefreshError = false;
    drawStudentFeedback();
    if (reviewing) updateReviewBanner();
    if (user && state && !isAdvisor()) void refreshStudentPeriod(bridge?.period());
  }

  function render() {
    const studentsLink=$('mspStudentsLink');
    if (studentsLink) studentsLink.hidden = !isAdvisor();
    const submissionsLink=$('mspSubmissionsLink');
    if (submissionsLink) submissionsLink.hidden = !user || !state || isAdvisor();
    const adminLink=$('mspAdminLink');
    if (adminLink) adminLink.hidden=!adminEnabled;
    if (!adminEnabled && $('view-admin')?.classList.contains('active')) window.switchView('dashboard');
    const button=$('mspAccountLink');
    if (button) button.querySelector('.sb-hint').textContent = user ? user.email : 'Sign in';
    drawAccount();drawSend();drawQuickSend();drawStudentFeedback();drawSubmissionHistory();drawStudents();updateReviewBanner();renderAdmin();
  }
  async function act(action, target) {
    if (busy && action === 'closeSnapshot') { closeSnapshot(); return; }
    if (busy) return;
    busy=true;
    target.disabled=true;
    const oldLabel = target.innerHTML;
    const progress = {adminApproveAdvisor:'Approving…',adminRejectAdvisor:'Denying…',adminToggleAdvisor:'Saving…',deleteSubmission:'Deleting…',refreshSubmissions:'Refreshing…',submit:'Submitting…',requestAdvisor:'Sending request…',saveAdvisor:'Saving…',saveName:'Saving…',logout:'Signing out…',review:'Saving review…'}[action];
    if (progress) target.textContent=progress;
    try {
      notice('');
      if (action==='account') {openAccount();return;}
      if (action==='logout') {
        closeSnapshot(); stopRealtime(); ++studentRefreshSerial; ++advisorRefreshSerial; reviewDrafts.clear();
        if (bridge?.isReviewing()) {await bridge.exitReview();reviewing=null;}
        checked(await db.auth.signOut());user=null;state=null;adminEnabled=false;adminData=null;closeAccount();render();notice('Signed out.');return;
      }
      if (!user) throw Error('Sign in first.');
      if (action.startsWith('admin')) {
        await adminAction(action,target);
      } else if (action==='viewSubmission' || action==='compareSubmission') {
        await openSnapshot(target.dataset.submission,action==='compareSubmission');
      } else if (action==='snapshotView' || action==='snapshotCompare') {
        if (!selectedSnapshot) throw Error('Open a submitted plan first.');
        selectedSnapshot.compare = action==='snapshotCompare';
        drawSnapshot();
      } else if (action==='closeSnapshot') {
        closeSnapshot();
      } else if (action==='deleteSubmission') {
        await deleteSubmission(target.dataset.submission);
      } else if (action==='refreshSubmissions') {
        if (isAdvisor()) throw Error('Only students can refresh their submissions.');
        await refreshStudentPeriod(null, true);
      } else if (action==='refreshStudents') {
        if (!isAdvisor()) throw Error('Only advisors can refresh the student list.');
        await refreshAdvisorData();
      } else if (action==='saveName') {
        const name=elVal('mspName');if (!name || name.length>120) throw Error('Enter a name (1–120 characters).');
        checked(await db.from('profiles').upsert({id:user.id,display_name:name,updated_at:new Date().toISOString()},{onConflict:'id'}));
        await loadState();notice('Name saved.');
      } else if(action==='requestAdvisor') {
        if (!eligibleAdvisorRequest()) throw Error('Advisor registration is not available for this account.');
        const name=elVal('mspAdvisorName');if (!name || name.length>120) throw Error('Enter a display name.');
        checked(await db.from('advisor_requests').insert({user_id:user.id,display_name:name,status:'pending'}));
        await loadState();notice('Advisor registration requested. An administrator must approve it.');
      } else if(action==='saveAdvisor') {
        const id=elVal('mspAdvisorSelect');if (!id) throw Error('Select an approved study advisor first.');
        checked(await db.from('advisor_assignments').upsert({student_id:user.id,advisor_id:id,assigned_at:new Date().toISOString()},{onConflict:'student_id'}));
        await loadState();notice('Your study advisor was saved.');
      } else if(action==='setupSend') {
        const node=$('mspSendArea');
        node?.scrollIntoView({behavior:'smooth', block:'center'});
      } else if(action==='submit') {
        if (bridge?.isReviewing()) throw Error('Exit advisor review mode first.');
        if (isAdvisor()) throw Error('Advisor accounts cannot send a student submission.');
        const scope=target.dataset.scope;
        if (!['period','all'].includes(scope)) throw Error('Invalid submission choice.');
        const plans=collected(scope);
        if (!plans.length) throw Error('No populated plans were found for this selection.');
        const advisor=checked(await db.from('advisor_assignments').select('advisor_id').eq('student_id',user.id).maybeSingle());
        if (!advisor) throw Error('Save your approved study advisor first.');
        const note=elVal('mspStudentNote');if(note.length>1200) throw Error('Message is too long.');
        const labels=plans.map(x=>`${x.period} ${x.key}`).join(', ');
        if (!confirm(`Send ${plans.length} populated plan(s) (${labels}) to your advisor? They will be saved as read-only snapshots.`)) return;
        const rows=plans.map(x=>({student_id:user.id,advisor_id:advisor.advisor_id,period:x.period,plan_key:x.key,plan_data:x.plan,student_message:note}));
        checked(await db.from('plan_submissions').insert(rows));
        await loadState();notice(`Sent ${plans.length} populated plan(s) to your advisor.`);
      } else if(action==='selectReviewPlan') {
        if (!reviewing || !bridge?.isReviewing()) throw Error('Open a student first.');
        const key=target.dataset.plan;
        if (!KEYS.includes(key) || !reviewRow(bridge.period(),key)) throw Error('No submitted plan to review.');
        reviewPlanKey=key;reviewPeriod=bridge.period();updateReviewBanner();
      } else if(action==='openStudent') {
        if (!isAdvisor()) throw Error('You are not an approved advisor.');
        const uid=target.dataset.student;
        const rows=(state.assigned||[]).filter(s=>s.student_id===uid);
        if (!rows.length) throw Error('No assigned submissions found for this student.');
        const name=state.profiles.find(x=>x.id===uid)?.display_name || 'Student';
        await bridge.showReview(rows);
        reviewing={student:uid,name,rows,hasNewer:false};
        reviewDrafts.clear();
        reviewPeriod=null;reviewPlanKey=null;
        window.switchView('planner');
        // A review begins in Compare. The bridge may already activate it in
        // earlier installs, so never toggle an already-visible comparison off.
        const compareView = $('cmpview');
        if (compareView && !compareView.classList.contains('show')) {
          if (typeof window.toggleCmp !== 'function') {
            throw Error('Planner comparison view is unavailable.');
          }
          window.toggleCmp();
        }
        updateReviewBanner();drawQuickSend();notice(`Viewing ${name}'s submitted plans. This is read-only.`);
      } else if(action==='exitReview') {
        await bridge.exitReview();reviewing=null;reviewDrafts.clear();reviewPeriod=null;reviewPlanKey=null;updateReviewBanner();drawSend();drawQuickSend();drawStudentFeedback();notice('Returned to your original local planner.');
      } else if(action==='review') {
        if (!isAdvisor() || !reviewing) throw Error('Open an assigned student first.');
        const id=target.dataset.submission;
        if (reviewRow(bridge.period(), reviewPlanKey)?.id !== id) throw Error('Select the submitted plan again before saving feedback.');
        const decision=target.dataset.decision;
        if(!['reviewed','changes_requested'].includes(decision)) throw Error('Invalid review decision.');
        const comment=elVal('mspReviewComment');if(comment.length>3000) throw Error('Feedback is too long.');
        checked(await db.from('plan_reviews').upsert({submission_id:id,advisor_id:user.id,decision,comment,reviewed_at:new Date().toISOString()},{onConflict:'submission_id'}));
        reviewDrafts.delete(id);
        await loadState();notice('Advisor feedback saved.');
      }
    } catch(e) {report(e);} finally {
      busy=false;
      if (target.isConnected) { target.disabled=false; if (progress) target.innerHTML=oldLabel; }
    }
  }
  document.addEventListener('input', e => {
    if (e.target.id === 'mspAdminSearch') { adminQuery=e.target.value; const pos=e.target.selectionStart; renderAdminPanel(); const next=$('mspAdminSearch'); if(next){next.focus();next.setSelectionRange(pos,pos);} }
    if (e.target.id === 'mspReviewComment' && reviewing) {
      const row = reviewRow(bridge.period(),reviewPlanKey);
      if (row) reviewDrafts.set(row.id,e.target.value);
    }
    if (e.target.id === 'mspStudentSearch') { studentSearch = e.target.value; filterStudents(); }
  });
  document.addEventListener('change', async e => {
    if (e.target.id === 'mspAdminStatusFilter') {adminStatusFilter=e.target.value;renderAdminPanel();}
    if (e.target.id === 'mspAdminRequestFilter') {adminRequestFilter=e.target.value;renderAdminPanel();}
    if (e.target.matches('[data-msp-admin-report]')) {
      if (!adminEnabled || !adminData) return;
      const id=e.target.dataset.mspAdminReport, status=e.target.value;
      e.target.disabled=true;
      try {
        checked(await db.rpc('msp_admin_set_feedback_status',{p_report_id:id,p_status:status}));
        const report=adminData.reports.find(r=>r.id===id);
        if (report) report.status=status;
        notice('Report status saved.');renderAdmin();
      } catch(err) {report(err);await refreshAdmin();} finally {if(e.target.isConnected)e.target.disabled=false;}
    }
    if (e.target.id === 'mspStudentFilter') { studentFilter = e.target.value; filterStudents(); }
    if (e.target.id === 'mspSubmissionPeriod') { submissionPeriodFilter = e.target.value; filterSubmissions(); }
    if (e.target.id === 'mspSubmissionReview') { submissionReviewFilter = e.target.value; filterSubmissions(); }
    if (e.target.id === 'mspSubmissionVersion') { submissionVersionFilter = e.target.value; filterSubmissions(); }
  });
  document.addEventListener('click', e => {
    if (e.target.closest('#mspAdminLink') && adminEnabled) void refreshAdmin();
    const btn=e.target.closest('[data-msp-action]');
    if (!btn) return;
    e.preventDefault();act(btn.dataset.mspAction,btn);
  });
  document.addEventListener('submit', async e=>{
    if(e.target.id!=='mspLoginForm')return;
    e.preventDefault();if(busy)return;
    const email=elVal('mspEmail');const password=$('mspPassword')?.value || '';
    if(!email || !password){notice('Enter both your email and password.',true);return;}
    busy=true;
    try {
      notice('');
      const response=checked(await db.auth.signInWithPassword({email,password}));
      if (!response?.user) throw Error('No authenticated user returned.');
      user=response.user;
      if($('mspPassword')) $('mspPassword').value='';
      await loadState();closeAccount();notice('Signed in.');
    } catch(e){report(e);}finally{busy=false;}
  });
  document.addEventListener('click',e=>{
    if (!bridge?.isReviewing()) return;
    const tab = e.target.closest('.ptab');
    if (tab && /^tab-[ABC]$/.test(tab.id)) { reviewPlanKey = tab.id.slice(-1); reviewPeriod = bridge.period(); }
    if (e.target.closest('.ptab')) queueMicrotask(updateReviewBanner);
  });
  document.addEventListener('click', e => {
    if (e.target.closest('.pd-btn')) setTimeout(() => {drawSend();drawQuickSend();}, 500);
  });
  // Keep the compact counts current when course choices change.
  let quickTimer = null;
  function deferQuickSend() {
    clearTimeout(quickTimer);
    quickTimer = setTimeout(drawQuickSend, 220);
  }
  document.addEventListener('change', e => {
    if (e.target.closest('#view-planner')) deferQuickSend();
  });
  document.addEventListener('click', e => {
    if (e.target.closest('#view-planner') && !e.target.closest('[data-msp-action]')) deferQuickSend();
  });
  // The planner redraws its selectors when period/plan changes.
  // The planner sets the active period button immediately, before awaiting CSV.
  // Observing that change avoids the old 650 ms delay and catches code-driven switches.
  let observedPeriod = bridge?.period();
  const periodGrid = $('periodGrid');
  if (periodGrid) new MutationObserver(() => {
    const next = bridge?.period();
    if (!next || next === observedPeriod) return;
    observedPeriod = next;
    periodChanged();
  }).observe(periodGrid,{subtree:true,attributes:true,attributeFilter:['class']});
  const observer=new MutationObserver(() => { if (bridge?.isReviewing()) bridge.lockInputs(); });
  const planview=$('view-planner');if(planview) observer.observe(planview,{childList:true,subtree:true});
  const compareView=$('cmpview');
  const compareObserver=new MutationObserver(syncReviewCompare);
  if (compareView) compareObserver.observe(compareView,{childList:true,subtree:true});
  async function init() {
    if(!cfg.enabled){render();return;}
    if(!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase?.createClient){
      notice('Supabase configuration is missing or the JavaScript client did not load.',true);render();return;
    }
    if (!bridge){notice('Planner integration bridge missing; run the installer.',true);return;}
    db=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    try {
      const {data,error}=await db.auth.getSession();if(error)throw error;
      user=data.session?.user || null;
      await loadState();
      db.auth.onAuthStateChange((_event,session)=>{
        const next=session?.user || null;
        if(next?.id===user?.id)return;
        closeSnapshot(); stopRealtime(); ++studentRefreshSerial; ++advisorRefreshSerial; reviewDrafts.clear();
        user=next;
        if(bridge.isReviewing()) {void bridge.exitReview().then(()=>{reviewing=null;});}
        state=null;setTimeout(loadState,0);
      });
    } catch(e){report(e);render();}
  }
  window.addEventListener('pageshow',()=>{drawSend();drawQuickSend();if(adminEnabled && $('view-admin')?.classList.contains('active')) void refreshAdmin();});
  window.addEventListener('hashchange',()=>{if (location.hash==='#admin' && adminEnabled && !adminData) void refreshAdmin();});
  // Returning to a suspended tab also checks student feedback when live events
  // were unavailable or the network connection was interrupted.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && user && state && !isAdvisor())
      void refreshStudentPeriod(bridge?.period());
  });
  init();
})();
