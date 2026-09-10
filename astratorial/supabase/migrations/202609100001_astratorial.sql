-- Astratorial v1. Apply with `supabase db push`. All source buckets are private.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgmq;
select pgmq.create('astratorial_jobs');

create table public.tutorials (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users on delete cascade,
  data jsonb not null, public_data jsonb, visibility text not null default 'private' check (visibility in ('private','public')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (data->>'id' = id::text), check (data->>'ownerId' = owner_id::text)
);
create index tutorials_owner_updated on public.tutorials(owner_id,updated_at desc);
create table public.tutorial_budgets (
  tutorial_id uuid not null references public.tutorials on delete cascade, revision integer not null check(revision>0),
  budget_usd numeric not null default 25 check(budget_usd=25), spent_usd numeric not null default 0 check(spent_usd>=0),
  reserved_usd numeric not null default 0 check(reserved_usd>=0), primary key(tutorial_id,revision)
);
create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(), tutorial_id uuid not null references public.tutorials on delete cascade,
  owner_id uuid not null references auth.users on delete cascade, revision integer not null,
  kind text not null check(kind in ('analyze','generate','publish','export')),
  status text not null default 'queued' check(status in ('queued','running','needs_context','budget_paused','completed','cancelled','failed')),
  stage text not null default 'upload' check(stage in ('upload','ingest','analyze','reconstruct','plan','animate','render','validate','publish','ready')),
  progress integer not null default 0 check(progress between 0 and 100), message text not null default 'Waiting to start', error text,
  checkpoint jsonb not null default '{}', lease_owner text, lease_until timestamptz, queue_message_id bigint,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(tutorial_id,revision) references public.tutorial_budgets(tutorial_id,revision)
);
create unique index generation_one_active on public.generation_jobs(tutorial_id) where status in ('queued','running');
create index jobs_tutorial on public.generation_jobs(tutorial_id,created_at desc);
create table public.cost_reservations (
  job_id uuid not null references public.generation_jobs on delete cascade, reservation_id text not null,
  amount numeric not null check(amount>=0), actual numeric check(actual>=0), created_at timestamptz not null default now(), primary key(job_id,reservation_id)
);
create table public.uploads (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users on delete cascade,
  tutorial_id uuid not null references public.tutorials on delete cascade, revision integer not null,
  asset jsonb not null, reserved_bytes bigint not null default 600000000 check(reserved_bytes between 0 and 600000000), client_fingerprint text check(client_fingerprint is null or client_fingerprint~'^[a-f0-9]{64}$'), completed boolean not null default false, created_at timestamptz not null default now()
);
create table public.practice_sessions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users on delete cascade,
  tutorial_id uuid not null references public.tutorials on delete cascade, data jsonb not null,
  pending_check uuid, check_started_at timestamptz,
  last_frame text check(length(last_frame)<=1000000), frame_step_id text, frame_expires_at timestamptz, check_spent_usd numeric not null default 0 check(check_spent_usd>=0),
  created_at timestamptz not null default now()
);
create table public.voice_sessions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users on delete cascade,
  tutorial_id uuid not null references public.tutorials on delete cascade, practice_session_id uuid references public.practice_sessions on delete set null,
  tutorial_revision integer not null, viewer_step_id text, viewer_action text, viewer_version integer not null default 0, camera_mode text not null default 'third' check(camera_mode in ('first','third','free')),
  expert_spent_usd numeric not null default 0 check(expert_spent_usd>=0),
  call_id text, status text not null default 'starting' check(status in ('starting','active','ended','failed')),
  budget_usd numeric not null default 2 check(budget_usd=2), spent_usd numeric not null default 0 check(spent_usd>=0),
  expires_at timestamptz not null default(now()+interval '10 minutes'), created_at timestamptz not null default now(), ended_at timestamptz
);
create table public.voice_expert_charges (
  voice_session_id uuid not null references public.voice_sessions on delete cascade,
  request_id text not null, amount numeric not null check(amount>=0), primary key(voice_session_id,request_id)
);
alter table public.voice_expert_charges enable row level security;
revoke all on public.voice_expert_charges from anon,authenticated;
grant all on public.voice_expert_charges to service_role;
create unique index voice_one_active on public.voice_sessions(owner_id) where status in ('starting','active');

