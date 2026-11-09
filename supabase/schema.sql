-- aKta: Supabase schema for meeting text (titles, transcripts, summaries, notes).
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run.

create table if not exists public.akta_meetings (
    id text primary key,
    title text not null,
    created_at timestamptz,
    updated_at timestamptz,
    summary_status text,
    summary_markdown text,
    summary_result jsonb,
    summary_updated_at timestamptz,
    notes_markdown text,
    notes_updated_at timestamptz,
    source_device text,
    synced_at timestamptz not null default now()
);

create table if not exists public.akta_transcripts (
    id text primary key,
    meeting_id text not null references public.akta_meetings (id) on delete cascade,
    position integer not null,
    text text not null,
    "timestamp" text,
    audio_start_time double precision,
    audio_end_time double precision,
    duration double precision,
    speaker text
);

create index if not exists akta_transcripts_meeting_idx
    on public.akta_transcripts (meeting_id, position);

alter table public.akta_meetings enable row level security;
alter table public.akta_transcripts enable row level security;

-- The app signs in with a single shared Supabase Auth user; only signed-in
-- users can read or write. The anon key alone grants no access.
drop policy if exists akta_meetings_authenticated on public.akta_meetings;
create policy akta_meetings_authenticated on public.akta_meetings
    for all to authenticated using (true) with check (true);

drop policy if exists akta_transcripts_authenticated on public.akta_transcripts;
create policy akta_transcripts_authenticated on public.akta_transcripts
    for all to authenticated using (true) with check (true);

-- Replaces a meeting and all of its transcript segments in one transaction.
create or replace function public.akta_sync_meeting(p_meeting jsonb, p_transcripts jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    insert into public.akta_meetings as m (
        id, title, created_at, updated_at,
        summary_status, summary_markdown, summary_result, summary_updated_at,
        notes_markdown, notes_updated_at, source_device, synced_at
    )
    values (
        p_meeting->>'id',
        p_meeting->>'title',
        (p_meeting->>'created_at')::timestamptz,
        (p_meeting->>'updated_at')::timestamptz,
        p_meeting->>'summary_status',
        p_meeting->>'summary_markdown',
        p_meeting->'summary_result',
        (p_meeting->>'summary_updated_at')::timestamptz,
        p_meeting->>'notes_markdown',
        (p_meeting->>'notes_updated_at')::timestamptz,
        p_meeting->>'source_device',
        now()
    )
    on conflict (id) do update set
        title = excluded.title,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        summary_status = excluded.summary_status,
        summary_markdown = excluded.summary_markdown,
        summary_result = excluded.summary_result,
        summary_updated_at = excluded.summary_updated_at,
        notes_markdown = excluded.notes_markdown,
        notes_updated_at = excluded.notes_updated_at,
        source_device = excluded.source_device,
        synced_at = now();

    delete from public.akta_transcripts where meeting_id = p_meeting->>'id';

    insert into public.akta_transcripts (
        id, meeting_id, position, text, "timestamp",
        audio_start_time, audio_end_time, duration, speaker
    )
    select t.id, p_meeting->>'id', t.position, t.text, t."timestamp",
           t.audio_start_time, t.audio_end_time, t.duration, t.speaker
    from jsonb_to_recordset(coalesce(p_transcripts, '[]'::jsonb)) as t(
        id text, position integer, text text, "timestamp" text,
        audio_start_time double precision, audio_end_time double precision,
        duration double precision, speaker text
    );
end;
$$;

create or replace function public.akta_delete_meeting(p_id text)
returns void
language sql
security invoker
set search_path = public
as $$
    delete from public.akta_meetings where id = p_id;
$$;

revoke all on function public.akta_sync_meeting(jsonb, jsonb) from public, anon;
revoke all on function public.akta_delete_meeting(text) from public, anon;
grant execute on function public.akta_sync_meeting(jsonb, jsonb) to authenticated;
grant execute on function public.akta_delete_meeting(text) to authenticated;
