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
  let user = null;
  let state = null;
  let reviewing = null;
  let busy = false;
  let refreshSerial = 0;
  const notice = (text, error=false) => {
    const node = $('mspNotice');
    if (!node) return;
    node.textContent = text;
    node.dataset.error = String(error);
  };
  const report = err => notice(err?.message || String(err), true);
  const elVal = id => $(id)?.value?.trim() || '';
  const isAdvisor = () => !!state?.advisor?.active;
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
  window.MSPAdvisorIntegrated = {openAccount, updateReviewBanner, refresh: loadState, refreshSend() {drawSend();drawQuickSend();}};

  function drawAccount() {
    const node = $('mspAccountBody');
    if (!node) return;
    if (!cfg.enabled || !db) {
      node.innerHTML = '<p>Advisor integration is not configured yet. Configure advisor/config.js and the Supabase schema first.</p>';
      return;
    }
    if (!user) {
      node.innerHTML = `<h3>Sign in</h3><p>Students and advisors use the same account. Advisor access requires separate approval.</p>
        <form id="mspLoginForm">
          <label for="mspEmail">Email</label><input id="mspEmail" type="email" autocomplete="username" required>
          <label for="mspPassword">Password</label><input id="mspPassword" type="password" autocomplete="current-password" required>
          <button type="submit" class="btn btn-navy">Sign in</button>
        </form><small>Only use fictitious student data during the pilot.</small>`;
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
      </div><p class="msp-caption">Empty plans are excluded. Each submission is a permanent snapshot; editing your planner later will not change what you sent.</p>
      ${renderOwnSubmissions()}`;
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

  function renderOwnSubmissions() {
    const submissions = state?.own || [];
    const reviews = new Map((state?.reviews || []).map(r => [r.submission_id, r]));
    if (!submissions.length) return '<p class="msp-caption">You have not sent any plans yet.</p>';
    return `<details class="msp-history"><summary>My previous submissions (${submissions.length})</summary><div class="msp-history-list">${submissions.map(s=>{
      const review=reviews.get(s.id);
      return `<div><b>${escapeHTML(s.period)} Plan ${escapeHTML(s.plan_key)}</b> · ${escapeHTML(dateText(s.submitted_at))}<br>
        ${escapeHTML(review?.decision==='reviewed'?'Reviewed':review?'Changes requested':'Pending review')}${review?.comment?` · ${escapeHTML(review.comment)}`:''}</div>`;
    }).join('')}</div></details>`;
  }
  function drawStudents() {
    const node = $('mspStudentsBody');
    if (!node) return;
    if (!user) { node.innerHTML = '<p>Sign in to view advisor submissions.</p>'; return; }
    if (!isAdvisor()) { node.innerHTML = '<p>You need approved advisor access to see students.</p>'; return; }
    const grouped = new Map();
    for (const s of state?.assigned || []) {
      if (!grouped.has(s.student_id)) grouped.set(s.student_id, []);
      grouped.get(s.student_id).push(s);
    }
    const names = new Map((state?.profiles || []).map(p=>[p.id, p.display_name]));
    node.innerHTML = `<p>${grouped.size} student(s) have sent plans to you. Select a student to open their latest submitted plans <b>inside the Course Planner</b>.</p>
      <div class="msp-student-list">${[...grouped].map(([uid, submissions])=>`<button type="button" class="msp-student" data-msp-action="openStudent" data-student="${escapeHTML(uid)}">
        <b>${escapeHTML(names.get(uid)||'Student')}</b><span>${submissions.length} submitted plan${submissions.length===1?'':'s'} · latest ${escapeHTML(dateText(submissions[0]?.submitted_at))}</span><span>Open plans →</span>
      </button>`).join('') || '<p>No student submissions yet.</p>'}</div>`;
  }
  function updateReviewBanner() {
    const banner = $('mspReviewBanner');
    if (!banner) return;
    if (!reviewing || !bridge?.isReviewing()) { banner.hidden = true; return; }
    banner.hidden = false;
    const {rows,name}=reviewing;
    const period=bridge.period();
    const key=bridge.planKey();
    const row=rows.find(r=>r.period===period && r.plan_key===key);
    const review=state?.reviews?.find(x=>x.submission_id===row?.id);
    banner.innerHTML = `<div class="msp-review-header"><div><b>Viewing ${escapeHTML(name)}'s submitted plans</b><br><small>Read-only advisor preview · ${escapeHTML(period)} Plan ${escapeHTML(key)}</small></div>
      <button class="btn btn-navy" data-msp-action="exitReview">Exit student review</button></div>
      ${row ? `<div class="msp-review-detail"><small>Submitted ${escapeHTML(dateText(row.submitted_at))} · ${escapeHTML(review?.decision||'pending')}</small>
        ${row.student_message ? `<p><b>Student's message:</b> ${escapeHTML(row.student_message)}</p>` : ''}
        <label for="mspReviewComment">Feedback on this plan</label><textarea id="mspReviewComment" maxlength="3000" rows="2">${escapeHTML(review?.comment||'')}</textarea>
        <div class="msp-row"><button class="btn btn-gh" data-msp-action="review" data-decision="reviewed" data-submission="${escapeHTML(row.id)}">Mark reviewed</button>
          <button class="btn btn-gh" data-msp-action="review" data-decision="changes_requested" data-submission="${escapeHTML(row.id)}">Request changes</button></div>
      </div>` : '<p>There is no submitted plan for the selected period / plan tab.</p>'}`;
  }

  async function loadState() {
    const n=++refreshSerial;
    if (!db || !user) { state=null; render(); return; }
    const uid=user.id;
    try {
      const list=await Promise.all([
        db.from('profiles').select('id,display_name').eq('id',uid).maybeSingle(),
        db.from('advisors').select('user_id,display_name,active').eq('active',true).order('display_name'),
        db.from('advisor_assignments').select('student_id,advisor_id').eq('student_id',uid).maybeSingle(),
        db.from('advisor_requests').select('user_id,status,display_name').eq('user_id',uid).maybeSingle(),
        db.from('plan_submissions').select('id,student_id,advisor_id,period,plan_key,plan_data,student_message,submitted_at').eq('student_id',uid).order('submitted_at',{ascending:false}),
        db.from('advisors').select('user_id,display_name,active').eq('user_id',uid).maybeSingle()
      ]);
      list.forEach(checked);
      const [profile,advisors,assignment,request,own,advisor]=list.map(x=>x.data);
      const assigned=advisor?.active ? checked(await db.from('plan_submissions').select('id,student_id,advisor_id,period,plan_key,plan_data,student_message,submitted_at').eq('advisor_id',uid).order('submitted_at',{ascending:false})) : [];
      const ids=[...new Set([...(own||[]),...assigned].map(x=>x.id))];
      const reviews=ids.length ? checked(await db.from('plan_reviews').select('submission_id,advisor_id,decision,comment,reviewed_at').in('submission_id',ids)) : [];
      const studentIds=[...new Set(assigned.map(x=>x.student_id))];
      const profiles=studentIds.length ? checked(await db.from('profiles').select('id,display_name').in('id',studentIds)) : [];
      if (n!==refreshSerial || uid!==user?.id) return;
      state={profile,advisors:advisors||[],assignment,request,own:own||[],advisor,assigned,reviews,profiles};
      render();
    } catch(e) { if (n===refreshSerial) { report(e); render(); } }
  }
  function render() {
    const studentsLink=$('mspStudentsLink');
    if (studentsLink) studentsLink.hidden = !isAdvisor();
    const button=$('mspAccountLink');
    if (button) button.querySelector('.sb-hint').textContent = user ? user.email : 'Sign in';
    drawAccount();drawSend();drawQuickSend();drawStudents();updateReviewBanner();
  }
  async function act(action, target) {
    if (busy) return;
    busy=true;
    target.disabled=true;
    notice('');
    try {
      if (action==='account') {openAccount();return;}
      if (action==='logout') {
        if (bridge?.isReviewing()) {await bridge.exitReview();reviewing=null;}
        checked(await db.auth.signOut());user=null;state=null;closeAccount();render();return;
      }
      if (!user) throw Error('Sign in first.');
      if (action==='saveName') {
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
      } else if(action==='openStudent') {
        if (!isAdvisor()) throw Error('You are not an approved advisor.');
        const uid=target.dataset.student;
        const rows=(state.assigned||[]).filter(s=>s.student_id===uid);
        if (!rows.length) throw Error('No assigned submissions found for this student.');
        const name=state.profiles.find(x=>x.id===uid)?.display_name || 'Student';
        await bridge.showReview(rows);
        reviewing={student:uid,name,rows};
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
        await bridge.exitReview();reviewing=null;updateReviewBanner();drawSend();drawQuickSend();notice('Returned to your original local planner.');
      } else if(action==='review') {
        if (!isAdvisor() || !reviewing) throw Error('Open an assigned student first.');
        const id=target.dataset.submission;
        if (!reviewing.rows.some(x=>x.id===id)) throw Error('Unknown submitted plan.');
        const decision=target.dataset.decision;
        if(!['reviewed','changes_requested'].includes(decision)) throw Error('Invalid review decision.');
        const comment=elVal('mspReviewComment');if(comment.length>3000) throw Error('Feedback is too long.');
        checked(await db.from('plan_reviews').upsert({submission_id:id,advisor_id:user.id,decision,comment,reviewed_at:new Date().toISOString()},{onConflict:'submission_id'}));
        await loadState();notice('Advisor feedback saved.');
      }
    } catch(e) {report(e);} finally {busy=false;if(target.isConnected)target.disabled=false;}
  }
  document.addEventListener('click', e => {
    const btn=e.target.closest('[data-msp-action]');
    if (!btn) return;
    e.preventDefault();act(btn.dataset.mspAction,btn);
  });
  document.addEventListener('submit', async e=>{
    if(e.target.id!=='mspLoginForm')return;
    e.preventDefault();if(busy)return;
    const email=elVal('mspEmail');const password=$('mspPassword')?.value || '';
    if(!email || !password){notice('Enter both your email and password.',true);return;}
    busy=true;notice('');
    try {
      const response=checked(await db.auth.signInWithPassword({email,password}));
      if (!response?.user) throw Error('No authenticated user returned.');
      user=response.user;
      if($('mspPassword')) $('mspPassword').value='';
      await loadState();closeAccount();notice('Signed in.');
    } catch(e){report(e);}finally{busy=false;}
  });
  document.addEventListener('click',e=>{
    if (!bridge?.isReviewing()) return;
    if (e.target.closest('.pd-btn, .ptab')) setTimeout(() => {updateReviewBanner();drawSend();drawQuickSend();},650);
  });
  document.addEventListener('click', e => {
    if (e.target.closest('.pd-btn')) setTimeout(() => {drawSend();drawQuickSend();}, 650);
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
  const observer=new MutationObserver(() => { if (bridge?.isReviewing()) bridge.lockInputs(); });
  const planview=$('view-planner');if(planview) observer.observe(planview,{childList:true,subtree:true});
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
        user=next;
        if(bridge.isReviewing()) {void bridge.exitReview().then(()=>{reviewing=null;});}
        state=null;setTimeout(loadState,0);
      });
    } catch(e){report(e);render();}
  }
  window.addEventListener('pageshow',()=>{drawSend();drawQuickSend();});
  init();
})();
