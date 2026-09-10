-- Keep obsolete workers from consuming jobs they cannot finish.
create or replace function public.claim_job(p_worker_id text,p_lease_seconds int default 180) returns jsonb language plpgsql set search_path=public,pgmq as $$
declare msg record; j public.generation_jobs; t public.tutorials;
begin
 -- Older workers lack the current preview renderer and remote heartbeat.
 if p_worker_id not like 'astratorial-v2-%' then return null; end if;
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
