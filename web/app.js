const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data;
let signature = '';
let selectedRequest;
async function api(path, body) {
 const res = await fetch(path, body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const result = await res.json(); if (!res.ok) throw new Error(result.error); return result;
}
function card(t) {
 const total = outcome => t.receipts.filter(r=>r.outcome===outcome).reduce((n,r)=>n+r.amount_sat+r.fee_sat,0);
 const reserved = total('pending');
 const settled = total('paid');
 return `<article class="task" data-task="${t.id}"><div class="task-head"><h2 tabindex="-1">${escape(t.resourcePath ?? "Previous research record")}</h2><span class="status" data-status="${escape(t.status)}">${escape(t.status==='ready'?'Ready to fetch':t.status.replaceAll('_',' '))}</span></div>${!t.resourcePath?'<p class="hint">Archived research record. Payment history is preserved; new purchases are disabled.</p>':''}
 ${t.resourcePath?journey(t):''}
 ${t.approval?.decision==='pending'?`<section class="approval" aria-label="Payment approval"><h3>Approve this purchase?</h3><p>${escape(t.approval.message)}</p><p>Maximum exposure includes the stated routing fee. Approval expires after two minutes.</p><div class="actions"><button data-action="approve" data-approval="${t.approval.id}">Approve payment</button><button class="secondary" data-action="decline" data-approval="${t.approval.id}">Decline payment</button></div></section>`:''}
 <div class="actions">${t.resourcePath&&!t.active&&t.status!=='complete'?`<button data-action="run">${t.status==='ready'?'Start request':'Resume and reconcile'}</button>`:''}${t.resourcePath&&t.status!=='complete'&&t.status!=='stopped'?'<button class="danger" data-action="stop">Stop request</button>':''}</div>
 <div class="request-meta"><div><span>Provider</span><p>${escape(t.provider)}</p></div><div><span>Auto-approval limit</span><p>${t.autoApproveSat} sats <small>including fees</small></p></div></div>
 <div class="metrics"><div class="metric"><span>Settled</span><strong>${settled} <small>sats</small></strong></div><div class="metric"><span>Reserved</span><strong>${reserved} <small>sats</small></strong></div><div class="metric remaining"><span>Remaining allowance</span><strong>${Math.max(0,t.budgetSat-t.committedSat)} <small>sats</small></strong><span>of ${t.budgetSat} sats for this request</span></div></div>
 ${t.approval&&t.approval.decision!=='pending'?`<p>Approval: ${escape(t.approval.decision)}</p>`:''}
 ${t.error?`<p class="error">${escape(t.error)}</p>`:''}
 <p class="delivery"><strong>${t.active&&t.delivery?'Previous delivery attempt':'Delivery'}</strong> ${escape(t.delivery?.status??'Not requested')}${t.delivery?.reused?' · Existing paid credential reused; no new charge':''}</p>
 ${t.delivery?.reason&&!t.active?`<p>${escape(t.delivery.reason)}</p>`:''}
 ${!t.resourcePath?`<details><summary>Original research record</summary><pre>${escape(JSON.stringify(t,null,2))}</pre></details>`:''}
 ${t.response!==undefined?`<h3>Response</h3><p class="hint">Untrusted provider content. Delivery does not establish accuracy or usefulness.</p><pre>${escape(typeof t.response==='string'?t.response:JSON.stringify(t.response,null,2))}</pre>`:''}

 ${t.receipts.length?`<details><summary>Payment records (${t.receipts.length})</summary><div class="table-wrap"><table><caption>Authorization and payment outcomes</caption><thead><tr><th scope="col">Service</th><th scope="col">Authorization</th><th scope="col">Payment</th><th scope="col">Amount + fee (sats)</th></tr></thead><tbody>${t.receipts.map(r=>`<tr><td>${escape(r.service)}</td><td>${escape(r.approval)}</td><td>${escape(r.outcome)}${r.proof_of_payment?' · proof verified':''}</td><td>${r.amount_sat} + ${r.fee_sat}</td></tr>`).join('')}</tbody></table></div></details>`:''}
 <details><summary>Technical details</summary><h3>Event timings</h3><ul>${t.events.map(e=>`<li>${escape(e.ts)} · ${escape(e.kind)}${e.duration_ms==null?'':` · ${Math.round(e.duration_ms)} ms`}</li>`).join('')}</ul></details>

 ${t.status==='stopped'?'<p class="hint">Request stopped. Already reserved or submitted payments may still settle. Resume to reconcile.</p>':''}</article>`;
}
function journey(t) {
 const receipt=t.receipts.at(-1);
 const paid=t.receipts.find(r=>r.outcome==='paid');
 const pending=t.receipts.some(r=>r.outcome==='pending');
 const received=t.delivery?.status==='received';
 const reused=!!t.delivery?.reused;
 const skipped=received&&!paid&&!pending;
 const challenged=!!receipt||!!t.approval;
 const current=received?3:paid?.proof_of_payment?3:paid||pending||t.approval?.decision==='approved'||receipt?.outcome==='failed'?2:challenged?1:0;
 const states=[challenged||received?'done':'current',skipped?'skipped':current>1?'done':current===1?'current':'waiting',skipped?'skipped':current>2?'done':current===2?'current':'waiting',received?'done':current===3?'current':'waiting'];
 const labels=['Request resource','Review cost','Send payment','Receive response'];
 const descriptions=['Buyer asks the provider for this resource.','Review the invoice and maximum fee.','Reserve the allowance, pay, and verify proof.','Receive and inspect the provider’s response.'];
 let heading=['Ready to start','Review the payment','Resolving payment','Fetching the response'][current];
 let message=['Select Start request. We’ll contact the provider and ask you before paying above your auto-approval limit.','The provider requires payment. Review the amount below; declining sends nothing.','The request keeps its reservation until the wallet confirms the outcome. Do not send another payment.','Payment proof is available. The server uses it to request the resource.'][current];
 if(current===2&&!paid&&!pending&&receipt?.outcome!=='failed'){heading='Approval recorded';message='The server rechecks the spending limits before reserving funds and sending payment.'}
 if(t.status==='blocked'&&current===0){heading='Request blocked';message='The resource could not be fetched. Review the error below before resuming.'}
 if(t.active&&current===0){heading='Contacting the provider';message='The server requests the resource and checks whether payment is required.'}
 if(paid&&!paid.proof_of_payment){heading='Payment recorded; proof unavailable';message='The charge remains recorded. Resume to look for valid proof; automatic repayment is blocked.'}
 if(receipt?.outcome==='failed'){heading='Payment failed';message='The wallet confirmed failure. The reservation was released; no resource has been delivered.'}
 if(receipt?.outcome==='declined'&&!t.active){heading='Payment declined';message='No payment was sent for this attempt. Resume if you want to request approval again.'}
 if(receipt?.outcome==='refused'&&!t.active){heading='Purchase refused';message='The purchase did not pass the spending checks. Review the reason below.'}
 if(t.delivery?.status==='unavailable'&&current===3){heading='Response unavailable';message='Payment remains recorded. Resume to retry delivery with the saved credential, without paying again.'}
 if(received){heading='Response received';message=reused?'The saved credential was reused. No new payment was sent.':skipped?'The response arrived without a new payment. Approval and payment were skipped.':'The request is complete. Inspect the response and payment receipt below.'}
 if(t.status==='stopped'||t.status==='interrupted'){heading=t.status==='stopped'?'Request stopped':'Request interrupted';message='Resume to reconcile the current outcome. Reserved or submitted payments may still settle.'}
 return `<section class="journey" aria-label="Request flow" data-request-id="${escape(t.id)}"><ol>${labels.map((label,i)=>`<li data-state="${states[i]}"${states[i]==='current'?' aria-current="step"':''}><span class="journey-number">${i+1}</span><div><h3>${label}</h3><span>${states[i]==='done'?'Complete':states[i]==='skipped'?'Not needed':states[i]==='current'?'Current step':'Next'}</span><p>${descriptions[i]}</p></div></li>`).join('')}</ol><div class="journey-next"><h3>${heading}</h3><p>${message}</p></div></section>`;
}
async function refresh() {
 const previous = data?.tasks;
 data = await api('/api/tasks');
 const changed = data.tasks.find(t => previous?.some(p => p.id === t.id && p.status !== t.status));
 if(changed) $('notice').textContent = `Request ${changed.status.replaceAll('_',' ')}: ${changed.resourcePath ?? "Previous research record"}`;
 $('daily-spent').textContent = `${data.committedToday.toLocaleString('en-US')} sats`;
 $('daily-remaining').textContent = `${Math.max(0,data.policy.dailyBudget-data.committedToday).toLocaleString('en-US')} sats`; 
 $('budgetSat').max=data.policy.dailyBudget; $('autoApproveSat').max=data.policy.autoLimit;
 renderTasks();
}
function renderTasks(){
 if(!data.tasks.some(t=>t.id===selectedRequest)) selectedRequest=data.tasks[0]?.id;
 const next=JSON.stringify([selectedRequest,data.tasks]);
 if(next!==signature){
  const focus=document.activeElement;
  const focusedTask=focus?.closest('[data-task]')?.dataset.task;
  const focusedAction=focus?.dataset.action;
  const detailsKey=d=>d.closest('[data-task]').dataset.task+':'+d.querySelector('summary').textContent;
  const open=new Set([...document.querySelectorAll('details[open]')].map(detailsKey));
  $('selected-request').disabled=!data.tasks.length;
  $('selected-request').innerHTML=data.tasks.length?data.tasks.map(t=>`<option value="${escape(t.id)}">${escape(t.resourcePath??'Archived request')} · ${escape(t.status.replaceAll('_',' '))} · ${escape(t.id.slice(0,8))}</option>`).join(''):'<option>No requests yet</option>';
  if(selectedRequest) $('selected-request').value=selectedRequest;
  const task=data.tasks.find(t=>t.id===selectedRequest);
  $('tasks').innerHTML=task?card(task):'<div class="empty"><h3>No requests yet</h3><p>Create a request to review its cost and fetch a response.</p></div>';
  document.querySelectorAll('details').forEach(d=>{d.open=open.has(detailsKey(d))});
  if(focusedTask&&focusedAction) (document.querySelector(`[data-task="${focusedTask}"] [data-action="${focusedAction}"]`) ?? document.querySelector(`[data-task="${focusedTask}"] h2`))?.focus();
  signature=next;
 }
}
$('task-form').addEventListener('submit',async e=>{e.preventDefault(); const button=e.submitter;button.disabled=true;try{
 const fields=Object.fromEntries(new FormData(e.target));for(const key of ['budgetSat','autoApproveSat'])fields[key]=Number(fields[key]);
 const created=await api('/api/tasks',fields);selectedRequest=created.id;$('notice').textContent='Request created. Start it to follow the resource and payment flow.';await refresh();
}catch(e){$('notice').textContent=e.message}finally{button.disabled=false}});
$('tasks').addEventListener('click',async e=>{const button=e.target.closest('button[data-action]');if(!button)return;button.disabled=true;
 try{const id=button.closest('[data-task]').dataset.task;const action=button.dataset.action;const approval=['approve','decline'].includes(action);
 await api(`/api/tasks/${id}/${approval?'approval':action}`,approval?{id:button.dataset.approval,approve:action==='approve'}:{});
 $('notice').textContent=approval?'Approval decision recorded.':action==='stop'?'Request stopped. Already reserved or submitted payments may still settle.':'Resource requested.';await refresh();
 }catch(e){$('notice').textContent=e.message}finally{button.disabled=false}});
$('selected-request').addEventListener('change',e=>{selectedRequest=e.target.value;renderTasks()});
$('refresh').addEventListener('click',()=>refresh().catch(e=>$('notice').textContent=e.message));
refresh().catch(e=>$('notice').textContent=e.message);
setInterval(()=>{if(!document.hidden)refresh().catch(()=>$('notice').textContent='Connection unavailable. Payments may still be pending.');},1500);
