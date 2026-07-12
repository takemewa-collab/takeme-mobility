-- Both mobile apps subscribe to postgres_changes on these tables; until now
-- the supabase_realtime publication was EMPTY, so no event ever fired —
-- riders saw no status/driver movement, drivers saw no trip updates.
-- (Applied to production 2026-07-12 via management API; kept here so fresh
-- environments get it from migrations.)
ALTER PUBLICATION supabase_realtime ADD TABLE public.rides;
ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_locations;
