-- Free-tier deployment: private uploads remain bounded by the global 50 MB limit.
-- Anonymous Supabase users still use authenticated roles and owner-specific RLS.
update storage.buckets set file_size_limit=50000000,public=false where id in ('captures','tutorial-assets');
alter table public.uploads alter column reserved_bytes set default 50000000;
-- Old unfinished signed tickets can now store at most the new bucket ceiling.
update public.uploads set reserved_bytes=50000000 where not completed;

-- Job RPCs deliberately run as their caller. The trusted service role needs the
-- queue's underlying privileges; browser roles receive none of these grants.
grant usage on schema pgmq to service_role;
grant all on all tables in schema pgmq to service_role;
grant usage,select on all sequences in schema pgmq to service_role;
grant execute on all functions in schema pgmq to service_role;

create or replace function public.register_upload(p_id uuid,p_owner_id uuid,p_tutorial_id uuid,p_revision int,p_asset jsonb,p_client_fingerprint text default null) returns void language plpgsql set search_path=public as $$
declare t tutorials; tutorial_count int; tutorial_bytes bigint; account_bytes bigint; project_bytes bigint; file_bytes bigint;
begin
 -- All account reservations share a small project allowance on the free plan.
 -- Reserve the full signed-ticket ceiling, not an untrusted browser file size.
 perform pg_advisory_xact_lock(hashtextextended('astratorial-free-capture-reservations',0));
 select * into t from tutorials where id=p_tutorial_id and owner_id=p_owner_id for update;
 if not found then raise exception 'not found'; end if;
 if (t.data->>'revision')::int<>p_revision then raise exception 'stale revision'; end if;
 if exists(select 1 from generation_jobs where tutorial_id=t.id and status in ('queued','running')) then raise exception 'active job'; end if;
 file_bytes:=(p_asset->>'size')::bigint;
 if file_bytes is null or file_bytes<=0 or file_bytes>50000000 then raise exception 'upload limit: choose files up to 50 MB. Trim the video or record a shorter clip'; end if;
 if p_asset->>'id' is distinct from p_id::text or not coalesce(starts_with(p_asset->>'path',p_owner_id::text||'/'||p_tutorial_id::text||'/r'||p_revision::text||'/'),false) then raise exception 'invalid upload'; end if;
 if p_asset->>'kind'='manual' and file_bytes+coalesce((select sum((asset->>'size')::bigint) from uploads where tutorial_id=t.id and asset->>'kind'='manual'),0)>10000000 then raise exception 'upload limit: PDF manuals together must fit within 10 MB'; end if;
 select count(*),coalesce(sum(reserved_bytes),0) into tutorial_count,tutorial_bytes from uploads where tutorial_id=t.id;
 select coalesce(sum(reserved_bytes),0) into account_bytes from uploads where owner_id=p_owner_id;
 select coalesce(sum(reserved_bytes),0) into project_bytes from uploads;
 if tutorial_count>=30 or tutorial_bytes+50000000>200000000 then raise exception 'upload limit: this tutorial has used its 200 MB capture allowance. Delete an unused tutorial or use shorter clips'; end if;
 if account_bytes+50000000>500000000 then raise exception 'upload limit: this account has used its 500 MB capture allowance. Delete an unused tutorial before adding more'; end if;
 -- Keep at least half of the project's included 1 GB available for scene assets.
 if project_bytes+50000000>500000000 then raise exception 'upload limit: the demo capture storage is full. Delete an unused tutorial before adding more'; end if;
 insert into uploads(id,owner_id,tutorial_id,revision,asset,reserved_bytes,client_fingerprint) values(p_id,p_owner_id,t.id,p_revision,p_asset,50000000,p_client_fingerprint);
end $$;

-- Analysis is allowed to infer the goal from a video-first, initially empty draft.
create or replace function public.checkpoint_job(p_job_id uuid,p_worker_id text,p_stage text,p_progress int,p_message text,p_checkpoint jsonb,p_tutorial_patch jsonb default '{}',p_status text default 'running',p_error text default null) returns jsonb language plpgsql set search_path=public,pgmq as $$
declare j public.generation_jobs; patch jsonb;
begin
 select * into j from public.generation_jobs where id=p_job_id and lease_owner=p_worker_id and lease_until>now() and status='running' for update;
 if not found then raise exception 'worker lease lost'; end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into patch from jsonb_each(p_tutorial_patch) where key in ('title','slug','description','category','goal','plan','scene','status','thumbnailUrl');
 update public.generation_jobs set stage=p_stage,progress=p_progress,message=p_message,checkpoint=p_checkpoint,status=p_status,error=p_error,updated_at=now() where id=j.id;
 update public.tutorials set data=data||patch||jsonb_build_object('updatedAt',now(),'job',public.job_json(j.id)),updated_at=now() where id=j.tutorial_id and (data->>'revision')::int=j.revision;
 if p_status<>'running' then
  update public.generation_jobs set lease_owner=null,lease_until=null where id=j.id;
  perform pgmq.archive('astratorial_jobs',j.queue_message_id);
 end if;
 return public.job_json(j.id);
end $$;
