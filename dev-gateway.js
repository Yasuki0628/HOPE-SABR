// 開発・検証専用ゲートウェイ（本番では使いません）。
// Supabase（GoTrue + PostgREST）の「このアプリが使う部分だけ」を、ローカルの PostgreSQL の上で再現します。
// 認証は簡易版（メール＋パスワード→HS256のJWT）。権限の判定は schema.sql の関数と RLS が行います（ここでは判定しません）。
const http=require('http'),crypto=require('crypto'),{spawn}=require('child_process');
const PORT=+process.env.GW_PORT||8150,DB=process.env.GW_DB||'hope',PGH=process.env.PGHOST||'/tmp/t/pg',PGP=process.env.PGPORT||'5544';
const SECRET=process.env.GW_SECRET||crypto.randomBytes(32).toString('hex'),ANON=process.env.GW_ANON||'anon-test-key',TTL=+process.env.GW_TTL||3600;
const ctl={down:false,delay:0,ttl:TTL,fail:0,log:[]};const rts=new Map();
const b64=b=>Buffer.from(b).toString('base64url');
const sign=c=>{const h=b64(JSON.stringify({alg:'HS256',typ:'JWT'})),p=b64(JSON.stringify(c));return h+'.'+p+'.'+crypto.createHmac('sha256',SECRET).update(h+'.'+p).digest('base64url')};
const verify=t=>{try{const[a,b,c]=t.split('.');if(crypto.createHmac('sha256',SECRET).update(a+'.'+b).digest('base64url')!==c)return null;const p=JSON.parse(Buffer.from(b,'base64url'));if(p.exp<Date.now()/1000)return null;return p}catch(e){return null}};
const psql=(sql)=>new Promise(res=>{const p=spawn('psql',['-h',PGH,'-p',PGP,'-U','postgres','-d',DB,'-At','-q','-v','ON_ERROR_STOP=1'],{env:process.env});let o='',e='';p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>e+=d);p.on('close',c=>res({c,o,e}));p.stdin.end(sql)});
const lit=(v,t)=>{if(t=='int'||t=='bigint'){if(v==null)return'null';if(!/^-?\d+$/.test(String(v)))throw new Error('bad int');return String(v)+'::'+t}if(v==null)return'null::'+t;const s=t=='jsonb'?JSON.stringify(v):String(v);let tag;do{tag='q'+crypto.randomBytes(6).toString('hex')}while(s.includes('$'+tag+'$'));return'$'+tag+'$'+s+'$'+tag+'$::'+t};
const TY={p_team:'uuid',p_name:'text',p_role:'text',p_days:'int',p_max:'int',p_code:'text',p_user:'uuid',p_since:'bigint',p_limit:'int',p_changes:'jsonb',p_device:'text',p_label:'text',p_payload:'text',p_id:'uuid'};
const FN=new Set(['create_team','my_teams','create_invite','list_invites','revoke_invite','join_team','list_members','set_role','remove_member','sync_pull','sync_push','backup_create','backup_list','backup_get','h_need','h_role']);
const TB=new Set(['teams','members','invites','join_attempts','records','backups']);
const asRole=(claims,body)=>{const role=claims?'authenticated':'anon';return`begin;set local role ${role};select set_config('request.jwt.claims',${lit(JSON.stringify(claims||{}),'text')},true);${body};commit;`};
const send=(r,code,obj)=>{const s=obj==null?'':JSON.stringify(obj);r.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'apikey,authorization,content-type,prefer,x-client-info','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS'});r.end(s)};
const body=q=>new Promise(res=>{let d='';q.on('data',c=>{d+=c;if(d.length>30e6)q.destroy()});q.on('end',()=>{try{res(d?JSON.parse(d):{})}catch(e){res(null)}})});
const pgErr=e=>{const m=/ERROR:\s+(.*)/.exec(e);return m?m[1].trim():'db_error'};
const issue=u=>{const now=Math.floor(Date.now()/1000),at=sign({sub:u.id,email:u.email,role:'authenticated',aud:'authenticated',iat:now,exp:now+ctl.ttl}),rt=crypto.randomBytes(24).toString('hex');rts.set(rt,u.id);return{access_token:at,token_type:'bearer',expires_in:ctl.ttl,expires_at:now+ctl.ttl,refresh_token:rt,user:{id:u.id,email:u.email}}};
http.createServer(async(q,r)=>{try{
 if(q.method=='OPTIONS')return send(r,204);
 const url=new URL(q.url,'http://x'),path=url.pathname;
 if(path=='/__ctl'){const b=await body(q);Object.assign(ctl,b||{});return send(r,200,ctl)}
 if(path=='/__reset'){rts.clear();return send(r,200,{})}
 if(ctl.delay)await new Promise(z=>setTimeout(z,ctl.delay));
 if(ctl.down)return send(r,503,{message:'service unavailable'});
 if(ctl.fail>0){ctl.fail--;return send(r,500,{message:'injected failure'})}
 if(q.headers.apikey!==ANON)return send(r,401,{message:'No API key found'});
 const au=(q.headers.authorization||'').replace(/^Bearer\s+/i,''),claims=au&&au!==ANON?verify(au):null;
 if(au&&au!==ANON&&!claims)return send(r,401,{message:'JWT expired',code:'PGRST303'});
 if(path=='/auth/v1/signup'){const b=await body(q);if(!b||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email||'')||String(b.password||'').length<8)return send(r,422,{msg:'invalid email or password too short',error_code:'weak_password'});
  const x=await psql(`insert into auth.users(email,pw) values (${lit(b.email.toLowerCase(),'text')},${lit(crypto.createHash('sha256').update(b.password).digest('hex'),'text')}) returning id,email;`);if(x.c)return send(r,422,{msg:'User already registered',error_code:'user_already_exists'});const[id,email]=x.o.trim().split('|');return send(r,200,issue({id,email}))}
 if(path=='/auth/v1/token'){const g=url.searchParams.get('grant_type'),b=await body(q)||{};
  if(g=='password'){const x=await psql(`select id,email from auth.users where email=${lit(String(b.email||'').toLowerCase(),'text')} and pw=${lit(crypto.createHash('sha256').update(String(b.password||'')).digest('hex'),'text')};`);if(!x.o.trim())return send(r,400,{error:'invalid_grant',error_description:'Invalid login credentials'});const[id,email]=x.o.trim().split('|');return send(r,200,issue({id,email}))}
  if(g=='refresh_token'){const uid=rts.get(b.refresh_token);if(!uid)return send(r,400,{error:'invalid_grant',error_description:'Invalid Refresh Token'});rts.delete(b.refresh_token);const x=await psql(`select id,email from auth.users where id=${lit(uid,'uuid')};`);const[id,email]=x.o.trim().split('|');return send(r,200,issue({id,email}))}
  return send(r,400,{error:'unsupported_grant_type'})}
 if(path=='/auth/v1/recover')return send(r,200,{});
 if(path=='/auth/v1/logout')return send(r,204);
 let m=/^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path);
 if(m&&q.method=='POST'){const fn=m[1];if(!FN.has(fn))return send(r,404,{message:'function not found'});const b=await body(q);if(b==null)return send(r,400,{message:'bad json'});
  let args;try{args=Object.keys(b).map(k=>{if(!TY[k])throw new Error('unknown arg '+k);return`${k} => ${lit(b[k],TY[k])}`}).join(',')}catch(e){return send(r,400,{message:e.message})}
  const x=await psql(asRole(claims,`select public.${fn}(${args})`));if(x.c){const msg=pgErr(x.e);return send(r,/permission denied/.test(msg)?403:/^(forbidden|forbidden_role)$/.test(msg)?403:/^unauthenticated$/.test(msg)?401:400,{message:msg})}
  const line=x.o.split('\n').filter(s=>s&&s!='BEGIN'&&s!='COMMIT'&&!/^set_config|^SET$/.test(s)).filter(s=>s[0]=='{'||s[0]=='[');return send(r,200,JSON.parse(line[line.length-1]||'null'))}
 m=/^\/rest\/v1\/([a-z_]+)$/.exec(path);
 if(m&&TB.has(m[1])){const t=m[1];let w='true';for(const[k,v]of url.searchParams){if(k=='select')continue;if(!/^[a-z_]+$/.test(k))return send(r,400,{message:'bad column'});const mm=/^eq\.(.*)$/.exec(v);if(!mm)return send(r,400,{message:'only eq'});w+=` and ${k}::text=${lit(mm[1],'text')}`}
  if(q.method=='GET'){const x=await psql(asRole(claims,`select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select * from public.${t} where ${w} limit 1000) t`));if(x.c)return send(r,403,{message:pgErr(x.e)});const line=x.o.split('\n').filter(s=>s[0]=='[');return send(r,200,JSON.parse(line[line.length-1]||'[]'))}
  if(q.method=='POST'){const b=await body(q);const x=await psql(asRole(claims,`insert into public.${t} select * from jsonb_populate_record(null::public.${t}, ${lit(b,'jsonb')})`));return x.c?send(r,403,{message:pgErr(x.e)}):send(r,201,{})}
  if(q.method=='PATCH'){const b=await body(q);const k=Object.keys(b||{})[0];if(!k||!/^[a-z_]+$/.test(k))return send(r,400,{});const x=await psql(asRole(claims,`update public.${t} set ${k}=${lit(String(b[k]),'text')} where ${w}`));return x.c?send(r,403,{message:pgErr(x.e)}):send(r,204)}
  if(q.method=='DELETE'){const x=await psql(asRole(claims,`delete from public.${t} where ${w}`));return x.c?send(r,403,{message:pgErr(x.e)}):send(r,204)}}
 send(r,404,{message:'not found'})}catch(e){send(r,500,{message:String(e&&e.message||e)})}}).listen(PORT,()=>console.log('gateway on',PORT));
