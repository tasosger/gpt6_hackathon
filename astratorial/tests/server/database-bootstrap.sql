-- Local PostgreSQL harness only: production uses Supabase Auth/Storage and pgmq.
create schema auth;
create schema storage;
create schema extensions;
create schema pgmq;
create role anon;
create role authenticated;
create role service_role bypassrls;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth,public to authenticated,anon,service_role;
grant execute on function auth.uid() to authenticated,anon,service_role;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
grant usage on schema storage to service_role;
grant select on storage.buckets to service_role;
create table pgmq.test_messages(msg_id bigserial primary key,message jsonb,vt timestamptz default now(),archived boolean default false);
create function pgmq.create(text) returns void language sql as $$select$$;
create function pgmq.send(text,jsonb) returns bigint language sql as $$insert into pgmq.test_messages(message) values($2) returning msg_id$$;
create function pgmq.read(text,integer,integer) returns table(msg_id bigint,message jsonb) language sql as $$
 update pgmq.test_messages set vt=now()+make_interval(secs=>$2) where test_messages.msg_id in (select q.msg_id from pgmq.test_messages q where not archived and vt<=now() order by q.msg_id limit $3) returning test_messages.msg_id,test_messages.message;
$$;
create function pgmq.archive(text,bigint) returns boolean language sql as $$update pgmq.test_messages set archived=true where msg_id=$2 returning true$$;
create function pgmq.set_vt(text,bigint,integer) returns boolean language sql as $$update pgmq.test_messages set vt=now()+make_interval(secs=>$3) where msg_id=$2 returning true$$;
