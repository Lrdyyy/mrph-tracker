create table if not exists public.order_updates (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  author uuid default auth.uid() references auth.users(id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists order_updates_order_idx on public.order_updates (order_id, created_at);
create index if not exists order_updates_recent_idx on public.order_updates (created_at desc);

alter table public.order_updates enable row level security;

drop policy if exists order_updates_read on public.order_updates;
create policy order_updates_read on public.order_updates
  for select to authenticated
  using (public.my_role() in ('viewer', 'editor', 'admin'));

drop policy if exists order_updates_insert on public.order_updates;
create policy order_updates_insert on public.order_updates
  for insert to authenticated
  with check (public.my_role() in ('editor', 'admin') and author = auth.uid());

drop policy if exists order_updates_delete on public.order_updates;
create policy order_updates_delete on public.order_updates
  for delete to authenticated
  using (public.my_role() = 'admin' or (public.my_role() = 'editor' and author = auth.uid()));

do $$
begin
  alter publication supabase_realtime add table public.order_updates;
exception when duplicate_object then null;
end $$;
