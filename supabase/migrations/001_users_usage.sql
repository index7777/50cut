-- 50cut: users usage table + RLS policies
-- 執行方式:Supabase Dashboard → SQL Editor → 貼進來 → Run

-- ============================================================
-- 1. users_usage 表:追蹤每位使用者的用量
-- ============================================================
create table if not exists public.users_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  total_used int not null default 0,          -- 累計使用支數
  daily_used int not null default 0,          -- 今日已用
  bonus_remaining int not null default 5,     -- 註冊贈送剩餘
  last_reset_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users_usage is '使用者用量記錄。不儲存 email/影片/字幕。';

-- ============================================================
-- 2. 註冊時自動建立 usage row(trigger)
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users_usage (user_id, bonus_remaining)
  values (new.id, coalesce(current_setting('app.free_signup_bonus', true)::int, 5));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- 3. RLS:全表啟用
-- ============================================================
alter table public.users_usage enable row level security;

-- 只能讀自己的
drop policy if exists "usage_select_own" on public.users_usage;
create policy "usage_select_own"
  on public.users_usage for select
  using (auth.uid() = user_id);

-- 只能寫自己的(前端只做「讀」,寫由 API 服務端做,見下 note)
drop policy if exists "usage_update_own" on public.users_usage;
create policy "usage_update_own"
  on public.users_usage for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 前端不允許 insert / delete(避免濫用)
-- 沒有 insert / delete policy = 拒絕

-- ============================================================
-- 4. 每日重置 helper 函式(供 API server-side 呼叫)
-- ============================================================
create or replace function public.consume_usage(p_user_id uuid)
returns table(allowed boolean, reason text, bonus_remaining int, daily_used int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.users_usage%rowtype;
  v_daily_quota int := coalesce(current_setting('app.free_daily_quota', true)::int, 1);
begin
  -- 鎖 row
  select * into v_row from public.users_usage where user_id = p_user_id for update;

  if not found then
    return query select false, 'no_usage_row'::text, 0, 0;
    return;
  end if;

  -- 換日就重置
  if v_row.last_reset_date <> current_date then
    v_row.daily_used := 0;
    v_row.last_reset_date := current_date;
  end if;

  -- 先扣註冊贈送額度
  if v_row.bonus_remaining > 0 then
    update public.users_usage
      set bonus_remaining = v_row.bonus_remaining - 1,
          total_used = v_row.total_used + 1,
          daily_used = v_row.daily_used,
          last_reset_date = v_row.last_reset_date,
          updated_at = now()
      where user_id = p_user_id;
    return query select true, 'bonus'::text, v_row.bonus_remaining - 1, v_row.daily_used;
    return;
  end if;

  -- 再檢查每日額度
  if v_row.daily_used >= v_daily_quota then
    -- 只更新 last_reset_date(如果換日的話),不加用量
    update public.users_usage
      set daily_used = v_row.daily_used,
          last_reset_date = v_row.last_reset_date,
          updated_at = now()
      where user_id = p_user_id;
    return query select false, 'daily_limit'::text, v_row.bonus_remaining, v_row.daily_used;
    return;
  end if;

  update public.users_usage
    set daily_used = v_row.daily_used + 1,
        total_used = v_row.total_used + 1,
        last_reset_date = v_row.last_reset_date,
        updated_at = now()
    where user_id = p_user_id;
  return query select true, 'daily'::text, v_row.bonus_remaining, v_row.daily_used + 1;
end;
$$;

-- 只允許已登入使用者 (authenticated) 呼叫
revoke all on function public.consume_usage(uuid) from public;
grant execute on function public.consume_usage(uuid) to authenticated;

-- ============================================================
-- 5. 設定參數(對應 .env.local)
-- ============================================================
-- Supabase 目前不支援 alter database 設 GUC,所以 default 值寫在 function 內。
-- 如需改變 quota,直接改 function 內的 default,或改 .env.local + 重跑一次 SQL。

-- 完成