-- No browser can directly write canonical progress, budgets, or public snapshots.
alter table public.tutorials enable row level security;
alter table public.tutorial_budgets enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.cost_reservations enable row level security;
alter table public.uploads enable row level security;
alter table public.practice_sessions enable row level security;
alter table public.voice_sessions enable row level security;
create policy own_tutorials on public.tutorials for select to authenticated using(owner_id=auth.uid());
create policy own_jobs on public.generation_jobs for select to authenticated using(owner_id=auth.uid());
create policy own_practice on public.practice_sessions for select to authenticated using(owner_id=auth.uid());
create policy own_voice on public.voice_sessions for select to authenticated using(owner_id=auth.uid());
revoke all on public.tutorials,public.tutorial_budgets,public.generation_jobs,public.cost_reservations,public.uploads,public.practice_sessions,public.voice_sessions from anon,authenticated;
grant select on public.tutorials,public.generation_jobs,public.practice_sessions,public.voice_sessions to authenticated;
grant all on public.tutorials,public.tutorial_budgets,public.generation_jobs,public.cost_reservations,public.uploads,public.practice_sessions,public.voice_sessions to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values('captures','captures',false,600000000),('tutorial-assets','tutorial-assets',false,1073741824) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit;
-- Upload writes use single-path signed tokens from the authenticated API. No public
-- storage policy exposes captures or generated assets; reads get expiring URLs.

create function public.job_json(p_id uuid) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('id',j.id,'tutorialId',j.tutorial_id,'revision',j.revision,'kind',j.kind,'status',j.status,'stage',j.stage,'progress',j.progress,'message',j.message,'budgetUsd',b.budget_usd,'spentUsd',b.spent_usd,'reservedUsd',b.reserved_usd,'createdAt',j.created_at,'updatedAt',j.updated_at,'error',j.error)
 from generation_jobs j join tutorial_budgets b using(tutorial_id,revision) where j.id=p_id;
$$;

create function public.create_tutorial(p_owner_id uuid,p_data jsonb) returns jsonb language plpgsql set search_path=public as $$
begin
 if p_data->>'ownerId' <> p_owner_id::text or (p_data->>'revision')::int <> 1 then raise exception 'invalid tutorial'; end if;
 insert into tutorials(id,owner_id,data) values((p_data->>'id')::uuid,p_owner_id,p_data);
 insert into tutorial_budgets(tutorial_id,revision) values((p_data->>'id')::uuid,1);
 return p_data;
end $$;

create function public.update_tutorial(p_id uuid,p_owner_id uuid,p_revision int,p_data jsonb) returns jsonb language plpgsql set search_path=public as $$
declare t tutorials; new_revision int;
begin
 select * into t from tutorials where id=p_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 if (t.data->>'revision')::int <> p_revision then raise exception 'stale revision'; end if;
 if exists(select 1 from generation_jobs where tutorial_id=p_id and status in ('queued','running')) then raise exception 'active job'; end if;
 new_revision := (p_data->>'revision')::int;
 if new_revision not in (p_revision,p_revision+1) or p_data->>'id'<>p_id::text or p_data->>'ownerId'<>p_owner_id::text then raise exception 'invalid tutorial'; end if;
 insert into tutorial_budgets(tutorial_id,revision) values(p_id,new_revision) on conflict do nothing;
 p_data := p_data||jsonb_build_object('assets',t.data->'assets');
 update tutorials set data=p_data,visibility='private',public_data=null,updated_at=now() where id=p_id;
 return p_data;
end $$;

