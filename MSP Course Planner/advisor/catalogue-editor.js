/* MSP Catalogue Admin: optional extension for Supabase-backed planner.
   UI access is gated by Supabase admin RPC. Writes are authorized by database RPCs. */
(() => {
  'use strict';
  const cfg = window.MSP_ADVISOR_CONFIG || {};
  const PERIODS = ['P1','P2','P4','P5'];
  const BLOCKS = ['MonAM','MonPM','TueAM','TuePM','WedAM','WedPM','ThuAM','ThuPM','FriAM','FriPM'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const $ = id => document.getElementById(id);
  const checked = res => { if (res.error) throw res.error; return res.data; };
  let db, admin = false, user = null, draft = null, draftRevision = 0, publishedRevision = 0;
  let history = [], selectedCode = '', tab = 'overview', opened = false, dirty = false, locked = false;
  let filterText = '', filterPeriod = 'all', archiveView = false;
  let lastError = '';

  function notify(message, isError=false) {
    const node = $('mspCatalogMessage');
    if (!node) return;
    node.textContent = message;
    node.dataset.error = String(isError);
  }
  function unsavedOK() { return !dirty || confirm('You have unsaved catalogue changes. Discard them?'); }
  function markDirty() {
    dirty = true;
    const badge = $('mspCatalogDirty');
    if (badge) badge.textContent = 'Unsaved changes';
    const save = $('mspCatalogSave');
    if (save) save.disabled = false;
  }
  function courseList() { return draft?.catalogue || []; }
  function findCourse(code) { return courseList().find(c => c.code === code); }
  function offeringCount(code) { return PERIODS.filter(p => draft?.periods?.[p]?.some(r=>r.Code===code)).length; }

  function splitMarkdown(markdown) {
    return String(markdown || '').split(/^---\s*$/m);
  }
  function blockRegex(code) { return new RegExp(`^${code}\\s+`, 'm'); }
  function getBlock(code) {
    return splitMarkdown(draft.descriptionsMd).find(part => blockRegex(code).test(part.trim()))?.trim() || '';
  }
  function writeBlock(code, newBlock) {
    const blocks = splitMarkdown(draft.descriptionsMd);
    const i = blocks.findIndex(part => blockRegex(code).test(part.trim()));
    if (i >= 0) blocks[i] = '\n\n' + newBlock.trim() + '\n\n';
    else blocks.push('\n\n' + newBlock.trim() + '\n\n');
    draft.descriptionsMd = blocks.join('---');
    markDirty();
  }
  const SECTION_NAMES = [
    'Course coordinator','Course co-coordinators','Coordinator','Practical coordinator','Contact',
    'Pre-requisites','Prerequisites','Co-requisites','Corequisites','Objectives',
    'Description of the course','Description of the skill','Description of the practical',
    'Literature','Recommended reading','Recommended','Instructional format','Assessment','Note'
  ];
  function blockSections(block) {
    const lines = block.replace(/\r\n/g,'\n').split('\n');
    const sections = {};
    let current = '';
    for (const line of lines.slice(1)) {
      const name = SECTION_NAMES.find(x => x.toLowerCase() === line.trim().toLowerCase());
      if (name) { current = name; sections[name] ||= ''; }
      else if (current) sections[current] += (sections[current] ? '\n' : '') + line;
    }
    return Object.fromEntries(Object.entries(sections).map(([k,v]) => [k,v.trim()]));
  }
  function updateSection(code, name, value) {
    const course = findCourse(code);
    let old = getBlock(code);
    if (!old) old = `${code} ${course?.title || code}\n`;
    const lines = old.replace(/\r\n/g,'\n').trimEnd().split('\n');
    const start = lines.findIndex(line => line.trim().toLowerCase() === name.toLowerCase());
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && !SECTION_NAMES.some(s => lines[end].trim().toLowerCase() === s.toLowerCase())) end++;
      lines.splice(start,end-start,name,...value.trim().split('\n'));
    } else {
      lines.push(name,...value.trim().split('\n'));
    }
    writeBlock(code,lines.join('\n'));
  }
  function newBlock(code) {
    const course = findCourse(code);
    const type = code.startsWith('PRA') || code.startsWith('SKI') ? 'skill' : 'course';
    return `${code} ${course?.title || code}\nCourse coordinator\n${course?.coordinator || ''}\nContact\n\nPre-requisites\n\nCo-requisites\n\nObjectives\n\nDescription of the ${type}\n\nLiterature\n\nInstructional format\n\nAssessment\n`;
  }
  function input(id,label,value='',type='text',attrs='') {
    return `<label class="msp-cat-field" for="${id}"><span>${esc(label)}</span><input id="${id}" ${attrs} type="${type}" value="${esc(value)}"></label>`;
  }
  function field(label,scope,key,value,type='text',extra='') {
    return `<label class="msp-cat-field"><span>${esc(label)}</span><input type="${type}" data-cat-scope="${scope}" data-cat-key="${esc(key)}" ${extra} value="${esc(value)}"></label>`;
  }
  function textarea(label,scope,key,value,rows=6,hint='') {
    return `<label class="msp-cat-field"><span>${esc(label)}</span>${hint?`<small>${esc(hint)}</small>`:''}<textarea rows="${rows}" data-cat-scope="${scope}" data-cat-key="${esc(key)}">${esc(value)}</textarea></label>`;
  }
  function select(label,scope,key,current,options) {
    return `<label class="msp-cat-field"><span>${esc(label)}</span><select data-cat-scope="${scope}" data-cat-key="${esc(key)}">${options.map(o=>`<option value="${esc(o.value)}" ${o.value===current?'selected':''}>${esc(o.text)}</option>`).join('')}</select></label>`;
  }
  function check(label,scope,key,yes) {
    return `<label class="msp-cat-check"><input type="checkbox" data-cat-scope="${scope}" data-cat-key="${esc(key)}" ${yes?'checked':''}><span>${esc(label)}</span></label>`;
  }
  function parseCsvLine(line) {
    const out=[]; let cur='', quoted=false;
    for(let i=0;i<line.length;i++) {const c=line[i];
      if(c==='"') { if(quoted && line[i+1]==='"'){cur+='"';i++;}else quoted=!quoted; }
      else if(c===','&&!quoted){out.push(cur);cur='';}else cur+=c;
    }
    out.push(cur);return out;
  }
  function normalizeSnapshot(doc) {
    const copy=clone(doc);
    copy.archive ||= [];
    copy.bundles ||= [];
    copy.antireqs ||= {};
    copy.namedPrerequisites ||= {'core 1000-level':['BIO1101','CHE1101','PHY1101','INT1101']};
    copy.periodMeta ||= {};
    for(const period of PERIODS) {
      copy.periods[period] ||= [];
      copy.periodMeta[period] ||= {version:'1.0',validFrom:'2026-2027'};
      copy.periods[period].forEach(o => {
        o.Days=Array.isArray(o.Days)?o.Days:String(o.Days||'').split(',').map(x=>x.trim()).filter(Boolean);
        o.Corequisite=o.Corequisite===true || String(o.Corequisite).toUpperCase()==='TRUE';
        o.Prerequisite=o.Prerequisite===true || String(o.Prerequisite).toUpperCase()==='TRUE';
        o.Bundle ||= ''; o.Slot ||= '';
      });
    }
    return copy;
  }
  function renderList() {
    const root=$('mspCatList'); if(!root)return;
    if(!draft){root.innerHTML='<p class="msp-cat-muted">No draft catalogue yet.</p>';return;}
    const q=filterText.trim().toLowerCase();
    const rows=archiveView
      ? (draft.archive||[]).map(x=>({...x.course,archived:true})).filter(c=>c.code)
      : courseList().filter(c=>c.code).filter(c => filterPeriod==='all'||draft.periods?.[filterPeriod]?.some(o=>o.Code===c.code));
    const visible=rows.filter(c=>`${c.code} ${c.title} ${c.coordinator}`.toLowerCase().includes(q)).sort((a,b)=>a.code.localeCompare(b.code));
    root.innerHTML=visible.map(c=>`<button type="button" class="msp-cat-item ${c.code===selectedCode?'selected':''}" data-cat-action="select" data-code="${esc(c.code)}"><strong>${esc(c.code)}</strong><span>${esc(c.title)}</span><small>${c.archived?'Archived':`${offeringCount(c.code)} periods`}</small></button>`).join('') || '<p class="msp-cat-muted">No matching modules.</p>';
    $('mspCatCount').textContent=`${visible.length} shown · ${courseList().length} active · ${(draft.archive||[]).length} archived`;
  }
  function tabButtons() {
    const opts=[['overview','Information & rules'],['periods','Schedule & periods'],['description','Description & details']];
    return `<div class="msp-cat-tabs">${opts.map(([key,label])=>`<button class="${tab===key?'active':''}" type="button" data-cat-action="tab" data-tab="${key}">${label}</button>`).join('')}</div>`;
  }
  function synchronizeOfferings(course, onlyMatching=false, fieldKey=null, previousValue=null) {
    const mappings={title:'Title',coordinator:'Coordinator',prerequisiteCodes:'PrerequisiteCodes',corequisiteOf:'CorequisiteOf',prerequisite:'Prerequisite',corequisite:'Corequisite'};
    const keys=fieldKey?[fieldKey]:Object.keys(mappings);
    for(const period of PERIODS)for(const offering of draft.periods[period]){
      if(offering.Code!==course.code)continue;
      for(const key of keys){
        const mapped=mappings[key];
        const old=offering[mapped];
        const normalized=v=>String(v).toUpperCase();
        if(onlyMatching && normalized(old)!==normalized(previousValue))continue;
        offering[mapped]=['corequisite','prerequisite'].includes(key)
          ? String(course[key]).toUpperCase()==='TRUE' : (course[key]||'');
      }
    }
  }
  function renderOverview(course) {
    return `<div class="msp-cat-grid">
      ${field('Course code (locked to protect saved plans)','course','code',course.code,'text','disabled')}
      ${field('Course title','course','title',course.title,'text','maxlength="200" required')}
      ${field('Coordinator','course','coordinator',course.coordinator,'text','maxlength="300"')}
      ${field('Prerequisite expression','course','prerequisiteCodes',course.prerequisiteCodes||'','text','maxlength="1000"')}
      ${field('Co-requisite expression','course','corequisiteOf',course.corequisiteOf||'','text','maxlength="1000"')}
      <div class="msp-cat-boolean">${check('Has prerequisites','course','prerequisite',String(course.prerequisite).toUpperCase()==='TRUE')}
      ${check('Has co-requisites','course','corequisite',String(course.corequisite).toUpperCase()==='TRUE')}</div>
    </div><p class="msp-cat-help">Use <code>+</code> for AND, <code>/</code> for OR, and supported named groups such as <code>core 1000-level</code>. Matching schedule fields update with the master entry; explicit period-specific overrides are preserved.</p>
    <button type="button" class="btn btn-gh" data-cat-action="syncAllOfferings">Apply master details to every period offering</button>`;
  }
  function renderPeriods(course) {
    return `<p class="msp-cat-help">Edit each period separately. The slot determines which course selector it appears under. Leave the slot empty for a practical. Select meeting blocks for conflict checking.</p>
    ${PERIODS.map(period=>{
      const rows=draft.periods[period].map((o,index)=>({o,index})).filter(x=>x.o.Code===course.code);
      return `<section class="msp-cat-period"><div class="msp-cat-period-head"><strong>${period}</strong><button type="button" class="btn btn-gh" data-cat-action="addOffering" data-period="${period}" ${rows.length?'disabled title="One offering per course and period is supported"':''}>${rows.length?'Already offered':'+ Add offering'}</button></div>
      ${rows.map(({o,index})=>{
        const scope=`offering:${period}:${index}`;
        return `<div class="msp-cat-offering"><div class="msp-cat-offering-head"><strong>${esc(o.Title)}</strong><button class="msp-cat-danger" type="button" data-cat-action="removeOffering" data-period="${period}" data-index="${index}">Remove from ${period}</button></div>
          <div class="msp-cat-grid">
            ${select('Schedule slot',''+scope,'Slot',o.Slot||'',[{value:'',text:'Practical / no slot'},...['A','B','C','D','E'].map(v=>({value:v,text:`Slot ${v}`}))])}
            ${field('Title for this offering',scope,'Title',o.Title||'','text','maxlength="200"')}
            ${field('Coordinator for this offering',scope,'Coordinator',o.Coordinator||'','text','maxlength="300"')}
            ${field('Prerequisites for this period',scope,'PrerequisiteCodes',o.PrerequisiteCodes||'')}
            ${field('Co-requisites for this period',scope,'CorequisiteOf',o.CorequisiteOf||'')}
            ${field('Field-course bundle ID (if applicable)',scope,'Bundle',o.Bundle||'')}
          </div>
          <div class="msp-cat-boolean">${check('Prerequisites apply',scope,'Prerequisite',o.Prerequisite)} ${check('Co-requisites apply',scope,'Corequisite',o.Corequisite)}</div>
          <label class="msp-cat-block-label">Meeting blocks</label><div class="msp-cat-days">${BLOCKS.map(day=>`<label><input type="checkbox" data-cat-scope="${scope}" data-cat-key="Days" data-day="${day}" ${o.Days.includes(day)?'checked':''}><span>${day.replace(/(AM|PM)$/,' $1')}</span></label>`).join('')}</div>
        </div>`;
      }).join('') || '<p class="msp-cat-muted">Not offered this period</p>'}</section>`;
    }).join('')}`;
  }
  function renderDescription(course) {
    const block=getBlock(course.code)||newBlock(course.code);
    const sections=blockSections(block);
    const contentName=(course.code.startsWith('PRA')||course.code.startsWith('SKI'))?'Description of the skill':'Description of the course';
    return `<p class="msp-cat-help">Edit the descriptive catalogue text below. The actual prerequisite checks come from Information & rules and Schedule & periods, not from this text.</p>
    ${textarea('Objectives','section','Objectives',sections.Objectives||'',5)}
    ${textarea('Course description','section',contentName,sections[contentName]||'',9)}
    <div class="msp-cat-grid">
      ${textarea('Assessment','section','Assessment',sections.Assessment||'',5)}
      ${textarea('Instructional format','section','Instructional format',sections['Instructional format']||'',5)}
      ${textarea('Literature','section','Literature',sections.Literature||'',5)}
      ${textarea('Recommended reading','section','Recommended reading',sections['Recommended reading']||'',5)}
      ${textarea('Prerequisites (description wording)','section','Pre-requisites',sections['Pre-requisites']||sections.Prerequisites||'',4)}
      ${textarea('Co-requisites (description wording)','section','Co-requisites',sections['Co-requisites']||sections.Corequisites||'',4)}
    </div>
    <details class="msp-cat-advanced"><summary>Advanced: edit the original Markdown entry</summary>${textarea('Full catalogue entry (keep code on first line)','raw','block',block,18,'Preserves arbitrary sections, contact details and catalogue-specific wording.')}</details>`;
  }
  function renderSettings() {
    return `<div class="msp-cat-editor-head"><div><div class="msp-cat-eyebrow">CATALOGUE RULES</div><h3>Equivalencies, field courses and period information</h3></div></div>
      <p class="msp-cat-help">These rules also affect course availability, historical equivalents and field-course planning. Changes remain in draft until published.</p>
      <section class="msp-cat-period"><div class="msp-cat-period-head"><strong>Named prerequisite groups</strong><button class="btn btn-gh" type="button" data-cat-action="addGroup">+ Add group</button></div>
        <p class="msp-cat-help">Use a short name such as <code>core 1000-level</code>. All codes in a group must be passed before it counts as satisfied. Groups can be used in the prerequisite expressions of the modules.</p>
        ${(Object.entries(draft.namedPrerequisites||{})).map(([name,codes])=>`<div class="msp-cat-offering"><div class="msp-cat-offering-head"><strong>${esc(name)}</strong><button class="msp-cat-danger" data-cat-action="removeGroup" data-name="${esc(name)}" type="button">Remove group</button></div>${field('Required course codes (comma-separated)',`group:${name}`,'codes',codes.join(', '))}</div>`).join('')}
      </section>
      <section class="msp-cat-period"><div class="msp-cat-period-head"><strong>Course equivalencies / anti-requisites</strong><button class="btn btn-gh" type="button" data-cat-action="addEquiv">+ Add equivalency</button></div>
        <p class="msp-cat-help">When a student has passed the former code, the replacement should not be selected again. These mappings are directional.</p>
        <div class="msp-cat-equivalencies">${Object.entries(draft.antireqs||{}).sort().map(([code,previous])=>`<div class="msp-cat-equiv"><input value="${esc(code)}" data-cat-scope="equiv:${esc(code)}" data-cat-key="newCode" aria-label="Current course code"><span>replaces</span><input value="${esc(previous)}" data-cat-scope="equiv:${esc(code)}" data-cat-key="oldCode" aria-label="Previous course code"><button class="msp-cat-danger" type="button" data-cat-action="removeEquiv" data-code="${esc(code)}">Remove</button></div>`).join('')}</div>
      </section>
      <section class="msp-cat-period"><div class="msp-cat-period-head"><strong>Field-course bundles</strong><button class="btn btn-gh" type="button" data-cat-action="addBundle">+ Add field course</button></div>
        ${(draft.bundles||[]).map((bundle,i)=>`<div class="msp-cat-offering"><div class="msp-cat-offering-head"><strong>${esc(bundle.id)}</strong><button class="msp-cat-danger" data-cat-action="removeBundle" data-index="${i}" type="button">Remove bundle</button></div><div class="msp-cat-grid">
          ${field('Bundle ID',`bundle:${i}`,'id',bundle.id,'text','maxlength="150"')}
          ${field('Display name',`bundle:${i}`,'label',bundle.label)}
          ${field('Subtitle',`bundle:${i}`,'subtitle',bundle.subtitle)}
          ${field('Coordinators',`bundle:${i}`,'coordinators',bundle.coordinators)}
          ${select('Period',`bundle:${i}`,'period',bundle.period,PERIODS.map(p=>({value:p,text:p})))}
          ${field('Component codes (comma-separated)',`bundle:${i}`,'componentCodes',(bundle.componentCodes||[]).join(', '))}
        </div>${textarea('Notes',`bundle:${i}`,'note',bundle.note,3)}</div>`).join('') || '<p class="msp-cat-muted">No field-course bundles defined.</p>'}
      </section>
      <section class="msp-cat-period"><div class="msp-cat-period-head"><strong>Uncoded catalogue entries</strong><button class="btn btn-gh" type="button" data-cat-action="addUncoded">+ Add uncoded entry</button></div>
      <p class="msp-cat-help">For catalogue information not represented by a schedulable module code, such as Bachelor Thesis Research.</p>
      ${(draft.catalogue||[]).map((entry,i)=>({entry,i})).filter(x=>!x.entry.code).map(({entry,i})=>`<div class="msp-cat-offering"><div class="msp-cat-offering-head"><strong>${esc(entry.title)}</strong><button type="button" class="msp-cat-danger" data-cat-action="removeUncoded" data-index="${i}">Remove</button></div><div class="msp-cat-grid">${field('Title',`uncoded:${i}`,'title',entry.title)}${field('Coordinator',`uncoded:${i}`,'coordinator',entry.coordinator)}</div></div>`).join('')||'<p class="msp-cat-muted">No uncoded entries.</p>'}</section>
      <section class="msp-cat-period"><div class="msp-cat-period-head"><strong>Period metadata</strong></div>
      <div class="msp-cat-grid">${PERIODS.map(period=>`<div><h4>${period}</h4>${field('Data revision',`meta:${period}`,'version',draft.periodMeta[period]?.version||'1.0')}${field('Academic year',`meta:${period}`,'validFrom',draft.periodMeta[period]?.validFrom||'2026-2027')}</div>`).join('')}</div></section>`;
  }

  function renderEditor() {
    const target=$('mspCatEditor');if(!target)return;
    const course=findCourse(selectedCode);
    if(!draft){target.innerHTML='<div class="msp-cat-empty">Initialize the catalogue from the currently loaded planner data to create the first draft.</div>';return;}
    if(selectedCode==='@settings'){target.innerHTML=renderSettings();return;}
    if(archiveView){const entry=(draft.archive||[]).find(x=>x.course.code===selectedCode);
      target.innerHTML=entry?`<h3>${esc(entry.course.code)} · ${esc(entry.course.title)}</h3><p>Archived modules are excluded from the published schedules and catalogue. Saved plans may lose references to archived modules on reload.</p><button class="btn btn-navy" data-cat-action="restore">Restore module to draft</button>`:'<div class="msp-cat-empty">Select an archived module.</div>';
      return;}
    if(!course){target.innerHTML='<div class="msp-cat-empty">Select a module to edit its details, periods and description.</div>';return;}
    target.innerHTML=`<div class="msp-cat-editor-head"><div><div class="msp-cat-eyebrow">EDITING MODULE</div><h3>${esc(course.code)} · ${esc(course.title)}</h3></div><button type="button" class="msp-cat-danger" data-cat-action="archive">Archive module</button></div>
      ${tabButtons()}<div class="msp-cat-tab-body">${tab==='overview'?renderOverview(course):tab==='periods'?renderPeriods(course):renderDescription(course)}</div>`;
  }
  function renderToolbar() {
    const node=$('mspCatalogAdminPanel'); if(!node)return;
    const noDraft=!draft;
    node.innerHTML=`<div class="msp-cat-top"><div><div class="msp-cat-eyebrow">ADMINISTRATION</div><h2>Course catalogue editor</h2><p>Draft ${draftRevision} · published version ${publishedRevision} <span id="mspCatalogDirty">${dirty?'Unsaved changes':'All local changes saved'}</span></p></div>
      <button class="btn btn-gh" type="button" data-cat-action="close">Back to catalogue</button></div>
      <div class="msp-cat-actions">
        <button class="btn btn-gh" data-cat-action="init" ${draft?'disabled title="Already initialized"':''}>Import current catalogue</button>
        <button class="btn btn-gh" data-cat-action="add" ${noDraft?'disabled':''}>+ New module</button>
        <button class="btn btn-gh" data-cat-action="settings" ${noDraft?'disabled':''}>Rules &amp; field courses</button>
        <button id="mspCatalogSave" class="btn btn-gh" data-cat-action="save" ${!dirty?'disabled':''}>Save draft</button>
        <button class="btn btn-navy" data-cat-action="publish" ${noDraft?'disabled':''}>Publish catalogue</button>
        <button class="btn btn-gh" data-cat-action="export" ${noDraft?'disabled':''}>Export backup</button>
        <button class="btn btn-gh" data-cat-action="refresh">Refresh from server</button>
      </div>
      <div class="msp-cat-version"><label for="mspCatVersion">Restore published version as draft</label><select id="mspCatVersion"><option value="">Select version</option>${history.map(h=>`<option value="${h.version}">v${h.version} · ${esc(h.date?new Date(h.date).toLocaleString():'')}</option>`).join('')}</select><button class="btn btn-gh" data-cat-action="restoreVersion" ${!history.length?'disabled':''}>Restore</button><small>Restoring does not publish until you approve the draft.</small></div>
      <p id="mspCatalogMessage" role="status" aria-live="polite"></p>
      <div class="msp-cat-layout"><aside class="msp-cat-sidebar"><label for="mspCatSearch">Find a course or practical</label><input id="mspCatSearch" type="search" placeholder="Search code, title, coordinator…" value="${esc(filterText)}"><div class="msp-cat-filters"><select id="mspCatPeriodFilter"><option value="all">All periods</option>${PERIODS.map(p=>`<option value="${p}" ${filterPeriod===p?'selected':''}>${p}</option>`).join('')}</select><label><input id="mspCatArchived" type="checkbox" ${archiveView?'checked':''}> Archived</label></div><small id="mspCatCount"></small><div id="mspCatList"></div></aside><div id="mspCatEditor" class="msp-cat-editor"></div></div>`;
    renderList();renderEditor();
    if(lastError) notify(lastError,true);
  }
  function toggleEditor(want) {
    const view=$('view-catalogue');
    if(!view)return;
    if(!want && !unsavedOK())return;
    opened=want;
    view.classList.toggle('msp-catalogue-editing',want);
    $('mspCatalogueAdminToggle').textContent=want?'Close editor':'Manage catalogue';
    $('mspCatalogAdminPanel').hidden=!want;
    if(want){renderToolbar(); if(!draft)notify('Import the current catalogue to create the first editable draft. No changes are published until you click Publish.');}
    else if(dirty) void refreshAdmin(true);
  }
  function createUI() {
    const view=$('view-catalogue');if(!view || $('mspCatalogueAdminRoot'))return;
    const root=document.createElement('div');root.id='mspCatalogueAdminRoot';root.hidden=true;
    root.innerHTML=`<div class="msp-catalogue-access"><button id="mspCatalogueAdminToggle" type="button" class="btn btn-navy" data-cat-action="toggle">Manage catalogue</button></div><section id="mspCatalogAdminPanel" hidden></section>`;
    view.prepend(root);
    const signin=document.createElement('div'); signin.id='mspCatFallbackSignin'; signin.hidden=true;
    signin.className='msp-cat-signin';
    signin.innerHTML=`<details><summary>Administrator sign-in</summary><form id="mspCatSigninForm"><label>Email <input type="email" name="email" autocomplete="username" required></label><label>Password <input type="password" name="password" autocomplete="current-password" required></label><button class="btn btn-navy" type="submit">Sign in</button></form></details>`;
    // Only show the fallback sign-in if the standalone planner has no account portal.
    if(!$('mspAccountLink')) view.prepend(signin);
  }
  function showAdminAccess() {
    const root=$('mspCatalogueAdminRoot');
    if(root)root.hidden=!admin;
    const signin=$('mspCatFallbackSignin');
    if(signin)signin.hidden=!!user;
    if(!admin && opened) {
      opened=false;dirty=false;
      $('view-catalogue')?.classList.remove('msp-catalogue-editing');
      if($('mspCatalogAdminPanel'))$('mspCatalogAdminPanel').hidden=true;
    }
  }
  async function refreshAdmin(force=false) {
    if(!admin)return;
    if(dirty && !force && !unsavedOK())return;
    const data=checked(await db.rpc('msp_catalogue_admin_snapshot'));
    draft=data?.draft?normalizeSnapshot(data.draft):null;
    draftRevision=Number(data?.draftRevision||0);
    publishedRevision=Number(data?.publishedRevision||0);
    history=data?.history||[];
    dirty=false;lastError='';
    if(draft && !findCourse(selectedCode) && selectedCode!=='@settings')selectedCode=draft.catalogue.find(c=>c.code)?.code||'';
    if(opened)renderToolbar();
  }
  async function authRefresh() {
    try {
      const session=checked(await db.auth.getSession());
      user=session?.session?.user||null;
      admin=user===null?false:!!checked(await db.rpc('msp_catalogue_is_admin'));
      showAdminAccess();
      if(admin)await refreshAdmin(true);
    } catch(err){console.error('Catalogue admin authorization failed:',err);admin=false;showAdminAccess();}
  }
  function isValidDraft() {
    if(!draft)throw Error('No draft catalogue');
    const seen=new Set();
    for(const c of draft.catalogue){
      if(c.code && !/^[A-Z]{2,4}\d{4}(?:\/\d{4})?$/.test(c.code))throw Error(`Invalid course code: ${c.code}`);
      if(!c.title?.trim())throw Error(`${c.code} has no title`);
      if(c.code) {if(seen.has(c.code))throw Error(`Duplicate course code: ${c.code}`); seen.add(c.code);}
    }
    for(const [name,codes] of Object.entries(draft.namedPrerequisites||{})) {
      if(!/^[a-z0-9 _-]{3,60}$/.test(name)||!Array.isArray(codes)||codes.length<1||codes.length>25||codes.some(code=>!/^[A-Z]{2,4}\d{4}$/.test(code)))throw Error(`Invalid named prerequisite group ${name}`);
    }
    for(const p of PERIODS){
      const codes=new Set();
      for(const o of draft.periods[p]){
        if(!seen.has(o.Code))throw Error(`Unknown offering ${o.Code} in ${p}`);
        if(codes.has(o.Code))throw Error(`${o.Code} appears twice in ${p}`);
        codes.add(o.Code);
        if(!o.Title?.trim())throw Error(`Missing title for ${o.Code} in ${p}`);
        if(!Array.isArray(o.Days) || o.Days.some(day=>!BLOCKS.includes(day)))throw Error(`Invalid days for ${o.Code} in ${p}`);
      }
    }
  }
  async function saveDraft() {
    isValidDraft();
    const rev=checked(await db.rpc('msp_catalogue_save_draft',{p_document:draft,p_expected_revision:draftRevision}));
    draftRevision=Number(rev);dirty=false;
    renderToolbar();notify('Draft saved. Students will continue seeing the published catalogue.');
  }
  async function publishDraft() {
    if(dirty)throw Error('Save your draft before publishing.');
    if(!confirm(`Publish draft revision ${draftRevision}? These course and schedule changes will become visible to all users.`))return;
    const version=checked(await db.rpc('msp_catalogue_publish',{p_expected_revision:draftRevision}));
    publishedRevision=Number(version);
    await refreshAdmin(true);
    try{await window.MSPCatalogBridge.reloadPublished();notify(`Catalogue v${version} published and planner refreshed.`);}catch(error){notify(`Published v${version}. Refresh the page to see the new data: ${error.message}`,true);}
  }
  async function act(action,target) {
    if(locked)return;
    if(!admin && !['signin'].includes(action))return;
    if(action==='toggle') {toggleEditor(!opened);return;}
    if(action==='close') {toggleEditor(false);return;}
    if(action==='select') {selectedCode=target.dataset.code;tab='overview';renderList();renderEditor();return;}
    if(action==='tab') {tab=target.dataset.tab;renderEditor();return;}
    if(action==='settings') {selectedCode='@settings';renderList();renderEditor();return;}
    if(action==='export'){
      const blob=new Blob([JSON.stringify(draft,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=`msp-catalogue-draft-${draftRevision}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
    }
    locked=true;
    try {
      if(action==='refresh') {await refreshAdmin();notify('Reloaded from Supabase.');}
      else if(action==='init'){
        if(draft)throw Error('A draft already exists');
        if(!window.MSPCatalogBridge?.ready)throw Error('Planner data is not ready');
        const snapshot=window.MSPCatalogBridge.snapshot();
        if(!confirm(`Import ${snapshot.catalogue.length} modules and their P1, P2, P4, P5 offerings into a NEW DRAFT? Verify your current catalogue source first.`))return;
        draft=normalizeSnapshot(snapshot);selectedCode=draft.catalogue.find(c=>c.code)?.code||'';markDirty();renderToolbar();notify('Imported into local draft. Click Save draft, then Publish to make it live.');
      }
      else if(action==='save')await saveDraft();
      else if(action==='publish')await publishDraft();
      else if(action==='add'){
        const code=prompt('New module code (e.g. BIO3015 or PRA3040):','')?.trim().toUpperCase();
        if(!code)return;
        if(!/^[A-Z]{2,4}\d{4}$/.test(code))throw Error('Use a 2–4 letter prefix followed by four digits.');
        if(findCourse(code)||(draft.archive||[]).some(x=>x.course.code===code))throw Error('That code already exists.');
        const title=prompt(`Title for ${code}:`,'')?.trim();if(!title)return;
        draft.catalogue.push({code,title,coordinator:'',corequisite:'FALSE',prerequisite:'FALSE',corequisiteOf:'',prerequisiteCodes:''});
        writeBlock(code,newBlock(code));selectedCode=code;tab='overview';renderToolbar();notify('New module added to draft. Add a period offering if it should appear in the planner.');
      }
      else if(action==='archive') {
        if(!confirm(`Archive ${selectedCode} and remove it from ALL period offerings? Existing student plans may reference this code.`))return;
        const course=findCourse(selectedCode), offerings={};
        for(const p of PERIODS){offerings[p]=draft.periods[p].filter(x=>x.Code===selectedCode);draft.periods[p]=draft.periods[p].filter(x=>x.Code!==selectedCode);}
        draft.archive.push({course,offerings});
        draft.catalogue=draft.catalogue.filter(x=>x.code!==selectedCode);
        selectedCode=draft.catalogue.find(c=>c.code)?.code||'';markDirty();renderToolbar();notify('Archived locally. Save and publish to remove it from the public catalogue.');
      }
      else if(action==='restore') {
        const index=draft.archive.findIndex(x=>x.course.code===selectedCode);if(index<0)throw Error('Archived module not found');
        const entry=draft.archive.splice(index,1)[0];draft.catalogue.push(entry.course);
        for(const p of PERIODS)draft.periods[p].push(...(entry.offerings?.[p]||[]));
        archiveView=false;markDirty();renderToolbar();notify('Restored to the draft. Save and publish to make it visible again.');
      }
      else if(action==='addGroup') {
        const name=prompt('New named prerequisite group (e.g. core 1000-level):','')?.trim().toLowerCase();if(!name)return;
        if(!/^[a-z0-9 _-]{3,60}$/.test(name)||Object.hasOwn(draft.namedPrerequisites,name))throw Error('Use a unique, simple group name.');
        draft.namedPrerequisites[name]=[];markDirty();renderEditor();
      }
      else if(action==='removeGroup') {
        const name=target.dataset.name;if(!Object.hasOwn(draft.namedPrerequisites,name))throw Error('Group not found');
        if(!confirm(`Remove named group "${name}"? Any catalogue prerequisite expressions still using this name will need updating.`))return;
        delete draft.namedPrerequisites[name];markDirty();renderEditor();
      }
      else if(action==='syncAllOfferings') {
        const course=findCourse(selectedCode);if(!course)throw Error('Select a course');
        if(!confirm(`Replace title, coordinator and requirement overrides in every period offering of ${course.code} with the master details?`))return;
        synchronizeOfferings(course);markDirty();renderEditor();
      }
      else if(action==='addEquiv') {
        const code=prompt('Replacement/new course code:','')?.trim().toUpperCase(); if(!code)return;
        const former=prompt('Equivalent previous course code:','')?.trim().toUpperCase(); if(!former)return;
        if(!/^[A-Z]{2,4}\d{4}$/.test(code)||!/^[A-Z]{2,4}\d{4}$/.test(former))throw Error('Both values must be valid course codes.');
        draft.antireqs[code]=former;markDirty();renderEditor();
      }
      else if(action==='removeEquiv') {
        const code=target.dataset.code;
        if(!Object.hasOwn(draft.antireqs,code))throw Error('Mapping not found');
        delete draft.antireqs[code];markDirty();renderEditor();
      }
      else if(action==='addBundle') {
        const id=prompt('Unique field-course ID (e.g. FIELD-P1-ISLAND):','')?.trim();if(!id)return;
        if(draft.bundles.some(b=>b.id===id))throw Error('Bundle ID already exists');
        draft.bundles.push({id,label:'New field course',subtitle:'',note:'',coordinators:'',period:'P1',componentCodes:[]});
        markDirty();renderEditor();
      }
      else if(action==='removeBundle') {
        const index=Number(target.dataset.index);if(!draft.bundles[index])throw Error('Bundle not found');
        if(!confirm(`Remove field-course bundle ${draft.bundles[index].id}?`))return;
        draft.bundles.splice(index,1);markDirty();renderEditor();
      }
      else if(action==='addUncoded') {
        const title=prompt('Title of uncoded catalogue entry:','')?.trim();if(!title)return;
        draft.catalogue.push({code:'',title,coordinator:'',corequisite:'FALSE',prerequisite:'FALSE',corequisiteOf:'',prerequisiteCodes:''});
        markDirty();renderEditor();
      }
      else if(action==='removeUncoded') {
        const index=Number(target.dataset.index);
        if(!draft.catalogue[index] || draft.catalogue[index].code)throw Error('Entry not found');
        if(!confirm(`Remove uncoded entry "${draft.catalogue[index].title}"?`))return;
        draft.catalogue.splice(index,1);markDirty();renderEditor();
      }
      else if(action==='addOffering') {
        const p=target.dataset.period,course=findCourse(selectedCode);
        if(!PERIODS.includes(p)||!course)throw Error('Invalid selection');
        if(draft.periods[p].some(x=>x.Code===course.code))throw Error('Already offered in this period');
        draft.periods[p].push({Slot:course.code.startsWith('PRA')||course.code.startsWith('SKI')?'':'A',Code:course.code,Title:course.title,Coordinator:course.coordinator,Corequisite:String(course.corequisite).toUpperCase()==='TRUE',Prerequisite:String(course.prerequisite).toUpperCase()==='TRUE',Days:[],CorequisiteOf:course.corequisiteOf||'',PrerequisiteCodes:course.prerequisiteCodes||'',Bundle:''});
        markDirty();renderEditor();renderList();
      }
      else if(action==='removeOffering') {
        const p=target.dataset.period,index=Number(target.dataset.index);
        if(!PERIODS.includes(p)||!draft.periods[p][index]||draft.periods[p][index].Code!==selectedCode)throw Error('Offering not found');
        if(!confirm(`Remove ${selectedCode} from ${p}?`))return;
        draft.periods[p].splice(index,1);markDirty();renderEditor();renderList();
      }
      else if(action==='restoreVersion') {
        const version=Number($('mspCatVersion')?.value);if(!version)throw Error('Select a published version first');
        if(!unsavedOK())return;
        if(!confirm(`Restore published version ${version} into the draft? This does not publish it automatically.`))return;
        checked(await db.rpc('msp_catalogue_restore_draft',{p_version:version,p_expected_revision:draftRevision}));
        await refreshAdmin(true);notify(`Published version ${version} restored to draft. Review it before publishing.`);
      }
    } catch(error){lastError=error.message||String(error);notify(lastError,true);console.error('Catalogue admin:',error);}finally{locked=false;}
  }
  function updateField(target) {
    const scope=target.dataset.catScope,key=target.dataset.catKey;
    if(!scope||!key||!draft)return;
    const value=target.type==='checkbox'?target.checked:target.value;
    if(scope==='course'){
      if(key==='code')return;
      const c=findCourse(selectedCode);if(!c)return;
      const previousValue=c[key];
      c[key]=typeof value==='boolean'?(value?'TRUE':'FALSE'):value;
      // Updating a master field also updates unchanged period copies. Period-specific
      // overrides remain untouched until the admin explicitly synchronizes them.
      synchronizeOfferings(c,true,key,previousValue);
      if(key==='title') {
        const old=getBlock(selectedCode);
        if(old)writeBlock(selectedCode,old.replace(new RegExp(`^${selectedCode}\\s+[^\\n]*`),`${selectedCode} ${value}`));
      }
      markDirty();
    }else if(scope.startsWith('offering:')){
      const [,p,i]=scope.split(':');const offering=draft.periods[p]?.[Number(i)];if(!offering)return;
      if(key==='Days'){
        const day=target.dataset.day;if(!BLOCKS.includes(day))return;
        offering.Days=BLOCKS.filter(b=>b===day?value:offering.Days.includes(b));
      }else offering[key]=value;
      markDirty();
    }else if(scope.startsWith('bundle:')) {
      const i=Number(scope.split(':')[1]);const bundle=draft.bundles[i];if(!bundle)return;
      bundle[key]=key==='componentCodes'?String(value).split(',').map(x=>x.trim().toUpperCase()).filter(Boolean):value;
      markDirty();
    }else if(scope.startsWith('group:')) {
      const name=scope.substring(6);if(!Object.hasOwn(draft.namedPrerequisites,name))return;
      draft.namedPrerequisites[name]=String(value).split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);markDirty();
    }else if(scope.startsWith('uncoded:')) {
      const i=Number(scope.split(':')[1]);if(draft.catalogue[i]?.code!=='')return;
      draft.catalogue[i][key]=value;markDirty();
    }else if(scope.startsWith('meta:')) {
      const p=scope.split(':')[1];if(!PERIODS.includes(p))return;
      draft.periodMeta[p][key]=value;markDirty();
    }else if(scope.startsWith('equiv:')) {
      const code=scope.split(':')[1];if(!Object.hasOwn(draft.antireqs,code))return;
      if(key==='oldCode') {draft.antireqs[code]=String(value).trim().toUpperCase();markDirty();}
      else if(key==='newCode' && target.type!=='text')return;
    }else if(scope==='section'){
      updateSection(selectedCode,key,value);
    }else if(scope==='raw'){
      if(!new RegExp(`^${selectedCode}\\s+`).test(value.trim())){
        notify(`The first line must begin with ${selectedCode} followed by the title.`,true);return;
      }
      writeBlock(selectedCode,value);
    }
  }
  function installEvents() {
    document.addEventListener('click',e=>{
      const button=e.target.closest('[data-cat-action]');if(!button)return;
      e.preventDefault();void act(button.dataset.catAction,button);
    });
    document.addEventListener('input',e=>{
      const t=e.target;
      if(t.id==='mspCatSearch'){filterText=t.value;renderList();return;}
      if(t.matches('[data-cat-scope]') && t.type!=='checkbox')updateField(t);
    });
    document.addEventListener('change',e=>{
      const t=e.target;
      if(t.id==='mspCatPeriodFilter'){filterPeriod=t.value;renderList();return;}
      if(t.id==='mspCatArchived'){archiveView=t.checked;selectedCode='';renderList();renderEditor();return;}
      if(t.dataset.catScope?.startsWith('equiv:') && t.dataset.catKey==='newCode') {
        const before=t.dataset.catScope.slice(6), after=t.value.trim().toUpperCase();
        if(after!==before){
          if(!/^[A-Z]{2,4}\d{4}$/.test(after) || Object.hasOwn(draft.antireqs,after)) {alert('Enter a valid, unique course code.');renderEditor();return;}
          draft.antireqs[after]=draft.antireqs[before];delete draft.antireqs[before];markDirty();renderEditor();
        }
        return;
      }
      if(t.matches('[data-cat-scope]') && (t.type==='checkbox'||t.tagName==='SELECT'))updateField(t);
    });
    document.addEventListener('submit',async e=>{
      if(e.target.id!=='mspCatSigninForm')return;
      e.preventDefault();const form=e.target;
      try{
        const email=form.elements.email.value.trim(), password=form.elements.password.value;
        checked(await db.auth.signInWithPassword({email,password}));
        form.reset();await authRefresh();
        if(!admin)alert('Signed in, but this account is not authorized as a catalogue administrator.');
      }catch(err){alert(`Sign-in failed: ${err.message||err}`);}
    });
    window.addEventListener('beforeunload',e=>{if(dirty && opened){e.preventDefault();e.returnValue='';}});
  }
  async function init() {
    createUI();installEvents();
    if(!cfg.enabled||!cfg.supabaseUrl||!cfg.supabaseAnonKey||!window.supabase?.createClient)return;
    db=window.MSPCatalogueSharedClient ||= window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    await authRefresh();
    db.auth.onAuthStateChange((event,session)=>{
      if(!['SIGNED_IN','SIGNED_OUT','INITIAL_SESSION','USER_UPDATED'].includes(event))return;
      if((session?.user?.id||null)===(user?.id||null))return;
      setTimeout(()=>void authRefresh(),0);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void init());
  else void init();
})();
