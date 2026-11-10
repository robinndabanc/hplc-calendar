import { env } from 'cloudflare:workers';
const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Cache-Control':'no-store'};
const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers});
export async function OPTIONS(){return new Response(null,{headers});}
async function hash(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function GET(){try{const db=env.DB!;const people=await db.prepare('SELECT id,name,color FROM members ORDER BY id').all();const rows=await db.prepare("SELECT id,owner,type,payload FROM records WHERE type != 'sessions'").all();return json({people:people.results,records:rows.results});}catch{return json({error:'Shared calendar is temporarily unavailable.'},503);}}
export async function POST(req:Request){try{if(Number(req.headers.get('Content-Length'))>20000)return json({error:'Request too large.'},413);const raw=await req.text();if(raw.length>20000)return json({error:'Request too large.'},413);const b=JSON.parse(raw);const db=env.DB!;const token=req.headers.get('Authorization')?.replace(/^Bearer /,'')||'';if(!/^[a-f0-9]{64}$/.test(token))return json({error:'Please enter your name to join.'},401);const tokenHash=await hash(token);let member:any=await db.prepare("SELECT m.id,m.name,m.color FROM members m JOIN records r ON r.owner=m.id WHERE r.id=? AND r.type='sessions'").bind('session:'+tokenHash).first();
if(!member)member=await db.prepare('SELECT id,name,color FROM members WHERE token_hash=?').bind(tokenHash).first();
// This is a trusted-friends calendar: choosing a name grants editing access.
if(b.action==='select-profile'){
 const selected=await db.prepare('SELECT id,name,color FROM members WHERE id=?').bind(Number(b.memberId)||0).first();
 if(!selected)return json({error:'That profile no longer exists.'},404);
 await db.prepare("INSERT INTO records(id,owner,type,payload) VALUES(?,?,'sessions','{}') ON CONFLICT(id) DO UPDATE SET owner=excluded.owner").bind('session:'+tokenHash,selected.id).run();
 return json({member:selected});
}
if(b.action==='delete-profile'){
 if(!member)return json({error:'Choose your profile first.'},401);
 if(b.confirmName!==member.name)return json({error:'Type the exact profile name to confirm.'},400);
 await db.batch([
  db.prepare("DELETE FROM records WHERE type='votes' AND json_extract(payload,'$.idea') IN (SELECT id FROM records WHERE owner=? AND type='ideas')").bind(member.id),
  db.prepare('DELETE FROM records WHERE owner=?').bind(member.id),
  db.prepare('DELETE FROM members WHERE id=?').bind(member.id)
 ]);
 return json({ok:true});
}

if(b.action==='join'||b.action==='profile'){const name=String(b.name||'').trim(),color=String(b.color||'');if(!name||name.length>32||!/^#[a-f0-9]{6}$/i.test(color))return json({error:'Enter a name and choose a colour.'},400);if(!member){const duplicate=await db.prepare('SELECT id FROM members WHERE lower(trim(name))=lower(?)').bind(name).first();if(duplicate)return json({error:'That name already exists. Choose it from the profile list.'},409);if(b.action!=='join')return json({error:'Join first.'},401);await db.prepare('INSERT INTO members(token_hash,name,color) VALUES(?,?,?) ON CONFLICT(token_hash) DO NOTHING').bind(tokenHash,name,color).run();}else await db.prepare('UPDATE members SET name=?,color=? WHERE id=?').bind(name,color,member.id).run();member=await db.prepare('SELECT id,name,color FROM members WHERE token_hash=?').bind(tokenHash).first();return json({member});}
if(!member)return json({error:'Please enter your name to join.'},401);
if(b.action==='vote'){const id=String(b.id||'');const idea=await db.prepare("SELECT id FROM records WHERE id=? AND type='ideas'").bind(id).first();if(!idea)return json({error:'Idea no longer exists.'},404);const vid='vote:'+member.id+':'+id;if(b.active)await db.prepare("INSERT INTO records(id,owner,type,payload) VALUES(?,?,'votes',?) ON CONFLICT(id) DO NOTHING").bind(vid,member.id,JSON.stringify({idea:id})).run();else await db.prepare('DELETE FROM records WHERE id=? AND owner=?').bind(vid,member.id).run();return json({ok:true});}
const allowed=['entries','ideas','events','pins'];if(!allowed.includes(b.type)||!/^[-a-zA-Z0-9]{1,80}$/.test(b.id||''))return json({error:'Invalid record.'},400);const existing:any=await db.prepare('SELECT owner,type FROM records WHERE id=?').bind(b.id).first();if(existing&&(existing.owner!==member.id||existing.type!==b.type))return json({error:'Only the person who added this can change it.'},403);
if(b.action==='delete'){await db.prepare('DELETE FROM records WHERE id=? AND owner=?').bind(b.id,member.id).run();return json({ok:true});}
if(b.action!=='save')return json({error:'Invalid action.'},400);const p=b.payload||{};const text=(v:any,n:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;const date=(v:any)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v));
if(b.type==='entries'&&!(date(p.date)&&Number.isInteger(p.start)&&Number.isInteger(p.end)&&p.start>=0&&p.end<=24&&p.start<p.end))return json({error:'Invalid free-time range.'},400);
if(['ideas','events'].includes(b.type)&&!text(p.title,70))return json({error:'Enter a title.'},400);
if(b.type==='ideas'&&!['Indoor','Outdoor','Either'].includes(p.kind))return json({error:'Invalid setting.'},400);
if(b.type==='events'&&(!date(p.date)||(p.at&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.at))||String(p.place||'').length>100))return json({error:'Invalid event date or time.'},400);
if(b.type==='pins'&&(!text(p.name,70)||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||Math.abs(p.lat)>90||Math.abs(p.lng)>180||String(p.note||'').length>300||(p.link&&!/^https?:\/\//i.test(p.link))))return json({error:'Invalid place details.'},400);
const clean=b.type==='entries'?{date:p.date,start:p.start,end:p.end}:b.type==='ideas'?{title:p.title,kind:p.kind}:b.type==='events'?{title:p.title,date:p.date,at:p.at||'',place:p.place||''}:{name:p.name,lat:p.lat,lng:p.lng,note:p.note||'',link:p.link||''};
await db.prepare('INSERT INTO records(id,owner,type,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE records.owner=excluded.owner').bind(b.id,member.id,b.type,JSON.stringify(clean)).run();return json({ok:true});
}catch{return json({error:'Could not save. Please retry.'},500);}}