create function public.register_upload(p_id uuid,p_owner_id uuid,p_tutorial_id uuid,p_revision int,p_asset jsonb,p_client_fingerprint text default null) returns void language plpgsql set search_path=public as $$
declare t tutorials; tutorial_count int; tutorial_bytes bigint; account_bytes bigint; file_bytes bigint;
begin
 -- Serialize reservations for this account, including concurrent tutorials.
 perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));
 select * into t from tutorials where id=p_tutorial_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 if (t.data->>'revision')::int<>p_revision then raise exception 'stale revision'; end if;
 if exists(select 1 from generation_jobs where tutorial_id=t.id and status in ('queued','running')) then raise exception 'active job'; end if;
 file_bytes:=(p_asset->>'size')::bigint;
 if file_bytes<=0 or file_bytes>600000000 or p_asset->>'id'<>p_id::text or not starts_with(p_asset->>'path',p_owner_id::text||'/'||p_tutorial_id::text||'/r'||p_revision::text||'/') then raise exception 'invalid upload'; end if;
 if p_asset->>'kind'='manual' and file_bytes+coalesce((select sum((asset->>'size')::bigint) from uploads where tutorial_id=t.id and asset->>'kind'='manual'),0)>10000000 then raise exception 'upload limit: PDF manuals together must fit within 10 MB'; end if;
 select count(*),coalesce(sum(reserved_bytes),0) into tutorial_count,tutorial_bytes from uploads where tutorial_id=t.id;
 select coalesce(sum(reserved_bytes),0) into account_bytes from uploads where owner_id=p_owner_id;
 if tutorial_count>=30 or tutorial_bytes+600000000>2000000000 or account_bytes+600000000>5000000000 then raise exception 'upload limit: 30 files and 2 GB per tutorial, 5 GB per account'; end if;
 insert into uploads(id,owner_id,tutorial_id,revision,asset,client_fingerprint) values(p_id,p_owner_id,t.id,p_revision,p_asset,p_client_fingerprint);
end $$;

create function public.complete_upload(p_id uuid,p_owner_id uuid) returns jsonb language plpgsql set search_path=public as $$
declare u uploads; t tutorials; updated jsonb;
begin
 select * into u from uploads where id=p_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 select * into t from tutorials where id=u.tutorial_id and owner_id=p_owner_id for update;
 if u.completed then return t.data; end if;
 if (t.data->>'revision')::int <> u.revision then raise exception 'stale revision'; end if;
 if exists(select 1 from generation_jobs where tutorial_id=t.id and status in ('queued','running')) then raise exception 'active job'; end if;
 updated := t.data || jsonb_build_object('assets',coalesce(t.data->'assets','[]')||jsonb_build_array(u.asset),'updatedAt',now());
 update tutorials set data=updated,updated_at=now() where id=t.id;
 -- The API checked Storage's actual size before this service-only settlement.
 update uploads set completed=true,reserved_bytes=(asset->>'size')::bigint where id=u.id;
 return updated;
end $$;

create function public.enqueue_job(p_tutorial_id uuid,p_owner_id uuid,p_kind text) returns jsonb language plpgsql set search_path=public,pgmq as $$
declare t public.tutorials; j public.generation_jobs; rev int; message_id bigint;
begin
 select * into t from public.tutorials where id=p_tutorial_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 rev := (t.data->>'revision')::int;
 select * into j from public.generation_jobs where tutorial_id=t.id and revision=rev and kind=p_kind and status in ('queued','running','completed') order by created_at desc limit 1;
 if found then return public.job_json(j.id); end if;
 if exists(select 1 from public.generation_jobs where tutorial_id=t.id and status in ('queued','running')) then raise exception 'active job'; end if;
 insert into public.tutorial_budgets(tutorial_id,revision) values(t.id,rev) on conflict do nothing;
 insert into public.generation_jobs(tutorial_id,owner_id,revision,kind,stage) values(t.id,p_owner_id,rev,p_kind,case when p_kind in ('publish','export') then 'publish' else 'ingest' end) returning * into j;
 select pgmq.send('astratorial_jobs',jsonb_build_object('jobId',j.id)) into message_id;
 update public.generation_jobs set queue_message_id=message_id where id=j.id;
 if p_kind in ('analyze','generate') then update public.tutorials set data=data||jsonb_build_object('status',case when p_kind='analyze' then 'analyzing' else 'generating' end,'job',public.job_json(j.id)),updated_at=now() where id=t.id; end if;
 return public.job_json(j.id);
end $$;

