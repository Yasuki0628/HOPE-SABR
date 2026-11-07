const {execSync}=require('child_process');const GW='http://localhost:8150',K='anon-test-key';
const R=[];const T=(n,ok,x)=>R.push((ok?'PASS ':'FAIL ')+n+(ok?'':'  '+x));
const H=(t)=>({apikey:K,'content-type':'application/json',authorization:'Bearer '+(t||K)});
const call=async(m,p,b,t)=>{const r=await fetch(GW+p,{method:m,headers:H(t),body:b==null?undefined:JSON.stringify(b)});let j=null;try{j=await r.json()}catch(e){}return{s:r.status,j}};
const rpc=(fn,a,t)=>call('POST','/rest/v1/rpc/'+fn,a||{},t);
const user=async(n)=>{const e=n+Math.random().toString(36).slice(2,6)+'@example.com';let r=await call('POST','/auth/v1/signup',{email:e,password:'password1'});return{e,t:r.j.access_token,id:r.j.user.id,rt:r.j.refresh_token}};
const sql=q=>execSync(`psql -h ${process.env.PGHOST||"/tmp/t/pg"} -p 5544 -U postgres -d hope -At -q -c "${q}"`).toString().trim();
(async()=>{
const A=await user('a'),B=await user('b'),C=await user('c'),D=await user('d');
// 認証なし
let r=await rpc('my_teams',{}, K);T('匿名キーだけではRPCを実行できない',r.s==403||r.s==401,JSON.stringify(r));
r=await call('GET','/rest/v1/records?team_id=eq.00000000-0000-0000-0000-000000000000',null,K);T('匿名キーだけでは表を読めない',r.s==403,JSON.stringify(r));
r=await rpc('my_teams',{}, A.t.slice(0,-3)+'abc');T('改ざんしたトークンは拒否（401）',r.s==401);
// チーム作成
r=await rpc('create_team',{p_name:'HOPE'},A.t);const T1=r.j.team_id;T('チーム作成：作成者は admin',r.s==200&&r.j.role=='admin');
r=await rpc('create_team',{p_name:'  '},A.t);T('空のチーム名は拒否',r.s==400&&r.j.message=='bad_name');
r=await rpc('create_team',{p_name:'Other'},D.t);const T2=r.j.team_id;
// 招待
r=await rpc('create_invite',{p_team:T1,p_role:'coach',p_days:7,p_max:1},B.t);T('招待作成：チーム外の人は不可',r.s==403,JSON.stringify(r));
r=await rpc('create_invite',{p_team:T1,p_role:'coach',p_days:7,p_max:1},A.t);const codeB=r.j.code;T('招待作成：adminは可・コードは16桁(XXXX-XXXX-XXXX-XXXX)',/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(codeB),JSON.stringify(r.j));
r=await rpc('join_team',{p_code:codeB.toLowerCase()},B.t);T('招待で参加：小文字入力でも可・指導者になる',r.s==200&&r.j.role=='coach'&&r.j.team_id==T1,JSON.stringify(r));
r=await rpc('join_team',{p_code:codeB},C.t);T('1回限りの招待は2人目が使えない',r.j&&r.j.error=='invalid_invite');
r=await rpc('create_invite',{p_team:T1,p_role:'viewer',p_days:7,p_max:5},A.t);const codeC=r.j.code;
r=await rpc('join_team',{p_code:codeC},C.t);T('閲覧者として参加',r.j.role=='viewer');
r=await rpc('create_invite',{p_team:T1,p_role:'viewer',p_days:1,p_max:5},A.t);const codeX=r.j.code;sql(`update invites set expires_at=now()-interval '1 minute' where code='${codeX}'`);
r=await rpc('join_team',{p_code:codeX},D.t);T('期限切れの招待は使えない',r.j.error=='invalid_invite');
r=await rpc('create_invite',{p_team:T1,p_role:'viewer',p_days:1,p_max:5},A.t);const codeR=r.j.code;await rpc('revoke_invite',{p_team:T1,p_code:codeR},A.t);
r=await rpc('join_team',{p_code:codeR},D.t);T('取り消した招待は使えない',r.j.error=='invalid_invite');
r=await rpc('revoke_invite',{p_team:T1,p_code:codeC},B.t);T('招待の取り消し：admin以外は不可',r.s==403);
// ブルートフォース制限
const E=await user('e');let last;for(let i=0;i<11;i++)last=await rpc('join_team',{p_code:'0000-0000-0000-'+String(i).padStart(4,'0')},E.t);
await rpc('create_invite',{p_team:T1,p_role:'viewer',p_days:1,p_max:5},A.t).then(x=>{E.code=x.j.code});
r=await rpc('join_team',{p_code:E.code},E.t);T('招待コードの総当たり：失敗10回で1時間ロック（正しいコードでも拒否）',r.s==400&&r.j.message=='too_many_attempts',JSON.stringify(r));
// 同期 push/pull と権限
const ch=(rid,data,br,coll,grp)=>({coll:coll||'p',rid,base_rev:br||0,data,grp:grp||null});
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('p1',{id:'p1',name:'太郎'}),ch('g1',{id:'g1'},0,'g','g1')]},C.t);T('閲覧者は push できない',r.s==403&&r.j.message=='forbidden_role');
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('p1',{id:'p1',name:'太郎'})]},D.t);T('チーム外の人は push できない',r.s==403&&r.j.message=='forbidden');
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('p1',{id:'p1',name:'太郎'}),ch('g1',{id:'g1',rs:3},0,'g','g1'),ch('a1',{id:'a1',gid:'g1'},0,'a','g1')]},B.t);T('指導者は push できる・rev=1,seq=1..3',r.s==200&&r.j.applied.length==3&&r.j.applied[0].rev==1&&r.j.seq==3,JSON.stringify(r.j));
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('p1',{id:'p1',name:'次郎'},1)]},A.t);T('rev一致の更新は適用（rev=2）',r.j.applied[0].rev==2&&r.j.applied[0].seq==4);
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('p1',{id:'p1',name:'三郎'},1)]},B.t);T('古いrevからの更新は競合として返り、上書きしない',r.j.conflicts.length==1&&r.j.conflicts[0].server.rev==2&&r.j.conflicts[0].server.data.name=='次郎'&&r.j.applied.length==0,JSON.stringify(r.j));
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('p1',{id:'p1',name:'別人'},0)]},B.t);T('既にある記録を「新規」として送ると競合',r.j.conflicts.length==1);
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('zz',{id:'zz'},5)]},B.t);T('存在しない記録に古いrevを付けると競合',r.j.conflicts.length==1);
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('a1',null,1,'a','g1')]},B.t);T('削除は墓標（tombstone）として記録される',r.j.applied[0].rev==2&&sql(`select deleted::text||':'||coalesce(data::text,'null') from records where team_id='${T1}' and rid='a1'`)=='true:null');
r=await rpc('sync_pull',{p_team:T1,p_since:0,p_limit:500},C.t);T('閲覧者は pull できる（全記録＋削除）',r.s==200&&r.j.rows.length==3&&r.j.rows.some(x=>x.rid=='a1'&&x.deleted)&&r.j.rows.every((x,i,a)=>!i||a[i-1].seq<x.seq),JSON.stringify(r.j).slice(0,200));
r=await rpc('sync_pull',{p_team:T1,p_since:4,p_limit:500},C.t);T('差分pull：since以降だけ返る',r.j.rows.length==1&&r.j.rows[0].rid=='a1');
r=await rpc('sync_pull',{p_team:T1,p_since:0,p_limit:2},C.t);T('pullの分割：moreフラグ',r.j.rows.length==2&&r.j.more==true);
r=await rpc('sync_pull',{p_team:T1,p_since:0},D.t);T('チーム外の人は pull できない',r.s==403);
r=await rpc('sync_pull',{p_team:T2,p_since:0},A.t);T('別チームのデータは pull できない（A→T2）',r.s==403);
r=await rpc('sync_push',{p_team:T2,p_changes:[ch('x',{id:'x'})]},A.t);T('別チームへ push できない（A→T2）',r.s==403);
r=await rpc('sync_push',{p_team:T2,p_changes:[ch('p1',{id:'p1',name:'T2の選手'})]},D.t);const r2=await rpc('sync_pull',{p_team:T1,p_since:0},A.t);T('同じrid でもチームごとに独立',r.j.applied[0].rev==1&&r2.j.rows.find(x=>x.rid=='p1').data.name=='次郎');
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('x',{id:'x'},0,'drop table')]},B.t);T('不正なコレクション名は拒否',r.s==400&&r.j.message=='bad_collection');
r=await rpc('sync_push',{p_team:T1,p_changes:[ch("q'\";--",{id:'q',n:"'; drop table records; --"},0,'p')]},B.t);T('引用符・SQL文字を含む値は文字として保存される（インジェクションなし）',r.s==200&&sql("select count(*) from records where rid like 'q%;--'")=='1'&&sql("select count(*) from pg_tables where tablename='records'")=='1');
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('big',{id:'big',x:'a'.repeat(1100000)})]},B.t);T('1MB超の記録は拒否',r.s==400&&r.j.message=='record_too_large');
r=await rpc('sync_push',{p_team:T1,p_changes:[...Array(501)].map((_,i)=>ch('r'+i,{id:'r'+i}))},B.t);T('501件以上の一括送信は拒否',r.s==400&&r.j.message=='too_many_changes');
// 同時 push
const [x1,x2]=await Promise.all([rpc('sync_push',{p_team:T1,p_changes:[ch('race',{id:'race',v:1})]},A.t),rpc('sync_push',{p_team:T1,p_changes:[ch('race',{id:'race',v:2})]},B.t)]);
T('同時に同じ新規記録を送ると、片方だけ成功しもう片方は競合',(x1.j.applied.length+x2.j.applied.length)==1&&(x1.j.conflicts.length+x2.j.conflicts.length)==1,JSON.stringify([x1.j,x2.j]));
// RLS（直接アクセス）
r=await call('GET','/rest/v1/records?team_id=eq.'+T1,null,B.t);T('RLS: メンバーは自チームの records を読める',r.s==200&&r.j.length>=4);
r=await call('GET','/rest/v1/records?team_id=eq.'+T1,null,D.t);T('RLS: 外部の人は他チームの records が0件',r.s==200&&r.j.length==0);
r=await call('GET','/rest/v1/members?team_id=eq.'+T1,null,D.t);T('RLS: 外部の人は他チームの members が0件',r.j.length==0);
r=await call('GET','/rest/v1/records',null,D.t);T('RLS: フィルタなしでも自分のチーム(T2)の分しか見えない',r.j.every(x=>x.team_id==T2)&&r.j.length==1);
r=await call('GET','/rest/v1/teams',null,C.t);T('RLS: teams は所属チームだけ',r.j.length==1&&r.j[0].id==T1);
for(const t of ['invites','backups','join_attempts']){r=await call('GET','/rest/v1/'+t,null,A.t);T('RLS: '+t+' は管理者でも直接は読めない',r.s==403);}
r=await call('POST','/rest/v1/records',{team_id:T1,coll:'p',rid:'hack',data:{},rev:1,seq:999},A.t);T('直接INSERT拒否（adminでも）',r.s==403);
r=await call('PATCH','/rest/v1/records?team_id=eq.'+T1,{rev:99},A.t);T('直接UPDATE拒否（adminでも）',r.s==403);
r=await call('DELETE','/rest/v1/records?team_id=eq.'+T1,null,A.t);T('直接DELETE拒否（adminでも）',r.s==403);
r=await call('PATCH','/rest/v1/members?team_id=eq.'+T1,{role:'admin'},C.t);T('直接の権限書き換え拒否（閲覧者が admin になれない）',r.s==403&&sql(`select role from members where user_id='${C.id}'`)=='viewer');
r=await rpc('h_need',{p_team:T1},A.t);T('内部関数 h_need はクライアントから実行できない',r.s==403||r.s==404||r.s==400,JSON.stringify(r));
// メンバー管理
r=await rpc('list_members',{p_team:T1},C.t);T('メンバー一覧：閲覧者も見られる（3人）',r.j.length==3);
r=await rpc('list_members',{p_team:T1},D.t);T('メンバー一覧：外部は不可',r.s==403);
r=await rpc('set_role',{p_team:T1,p_user:C.id,p_role:'admin'},B.t);T('権限変更：指導者は不可',r.s==403);
r=await rpc('set_role',{p_team:T1,p_user:C.id,p_role:'coach'},A.t);T('権限変更：adminは可（閲覧者→指導者）',r.s==200);
r=await rpc('sync_push',{p_team:T1,p_changes:[ch('byC',{id:'byC'})]},C.t);T('権限変更が即時に反映（元閲覧者が push 可能に）',r.s==200&&r.j.applied.length==1);
r=await rpc('set_role',{p_team:T1,p_user:C.id,p_role:'viewer'},A.t);r=await rpc('sync_push',{p_team:T1,p_changes:[ch('byC2',{id:'byC2'})]},C.t);T('閲覧者に戻すと push 不可に戻る',r.s==403);
r=await rpc('set_role',{p_team:T1,p_user:A.id,p_role:'coach'},A.t);T('最後の管理者は降格できない',r.s==400&&r.j.message=='last_admin');
r=await rpc('remove_member',{p_team:T1,p_user:A.id},A.t);T('最後の管理者は退出できない',r.s==400&&r.j.message=='last_admin');
r=await rpc('remove_member',{p_team:T1,p_user:C.id},B.t);T('メンバー削除：指導者は他人を削除できない',r.s==403);
r=await rpc('remove_member',{p_team:T1,p_user:C.id},C.t);T('自分から退出は可',r.s==200);
r=await rpc('sync_pull',{p_team:T1,p_since:0},C.t);T('退出後は pull できない',r.s==403);
// バックアップ
const payload=JSON.stringify({v:1,p:[1,2,3]});
r=await rpc('backup_create',{p_team:T1,p_label:'手動',p_payload:payload},B.t);const bid=r.j.id;T('クラウドバックアップ：指導者は作成可',r.s==200&&!!bid);
r=await rpc('backup_create',{p_team:T1,p_label:'x',p_payload:payload},D.t);T('クラウドバックアップ：外部は作成不可',r.s==403);
r=await rpc('backup_list',{p_team:T1},B.t);T('一覧：指導者は見られる',r.j.length==1&&r.j[0].size==payload.length&&r.j[0].payload===undefined);
r=await rpc('backup_get',{p_team:T1,p_id:bid},B.t);T('復元用の取得：指導者は不可',r.s==403);
r=await rpc('backup_get',{p_team:T1,p_id:bid},A.t);T('復元用の取得：管理者は可・内容が完全一致',r.j.payload===payload);
r=await rpc('backup_get',{p_team:T2,p_id:bid},D.t);T('他チームのバックアップIDでは取得できない（not_found）',r.s==400&&r.j.message=='not_found');
for(let i=0;i<22;i++)await rpc('backup_create',{p_team:T1,p_label:'n'+i,p_payload:payload},A.t);
r=await rpc('backup_list',{p_team:T1},A.t);T('バックアップは最新20件まで保持',r.j.length==20);
r=await rpc('backup_create',{p_team:T1,p_label:'big',p_payload:''},A.t);T('空のバックアップは拒否',r.s==400);
console.log(R.join('\n'));console.log('FAIL:',R.filter(x=>x.startsWith('FAIL')).length,'/',R.length)})();
