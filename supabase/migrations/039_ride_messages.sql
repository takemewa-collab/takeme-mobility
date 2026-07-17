-- ═══════════════════════════════════════════════════════════════════════════
-- 039 — In-app ride messaging (privacy-protected contact channel).
-- Replaces raw tel: links between rider and driver. Participants of a ride
-- talk through this table; nobody's phone number is exposed.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ride_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('rider', 'driver')),
  sender_id UUID NOT NULL,   -- auth user id of the sender
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ride_messages_ride ON ride_messages (ride_id, created_at);

ALTER TABLE ride_messages ENABLE ROW LEVEL SECURITY;

-- A participant = the ride's rider, or the auth user behind its assigned driver.
CREATE POLICY ride_messages_select_participants ON ride_messages FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM rides r
    WHERE r.id = ride_messages.ride_id
      AND (
        r.rider_id = (SELECT app_user_id())
        OR EXISTS (
          SELECT 1 FROM drivers d
          WHERE d.id = r.assigned_driver_id
            AND d.auth_user_id = (SELECT app_user_id())
        )
      )
  ));

-- Sending is allowed only while the ride is active, only as yourself.
CREATE POLICY ride_messages_insert_participants ON ride_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = (SELECT app_user_id())
    AND EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id = ride_messages.ride_id
        AND r.status IN ('driver_assigned', 'driver_arriving', 'arrived', 'in_progress')
        AND (
          (sender_role = 'rider' AND r.rider_id = (SELECT app_user_id()))
          OR (sender_role = 'driver' AND EXISTS (
            SELECT 1 FROM drivers d
            WHERE d.id = r.assigned_driver_id
              AND d.auth_user_id = (SELECT app_user_id())
          ))
        )
    )
  );

-- Realtime delivery to both apps.
ALTER PUBLICATION supabase_realtime ADD TABLE ride_messages;