create function public.control_job(p_id uuid,p_owner_id uuid,p_action text) returns jsonb language plpgsql set search_path=public,pgmq as $$
declare j public.generation_jobs; t public.tutorials; message_id bigint;
begin
 select * into j from public.generation_jobs where id=p_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 select * into t from public.tutorials where id=j.tutorial_id for update;
 if p_action='cancel' then
  if j.status='completed' then return public.job_json(j.id); end if;
  if j.status in ('queued','running','needs_context','budget_paused','failed') then
   update public.generation_jobs set status='cancelled',message='Cancelled. Completed checkpoints have been saved.',lease_owner=null,lease_until=null,updated_at=now() where id=j.id;
   if j.queue_message_id is not null then perform pgmq.archive('astratorial_jobs',j.queue_message_id); end if;
  end if;
 elsif p_action='resume' then
  if j.status in ('queued','running','completed') then return public.job_json(j.id); end if;
  if (t.data->>'revision')::int<>j.revision then raise exception 'stale revision'; end if;
  if exists(select 1 from public.generation_jobs where tutorial_id=t.id and status in ('queued','running')) then raise exception 'active job'; end if;
  if exists(select 1 from public.tutorial_budgets where tutorial_id=t.id and revision=j.revision and spent_usd+reserved_usd>=budget_usd) then raise exception 'budget exhausted'; end if;
  select pgmq.send('astratorial_jobs',jsonb_build_object('jobId',j.id)) into message_id;
  update public.generation_jobs set status='queued',message='Resuming from the last saved checkpoint',error=null,lease_owner=null,lease_until=null,queue_message_id=message_id,updated_at=now() where id=j.id;
 else raise exception 'invalid action'; end if;
 update public.tutorials set data=data||jsonb_build_object('job',public.job_json(j.id),'status',case when p_action='cancel' then 'draft' when j.kind='analyze' then 'analyzing' else 'generating' end),updated_at=now() where id=t.id;
 return public.job_json(j.id);
end $$;

create function public.claim_job(p_worker_id text,p_lease_seconds int default 180) returns jsonb language plpgsql set search_path=public,pgmq as $$
declare msg record; j public.generation_jobs; t public.tutorials;
begin
 for msg in select * from pgmq.read('astratorial_jobs',greatest(30,least(p_lease_seconds,900)),1) loop
  select * into j from public.generation_jobs where id=(msg.message->>'jobId')::uuid for update skip locked;
  if not found then continue; end if;
  if j.status not in ('queued','running') then perform pgmq.archive('astratorial_jobs',msg.msg_id); continue; end if;
  if j.lease_until>now() then continue; end if;
  select * into t from public.tutorials where id=j.tutorial_id;
  if (t.data->>'revision')::int<>j.revision then
   update public.generation_jobs set status='cancelled',message='A newer tutorial revision exists.',updated_at=now() where id=j.id;
   perform pgmq.archive('astratorial_jobs',msg.msg_id); continue;
  end if;
  update public.generation_jobs set status='running',lease_owner=p_worker_id,lease_until=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,900))),queue_message_id=msg.msg_id,updated_at=now() where id=j.id;
  return jsonb_build_object('job',public.job_json(j.id),'tutorial',t.data,'checkpoint',j.checkpoint);
 end loop;
 return null;
end $$;

create function public.heartbeat_job(p_job_id uuid,p_worker_id text,p_lease_seconds int default 180) returns boolean language plpgsql set search_path=public,pgmq as $$
declare j public.generation_jobs;
begin
 select * into j from public.generation_jobs where id=p_job_id and lease_owner=p_worker_id and lease_until>now() and status='running' for update;
 if not found then return false; end if;
 update public.generation_jobs set lease_until=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,900))) where id=j.id;
 perform pgmq.set_vt('astratorial_jobs',j.queue_message_id,greatest(30,least(p_lease_seconds,900)));
 return true;
end $$;

create function public.checkpoint_job(p_job_id uuid,p_worker_id text,p_stage text,p_progress int,p_message text,p_checkpoint jsonb,p_tutorial_patch jsonb default '{}',p_status text default 'running',p_error text default null) returns jsonb language plpgsql set search_path=public,pgmq as $$
declare j public.generation_jobs; patch jsonb;
begin
 select * into j from public.generation_jobs where id=p_job_id and lease_owner=p_worker_id and lease_until>now() and status='running' for update;
 if not found then raise exception 'worker lease lost'; end if;
 -- A worker may update generated fields; identity, captures, revision and ownership stay authoritative.
 select coalesce(jsonb_object_agg(key,value),'{}') into patch from jsonb_each(p_tutorial_patch) where key in ('title','slug','description','category','plan','scene','status','thumbnailUrl');
 update public.generation_jobs set stage=p_stage,progress=p_progress,message=p_message,checkpoint=p_checkpoint,status=p_status,error=p_error,updated_at=now() where id=j.id;
 update public.tutorials set data=data||patch||jsonb_build_object('updatedAt',now(),'job',public.job_json(j.id)),updated_at=now() where id=j.tutorial_id and (data->>'revision')::int=j.revision;
 if p_status<>'running' then
  update public.generation_jobs set lease_owner=null,lease_until=null where id=j.id;
  perform pgmq.archive('astratorial_jobs',j.queue_message_id);
 end if;
 return public.job_json(j.id);
end $$;

create function public.reserve_job_cost(p_job_id uuid,p_worker_id text,p_reservation_id text,p_amount numeric) returns boolean language plpgsql set search_path=public as $$
declare j generation_jobs; b tutorial_budgets; prior cost_reservations;
begin
 if p_amount<0 then raise exception 'invalid cost'; end if;
 select * into j from generation_jobs where id=p_job_id and lease_owner=p_worker_id and lease_until>now() and status='running' for update;
 if not found then raise exception 'worker lease lost'; end if;
 select * into b from tutorial_budgets where tutorial_id=j.tutorial_id and revision=j.revision for update;
 select * into prior from cost_reservations where job_id=j.id and reservation_id=p_reservation_id;
 -- An existing reservation may have launched paid work before a crash. Never
 -- authorize it twice; each retry must reserve a new attempt ID.
 if found then return false; end if;
 if b.spent_usd+b.reserved_usd+p_amount>b.budget_usd then return false; end if;
 insert into cost_reservations(job_id,reservation_id,amount) values(j.id,p_reservation_id,p_amount);
 update tutorial_budgets set reserved_usd=reserved_usd+p_amount where tutorial_id=j.tutorial_id and revision=j.revision;
 return true;
end $$;

create function public.settle_job_cost(p_job_id uuid,p_worker_id text,p_reservation_id text,p_actual numeric) returns void language plpgsql set search_path=public as $$
declare j generation_jobs; r cost_reservations;
begin
 if p_actual<0 then raise exception 'invalid cost'; end if;
 -- Settlement is allowed after cancellation to account for already-started work.
 select * into j from generation_jobs where id=p_job_id for update;
 if not found then raise exception 'not found'; end if;
 select * into r from cost_reservations where job_id=j.id and reservation_id=p_reservation_id for update;
 if not found then raise exception 'reservation not found'; end if;
 if r.actual is not null then return; end if;
 update cost_reservations set actual=p_actual where job_id=j.id and reservation_id=p_reservation_id;
 update tutorial_budgets set reserved_usd=greatest(0,reserved_usd-r.amount),spent_usd=spent_usd+p_actual where tutorial_id=j.tutorial_id and revision=j.revision;
end $$;

create function public.commit_practice(p_id uuid,p_owner_id uuid,p_expected_version int,p_next jsonb,p_check_id uuid default null) returns jsonb language plpgsql set search_path=public as $$
declare s practice_sessions; t tutorials;
begin
 select * into s from practice_sessions where id=p_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 select * into t from tutorials where id=s.tutorial_id;
 if (s.data->>'version')::int<>p_expected_version or (s.data->>'tutorialRevision')::int<>(t.data->>'revision')::int then raise exception 'stale revision'; end if;
 if p_check_id is not null and s.pending_check is distinct from p_check_id then raise exception 'stale check'; end if;
 if p_next->>'id'<>s.id::text or p_next->>'ownerId'<>s.owner_id::text or (p_next->>'version')::int<>p_expected_version+1 then raise exception 'invalid session'; end if;
 update practice_sessions set data=p_next,pending_check=null,last_frame=case when p_check_id is not null then last_frame else null end,frame_step_id=case when p_check_id is not null then frame_step_id else null end,frame_expires_at=case when p_check_id is not null then frame_expires_at else null end where id=p_id;
 return p_next;
end $$;

create function public.begin_practice_check(p_id uuid,p_owner_id uuid,p_version int,p_check_id uuid,p_reservation numeric,p_frame text default null,p_step_id text default null) returns jsonb language plpgsql set search_path=public as $$
declare s practice_sessions; t tutorials;
begin
 select * into s from practice_sessions where id=p_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 select * into t from tutorials where id=s.tutorial_id;
 if (s.data->>'version')::int<>p_version or (s.data->>'tutorialRevision')::int<>(t.data->>'revision')::int then raise exception 'stale revision'; end if;
 if s.data->>'status'<>'active' then raise exception 'session not active'; end if;
 if s.check_started_at>now()-interval '5 seconds' or (s.pending_check is not null and s.check_started_at>now()-interval '90 seconds') then raise exception 'check in flight'; end if;
 -- Visual practice has a separate $2 per-session allowance, fixed reservation charged
 -- before calls, including ambiguous failures; retries cannot refund or race it.
 if p_frame is not null and (length(p_frame)>1000000 or p_frame!~'^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or p_step_id is distinct from t.data->'plan'->'steps'->((s.data->>'currentStepIndex')::int)->>'id') then raise exception 'invalid camera frame'; end if;
 if p_reservation<0.15 or s.check_spent_usd+p_reservation>2 then raise exception 'practice budget exhausted'; end if;
 update practice_sessions set pending_check=p_check_id,check_started_at=now(),check_spent_usd=check_spent_usd+p_reservation,last_frame=p_frame,frame_step_id=p_step_id,frame_expires_at=case when p_frame is not null then now()+interval '90 seconds' else null end where id=p_id;
 return s.data;
end $$;

create function public.expire_practice_frames() returns void language sql set search_path=public as $$
 update practice_sessions set last_frame=null,frame_step_id=null,frame_expires_at=null where frame_expires_at<=now();
$$;

create function public.charge_voice_expert(p_id uuid,p_request_id text,p_amount numeric) returns boolean language plpgsql set search_path=public as $$
declare v voice_sessions;
begin
 select * into v from voice_sessions where id=p_id for update;
 if not found or v.status not in ('starting','active') or v.expires_at<=now() then return false; end if;
 if p_amount<0.35 or length(p_request_id)>200 or exists(select 1 from voice_expert_charges where voice_session_id=p_id and request_id=p_request_id) then return false; end if;
 if v.spent_usd+v.expert_spent_usd+p_amount>v.budget_usd then return false; end if;
 insert into voice_expert_charges(voice_session_id,request_id,amount) values(p_id,p_request_id,p_amount);
 update voice_sessions set expert_spent_usd=expert_spent_usd+p_amount where id=p_id;
 return true;
end $$;
create function public.update_voice_usage(p_id uuid,p_spent numeric,p_status text default null) returns boolean language plpgsql set search_path=public as $$
declare v voice_sessions;
begin
 select * into v from voice_sessions where id=p_id for update;
 if not found or p_spent<0 then return false; end if;
 if p_status is null and (v.status not in ('starting','active') or v.expires_at<=now() or p_spent+v.expert_spent_usd>v.budget_usd) then return false; end if;
 if p_status is not null and p_status not in ('ended','failed') then return false; end if;
 update voice_sessions set spent_usd=p_spent,status=coalesce(p_status,status),ended_at=case when p_status is not null then now() else ended_at end where id=p_id;
 return true;
end $$;

-- Every mutating RPC is service-only. API authorization precedes these calls;
-- workers use a separate service credential that never enters a render sandbox.
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('job_json','create_tutorial','update_tutorial','register_upload','complete_upload','enqueue_job','control_job','claim_job','heartbeat_job','checkpoint_job','reserve_job_cost','settle_job_cost','commit_practice','begin_practice_check','charge_voice_expert','update_voice_usage','expire_practice_frames') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $$;
